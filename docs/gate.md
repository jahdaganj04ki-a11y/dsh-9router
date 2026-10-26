# The free-tier gate: what is checked, and how that is known

This file is the evidence trail behind `lib/fingerprint.js` and `lib/transport.js`. It exists so that
the next person who sees a `403 FreeTierError` can tell "upstream changed a gate" apart from "this
plugin is broken", and can find which one moved without re-deriving any of it.

Every claim below is attributed. Where two sources disagreed, the disagreement is recorded rather
than silently resolved, together with what decided it.

---

## Why the gate exists

OpenCode's free lane is a promotional offer: vendors let OpenCode serve their models at zero cost for
a limited window while feedback is collected. Serving that offer to any client that can spell the URL
would make it unbounded, so upstream restricts it to requests that look like they came from the
official client. Third-party callers get:

```
403 {"type":"error","error":{"type":"FreeTierError",
     "message":"OpenCode's free tier can only be used from within OpenCode"}}
```

That is the error the user of this plugin was seeing in DSH, in pi-ai, in LiteLLM and in
claude-code-router. It is not a credential problem, not a quota problem and not a region problem.

---

## The six gates

| # | Gate | Value the plugin sends | Failure when wrong |
|---|---|---|---|
| 1 | Path | `POST https://opencode.ai/inference/v1/{chat/completions,responses,messages}` | `403 FreeTierError` |
| 2 | User-Agent | `opencode/latest/2.0.26/cli` | `403 FreeTierError` |
| 3 | Session headers | four headers, one value | `403 FreeTierError` |
| 4 | Session id shape | minted descending id, small counter, current time | `403 FreeTierError` |
| 5 | Body shape | `stream:true` + verbatim `read`/`shell` + `<env>` marker + no `tool_choice:"none"` | `429 FreeUsageLimitError` |
| 6 | TLS ClientHello | Bun/BoringSSL cipher list | `429 FreeUsageLimitError` |

Note the split in the last column: the **identity** gates answer 403, the **body and transport** gates
answer 429. That distinction is load-bearing for diagnostics, because 429 also means "quota
exhausted" — the same status carries two completely different problems, and telling them apart is
most of the value in `describeFailure()`.

### Gate 1 — path

The free lane moved from `/zen/v1` to `/inference/v1` with OpenCode v2. `/zen/v1/chat/completions`
returns `403 FreeTierError` even when every other property of the request is byte-perfect. Both
`/inference/v1/models` and `/zen/v1/models` still return `200` with the same listing, so the listing
endpoint cannot be used to detect which lane is live — only a completion request can.

`endpointFor()` in `lib/adapter.js` appends the lane suffix to a bare origin, honours a pinned
versioned root (`.../zen/v1` for a paid key), and uses a fully pinned lane path verbatim.

### Gate 2 — User-Agent

OpenCode v2 sends `opencode/<channel>/<version>/<client>`, built by `opencode/${channel}/${version}/${name}`.
The gate matches the **whole string** and requires major ≥ 2:

- `opencode/1.18.31` (the v1 form) → 403
- `opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` → 403
- `opencode/latest/2.0.26/cli` → 200
- any suffix appended to a valid v2 string → 403

Separately, a User-Agent **containing** `deepseek-harness` is refused case-insensitively and at any
position. `dsh/…` is accepted.

This is why the plugin does not send the harness's `attributionHeaders()`. That function renders
`deepseek-harness/<version> (+<url>)`, which fails both conditions at once. Existing harness-side
OpenCode integrations that spread `...attributionHeaders()` into their request headers fail here and
nowhere else — the single most common cause of a 403 in this integration.

Authoritative confirmation of the header set OpenCode itself sends:
`anomalyco/opencode`, `packages/core/src/session/model-request.ts`.

### Gate 3 — session headers

From OpenCode's own request builder:

```
"x-opencode-session-id": session.id
"x-opencode-parent-session-id": session.parentID   // only when there is a parent
"x-session-affinity": affinity
"X-Session-Id": affinity
"x-parent-session-id": session.parentID            // only when there is a parent
"User-Agent": App.useragent(app)
"x-opencode-project": session.projectID
"x-opencode-session": affinity
"x-opencode-client": app.name
```

and `affinity = session.parentID ?? session.fork?.sessionID ?? session.id`
(`packages/core/src/session/affinity.ts`) — which is why, for a top-level session, all four of
`x-opencode-session`, `x-opencode-session-id`, `x-session-affinity` and `x-session-id` carry the same
value.

Ablation: dropping any one of the four → 403. Adding the v1-only `x-opencode-request` → 403.
`x-opencode-client` and `x-opencode-project` may be omitted, but are sent anyway for fidelity.

### Gate 4 — session id shape

OpenCode 2.0 session ids are **descending** identifiers:

```
value  = ~(BigInt(timeMs) * 0x1000n + BigInt(counter))     // counter restarts at 1 each millisecond
id     = "ses_" + hex(value & 0xffffffffffff) + 14 random base62 chars
```

Three separate properties are checked:

1. **Shape** — `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`. UUIDs and arbitrary hex are refused.
2. **Counter** — upstream decodes the 12-bit counter out of the prefix. Observed: 0–16 pass, ≥ 100
   refused. The real CLI resets it each millisecond, so `mintSessionId()` keeps it in 1..16 even under
   a same-millisecond burst.
3. **Timestamp** — the decoded time must be current, not future and not older than the free window.

Property 3 has a subtlety that looks like a bug and is not, and it is worth writing down because the
obvious "fix" breaks the gate. `timeMs * 0x1000` needs about 53 bits at current dates, but the field
holds 48. Masking truncates it, so decoding yields `timeMs mod 2^36` and the field wraps every
2^36 ms ≈ 2.18 years. Upstream compares in that same wrapped space. Consequences:

- An id minted from `Date.now()` passes.
- An id derived from a digest of a conversation key — *of identical shape and identical counter* —
  is refused almost every time, because its decoded value is uniform over 2^36 ms and lands outside
  the window. Measured: `Date.now()`-minted 10/10, digest-derived 1/10.
- Widening the field is not available: the id is 12 hex characters on the wire, and the wrap is
  inherent to it.

`lib/fingerprint.js` documents this at `descendingTimeHex()`, and `test/wire.test.mjs` plus
`test/gate-server.mjs` both compare in the wrapped space so a future maintainer cannot "correct" it
into a failing state.

Quota note: free-tier quota is accounted **per session**. Minting a fresh id per request burns it and
surfaces as `429 FreeUsageLimitError` with growing reset delays. `SessionStore` therefore keeps one
stable session per conversation, like the CLI, and relays a genuine gate-valid id untouched so a real
client's prompt-cache affinity survives.

### Gate 5 — body shape

Four independent requirements:

**`stream: true`.** A non-streaming request to a free model is refused with 403. The adapter always
streams upstream regardless of what the caller asked for.

**Verbatim `read` and `shell`.** Both names must be declared, and upstream compares each one's
description string exactly and its parameter schema structurally. A stubbed description, a reworded
one, or `properties: {}` → 403/429. The definitions in `FINGERPRINT_TOOL_DEFINITIONS` are copied from
the v2.0.26 CLI and are load-bearing text, not documentation.

The v1 gate was laxer — four names (`bash`/`glob`/`grep`/`read`), each needing only one property — and
that looseness is exactly what makes a v1-era implementation fail today.

Collision handling matters because the harness has its own file and shell tools:

- A caller tool named `read`/`shell` whose **arguments can carry** the official definition has the
  official description and schema adopted **in place**. The caller keeps its own name, so there is no
  alias to restore and no placeholder to explain. This is the common case, not an edge: OpenCode
  composes `shell`'s description from `process.platform`, so the same tool on Windows reports
  "Commands run on Windows using pwsh." where the captured Linux build says "Commands run on Linux
  using bash." — a two-word difference an exact string compare rejects.
- A caller tool whose arguments **cannot** carry it moves to `read_client` / `shell_client2` / …, the
  official definition is appended under the real name, and the response side restores the caller's
  spelling in chat deltas, chat messages, Responses items and events, and Anthropic content blocks.
  History is rewritten in the same pass, or a past call would name a tool that is no longer declared.
- Case variants (`Read`) and foreign names are left verbatim; upstream accepts them alongside.
- Duplicate declarations of one name are refused, so the first wins.

Because the model *does* call injected placeholders when nothing tells it otherwise (measured: a
`read` call in response to "what files are in /etc?"), a system-prompt note is appended. Its wording
is deliberate: "these tools are not available" made the model also refuse the caller's own read/bash
tools, while "placeholders … use the other tools you have been given instead" left those working.

**The `<env>` marker.** The CLI's environment block must be present in the system prompt. It is
appended to the caller's own prompt rather than replacing it — the gate reads text only, so a foreign
prompt plus this exact block passes. It covers all three shapes: Responses `instructions`, chat
`messages[]` system, and Anthropic top-level `system`.

Critically, the marker gate is **independent of the tool gate**: a request missing *either* half is
answered `429 FreeUsageLimitError` regardless of headers, UA or session shape; both halves together
pass. An earlier revision of this plugin applied the marker only inside the tool branch, so switching
`fingerprint.tools` off silently dropped the marker with it and turned a working route into a 429. The
marker now runs outside that branch, and `test/fingerprint.test.mjs` asserts it.

**`tool_choice`.** `"none"` is refused with 403 outright and is never sent. The Responses lane keeps
its explicit `auto` default; the chat lane sends no `tool_choice` at all. Suppressing an injected
placeholder therefore has to happen in the prompt note, not through `tool_choice`.

### Gate 6 — TLS ClientHello

Measured 2026-10-26 on one process, one egress IP, three transports: `node fetch`, `node https` and
`node http2` all returned `429 FreeUsageLimitError`; Bun's BoringSSL `fetch` returned `200`. Same
body, same headers throughout. JA4's cipher hash identifies the list (`5b57614c22b0` for Bun), and
only that hash is compared — reordering the same list still passes, and no GREASE is sent.

The accepted list, in the order Bun sends it:

```
TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:
ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:
ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:
ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:
ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES128-SHA:
ECDHE-ECDSA-AES256-SHA:ECDHE-RSA-AES256-SHA:
AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA
```

**Node can produce this natively.** `tls.connect({ ciphers })` accepts TLS 1.3 suite names alongside
the OpenSSL ones and emits them verbatim, in order, with no GREASE inserted. This package proves it
rather than asserting it: `test/transport.test.mjs` stands up a bare TCP server, reads the raw
ClientHello record off the socket, parses `cipher_suites`, and compares field by field — 17 suites,
exact order, zero GREASE. The companion test asserts Node's *default* list differs, so the first test
cannot pass vacuously.

That is the reason this plugin has no native dependency at all. A DSH Desktop plugin installs into an
Electron-bundled Node on Windows x64; a Rust-backed TLS client means a matching
`@wreq-js/binding-win32-x64-msvc` has to resolve, which is the most likely thing to fail in that
install path. `wreq-js` is therefore not declared as a dependency — not even an optional one, because
an optional dependency is still resolved and downloaded during `dsh plugin add`. It is an opt-in
transport mode (`transport.mode: wreq`) that a deployment installs into its own profile, useful when
it needs the rest of the browser fingerprint (extensions, ALPN ordering, curve list) too. `auto` and
`impersonate` never touch it, and an explicitly requested `wreq` mode fails with a message naming the
missing package rather than degrading silently.

`wreq-js` 3.2.0 also differs from what earlier integrations assumed, in two ways worth recording:
`createSession()` is asynchronous and returns a `Promise<Session>` (using it un-awaited yields an
object with no `fetch`, a silent failure), and its rustls backend refuses the TLS 1.3 suite names in
`cipherList` with `NO_CIPHER_MATCH` — only the TLS 1.2-and-below half is configurable there.
`tls12CipherSubset()` strips the three TLS 1.3 names for that path, and the transport validates that
the created session really has a `fetch` before selecting the mode.

---

## Lane-specific rejections beyond the gate

These are not gates but they fail requests just as hard, and the adapter rewrites all of them:

| Sent by a generic client | Free lane's answer | What the adapter does |
|---|---|---|
| `role: "developer"` | `400 [1214] Incorrect role information` | folds developer messages into `system`. The harness emits them for tool updates, so this is reached in ordinary agent turns. |
| `max_completion_tokens` | `"Endpoint is unavailable"` | sends the cap as `max_tokens` (chat), `max_output_tokens` (Responses), `max_tokens` required (Messages) |
| `reasoning_effort` outside `none\|minimal\|low\|medium\|high\|xhigh\|max` | `400 [1210] Invalid option` | converges onto the model's declared set |
| `reasoning_effort: "auto"` | `400 [1210] Invalid option` | drops the field — omitting it *is* adaptive |
| `reasoning.effort: "auto"` on Responses | `unknown variant 'auto'` | same |
| assistant history with empty `reasoning_content` | `400 missing_required_parameter` | injects a non-empty placeholder; the harness strips thinking before it reaches a client, so the echo can never come from the caller |
| prior-turn Responses `reasoning` items | `400 reasoning 'encrypted_content' was not issued to this caller` | drops the whole item: under `store:false`, omitting only the encrypted content makes the referenced item "not found or was deleted" |
| image input | `503` (intermittent) | `vision: auto` declares image only where the catalog says the model accepts it; `vision: off` lets the harness substitute its own placeholder |
| `store`, `metadata`, `prompt_cache_key`, `safety_identifier`, `service_tier` | rejected or ignored | stripped on the chat lane |

Per-model lane routing follows OpenCode's own families, so an id added upstream after this snapshot
still lands on the right protocol: `muse-spark*`, `gpt*`, `grok*` → Responses; `claude*`, `union*` →
Messages; everything else → chat completions. A curated snapshot entry always wins over the family
fallback.

---

## Where this came from

Primary, and the reason the values in this plugin are current rather than plausible:

- **`anomalyco/opencode`** — the official client. `packages/ai/src/providers/opencode.ts` gives the
  live provider endpoint (`https://opencode.ai/inference/systemone/v1` for OpenCode's own SystemOne
  protocol) and the `TypeSafe-Danger-Zone-Images: true` image opt-in;
  `packages/core/src/session/model-request.ts` gives the authoritative header set;
  `packages/core/src/session/affinity.ts` gives the affinity rule.
- **`decolua/9router`** — `open-sse/executors/opencode.js`, `open-sse/utils/opencodeFingerprint.js`
  and `open-sse/services/opencodeTlsClient.js`, with live probes dated 2026-10-26. This is the source
  of the v2 fingerprint, the verbatim tool definitions, the session-minting arithmetic and the TLS
  measurement, and it is the project this repository is named after.

Corroborating, and useful for the disagreement record:

- **`Ebony-Vinyl/dsh-our-free-model`**, `docs/free-lane-wire.md` — a TLS man-in-the-middle capture of
  the official client plus byte-for-byte single-variable replay, dated 2026-10-14 (v1) and 2026-10-16
  (v2). Source of the `deepseek-harness`-in-UA rejection and of the v1→v2 change table.
- **`TheHiddenDeveloper/zen-proxy`** — independent re-verification dated 2026-10-15, and the source
  for the lane-specific rejections table.
- **`ZhiAo1120/pi-opencode-zen`**, **`Feng-H/pi-opencode-zen`** — pi-ai provider extensions; the
  former documents the same session-id counter constraint, the latter records the v1→v2 closure.

Resolved disagreement — **`/zen/v1` vs `/inference/v1`**: sources from 2026-08 through 2026-09 place
the free lane on `/zen/v1`; the 2026-10-14 capture and the 2026-10-15/10-26 probes place it on
`/inference/v1` and report `/zen/v1` refusing every free completion. The later, directly measured
evidence wins, and `DEFAULT_MODELS_URLS` lists both for the *listing* only, since both still answer
that. A deployment that disagrees can pin `baseURL`.

Resolved disagreement — **missing tools: 403 or 429?** The 2026-10-14 capture reports `403
FreeTierError` for a missing tool fingerprint; the 2026-10-26 probe reports `429
FreeUsageLimitError` for a missing half of the body gate. The later measurement wins, and
`describeFailure()` explains both statuses without depending on which one arrives — which is the
robust posture given that upstream has already changed this once.

Superseded prior art — **`randomix777/dsh-opencode-zen`** (and its upstream `keman-ai` original) was
archived on 2026-06 with a deprecation notice stating the free tier had become OpenCode-only. It
targets `/zen/v1`, spreads `...attributionHeaders()` into its request headers, implements none of the
six gates, and declares model metadata against an older `LlmModelContext` shape that put
`maxOutputTokens` inside `context` rather than at `defaultMaxTokens`. Its quota tracker, persistent
catalog cache and retry ideas are worth keeping; its wire layer is what this plugin replaces.

---

## Re-verifying after an upstream change

```bash
node scripts/probe.mjs            # listing + one fully fingerprinted request
node scripts/probe.mjs --ablate   # remove one gate at a time; each should be refused
node scripts/probe.mjs --json     # machine-readable, for diffing over time
```

Read the result this way:

- **Complete request 200, every ablation refused** → nothing changed; the plugin is correct.
- **Complete request 403** → an identity gate moved. The ablation that unexpectedly returns 200 names
  the one that is no longer enforced; the ones still refused are fine. Compare
  `fingerprint.userAgent` and `FINGERPRINT_TOOL_DEFINITIONS` against a fresh capture of the current
  client, and override them in config rather than waiting for a release.
- **Complete request 429 while the body ablations behave** → the TLS gate. Confirm by re-running with
  `--transport native`: if that also 429s and `impersonate` 200s, the cipher list is the variable.
- **Complete request 429 and `--transport native` 200** → the shared anonymous quota is genuinely
  exhausted. Set `OPENCODE_API_KEY`.
