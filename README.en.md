# dsh-9router

**OpenCode's free models as a first-class provider in DSH Desktop (Windows) and DeepSeek Harness.**

No API key, no balance to top up, no separate proxy process. This plugin registers OpenCode's free
models as their own provider route inside the harness, so they are selectable in the model picker and
run a full agent loop — tool calls, reasoning, context window, output cap and vision included.

**[Deutsch](README.md)** · English

> [!IMPORTANT]
> **Why this needs to be a plugin at all.** Since September 2026 OpenCode's free lane serves only
> requests that look like an official OpenCode client session. Every other client — DeepSeek Harness,
> pi-ai, the OpenAI SDK, LiteLLM, claude-code-router — instead receives
> `403 FreeTierError: "OpenCode's free tier can only be used from within OpenCode"`.
> That is exactly the error other agents and harnesses hit. This plugin reproduces the expected client
> identity. All six gates are documented individually, with their evidence, in
> [`docs/gate.md`](docs/gate.md).

**Handoff:** [`docs/handoff.md`](docs/handoff.md) (German) walks through installation, verification,
diagnosis and maintenance on Windows step by step — including the paths, environment variables and menu
items DSH Desktop v0.12.1 dictates.

---

## Install on Windows

Requires **DSH Desktop v0.12.x** (Windows x64), which pins `@deepseek-ai/dsh@0.2.1-rc.2`. The plugin
is built against exactly that `LlmAdapter` contract and declares it as a peer dependency.

### A — Through the plugin page in DSH Desktop (recommended)

1. Start DSH Desktop.
2. Open **Plugins** in the sidebar (or **Settings → Plugins**).
3. Choose **Install** and give either:
   - the git address `github:<your-fork>/dsh-9router`, or
   - an **absolute** path to the unpacked folder, e.g. `C:\Users\<name>\Downloads\dsh-9router`.
     Relative paths are refused: the host has no working directory to resolve them against.
4. **Restart DSH Desktop once.** Without HMR the running composition stays as it is until restart.
5. The group **OpenCode Free** now appears in the model picker.

### B — From the command line

DSH Desktop keeps its profile at `%APPDATA%\dsh-desktop\harness\profiles\web`. Three things matter there,
or the command operates on a different tree or cannot find its tooling:

1. **Set `DSH_HOME`.** Without it the CLI falls back to `~\.dsh` — a different tree from the Desktop's. The
   Desktop sets the variable for its own processes; a shell you open yourself does not inherit it.
2. **pnpm must be on PATH.** Missing it ends the run with exit code 127 and `dsh: pnpm was not found`. The
   Desktop writes shims (`node.cmd`, `pnpm.cmd`) into `%APPDATA%\dsh-desktop\harness\.desktop-bin` as soon as
   it has run one package operation itself.
3. **The CLI version must match the runtime**, because the compatibility check reads the version of the CLI's
   own `dsh-app-boot`. DSH Desktop v0.12.1 pins `0.2.1-rc.2`.

Variant B1 — your own Node ≥ 20 and pnpm:

```bat
npm i -g @deepseek-ai/dsh@0.2.1-rc.2 pnpm

set "DSH_HOME=%APPDATA%\dsh-desktop\harness"
set "PATH=%DSH_HOME%\.desktop-bin;%PATH%"
cd /d "%DSH_HOME%\profiles\web"
dsh plugin --profile web add -w github:<your-fork>/dsh-9router
```

Variant B2 — no Node and no pnpm of your own, using what the Desktop ships. This is exactly what the app does
internally: the Electron executable as Node, running the CLI from `app.asar`.

```bat
set "DSH_HOME=%APPDATA%\dsh-desktop\harness"
set "ELECTRON_RUN_AS_NODE=1"
set "PATH=%DSH_HOME%\.desktop-bin;%PATH%"
cd /d "%DSH_HOME%\profiles\web"

"%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe" ^
  "%LOCALAPPDATA%\Programs\DSH Desktop\resources\app.asar\node_modules\@deepseek-ai\dsh\lib\bin.js" ^
  plugin --profile web add -w github:<your-fork>/dsh-9router
```

The installer lets you choose the directory; right-click the Start menu entry → **Open file location** for
the real one.

`-w` is **not** optional. The profile directory ships a `pnpm-workspace.yaml`, so pnpm treats it as a
workspace root; without the flag you get `ERR_PNPM_ADDING_TO_ROOT`.

Confirm it really entered the Loader tree (with the same variables as above):

```bat
dsh --profile web --dump-config | findstr opencode-free
```

> [!NOTE]
> On Windows the app's menu bar stays hidden until you press **Alt**. It holds the **Harness** menu with
> **Restart** (Ctrl+Shift+R) and **Show Harness Log** — both useful for path A, which needs no shell at all.

### No build step, no required native dependency

The plugin is plain ESM JavaScript and ships uncompiled. There is no `prepare` script, so installing
from a git source runs no build — no TypeScript or bundler toolchain is needed on your machine.

The TLS adaptation (see [gate 6](#the-six-gates)) uses Node's own facilities and is verified byte for
byte against a real ClientHello in `test/transport.test.mjs`.

`wreq-js` is therefore **deliberately not a dependency** — not even an optional one. An optional
dependency is still resolved and downloaded during `dsh plugin add`, and a per-platform native binding
(`@wreq-js/binding-win32-x64-msvc`) is exactly what is most likely to slow down or break a Windows
install into an Electron-bundled Node. The shipped transport needs no native module. If you want the
full browser fingerprint, add it to the profile yourself and switch the mode:

```bat
cd /d "%APPDATA%\dsh-desktop\harness\profiles\web"
pnpm add -w wreq-js
```

then set `transport.mode: wreq` in the plugin config. When the package is absent that mode fails with
a clear message instead of degrading silently; `auto` and `impersonate` always work.

---

## What the plugin gets right

The requirement was not only "the models are there" but "the models use the right settings and the
right setting options". Each one is answered through the `LlmAdapter` contracts the harness provides
for exactly this purpose, rather than guessed at:

| Setting | Source | What the harness does with it |
|---|---|---|
| **Endpoint** | Resolved per model. One base URL serves three protocols: `/inference/v1/chat/completions`, `/inference/v1/responses`, `/inference/v1/messages`. | A Responses model posted to `/chat/completions` does not degrade, it fails. The lane is therefore chosen per model, with a family fallback for ids newer than the snapshot. |
| **Context** | `resolveModel().context.contextWindow`, from the live catalog, else the snapshot. | Drives compaction and the `CONTEXT_WINDOW_EXCEEDED` check. |
| **Max output** | `resolveModel().defaultMaxTokens`, and per request the minimum of the caller's, the deployment's and the model's own cap. | The harness materializes the cap when a request names none. On the chat lane it travels as `max_tokens`, **never** `max_completion_tokens` — the lane answers that with "Endpoint is unavailable". |
| **Reasoning** | `resolveModel().reasoning.efforts` as an adapter-owned least-to-greatest list, plus `defaultEffort`. | The picker offers only declared levels. An undeclared one is converged onto the nearest valid level **before** any provider I/O, because the lane answers an unknown effort with `400 Invalid option`. `auto` is dropped rather than mapped — omitting the field *is* what adaptive means. A model that declares no reasoning never receives an effort field. |
| **Vision** | `inputModalities` per model; `vision: auto` follows the catalog. | When a route declares **no** image input the harness itself substitutes a deterministic placeholder for every image. That is the safe default, because the free lane has intermittently answered image input with 503. With `vision: on` the plugin encodes images through `ctx.attachments.readImageRequest()` and sends OpenCode's own opt-in header. |
| **Retry** | `providerRetryPolicy()` reports the codes `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`. | Only those codes are re-run by `dsh-llm-retry`. Reporting a 5xx as `SERVER` instead of a bespoke code is therefore a functional detail, not a style choice. |
| **Token accounting** | Disjoint: `inputTokens` is the uncached portion only. | OpenAI-style `prompt_tokens` folds cache hits into themselves. Without subtracting them a cached conversation double-counts its input on every turn. |

On top of that, what the harness requires of any GUI-usable adapter: `listModels()` must actively
advertise the models, because **the picker requires catalog membership** for selection and
submission. An adapter that answers empty here is invisible however well its `stream()` works.

---

## Configuration

Zero configuration is the intended posture — the defaults fully describe the anonymous free lane.
Everything below is optional and belongs in `cordis.patch.yml` or the plugin entry's `config:` block.

```yaml
- insert:
    - id: opencode-free
      name: dsh-9router
      config:
        provider: opencode-free          # route name in the model picker
        displayName: OpenCode Free
        baseURL: https://opencode.ai     # deliberately the bare origin; the lane is appended per model
        apiKeyEnv: OPENCODE_API_KEY      # the same variable OpenCode itself uses
        maxTokens: 32768                 # deployment cap; a lower model cap wins
        defaultContextWindow: 262144
        vision: auto                     # auto | on | off
        catalog:
          enabled: true
          modelsUrl:
            - https://opencode.ai/inference/v1/models
            - https://opencode.ai/zen/v1/models
          devUrl: https://models.dev/api.json
          ttlMs: 3600000
          timeoutMs: 8000
          cachePath: ''                  # '' = <dsh home>/cache/opencode-free-catalog.json
        fingerprint:
          enabled: true
          userAgent: opencode/latest/2.0.26/cli
          client: cli
          project: global
          tools: true                    # inject read/shell verbatim
          envMarker: true                # append the <env> block to the system prompt
        transport:
          mode: auto                     # auto | impersonate | native | wreq
          cipherList: ''                 # '' = the verified list
          timeoutMs: 120000
        retryPolicy:
          mode: normal
          maxRetries: 5
```

The switches that matter:

- **`apiKeyEnv` empty, or the variable unset** → the anonymous free lane (`Bearer public`). That is
  the normal case, not an error. A set `OPENCODE_API_KEY` moves you onto a private quota; free model
  ids stay gated behind the free identity even then.
- **`transport.mode: native`** is a diagnostic, not an operating mode: it sends Node's default cipher
  list and the free lane answers it with 429.
- **`vision: off`** forces the harness's text projection for every model. That is the escape hatch if
  the lane starts answering image input with 503 again.
- **`fingerprint.enabled: false`** turns the plugin into an ordinary OpenAI-compatible client. That
  only works with a paid key; on the free lane it 403s immediately.

---

## The six gates

The free lane checks six independent things and a request must pass **all** of them. Each is sourced
and ablation-tested in [`docs/gate.md`](docs/gate.md).

| # | Gate | Implementation |
|---|---|---|
| 1 | **Path** — `/inference/v1`, not `/zen/v1` | `endpointFor()` in `lib/adapter.js`; a pinned path is honoured |
| 2 | **User-Agent** — `opencode/<channel>/<version>/<client>`, major ≥ 2, **whole-string match** | `OPENCODE_USER_AGENT`; no suffix, no attribution comment |
| 3 | **Session headers** — `x-opencode-session`, `x-opencode-session-id`, `x-session-affinity`, `x-session-id`, all four **equal**; the v1-only `x-opencode-request` must **not** be present | `fingerprintHeaders()` |
| 4 | **Session id shape** — `ses_` + 12 minted hex + 14 base62; the decoded counter must be small and the timestamp current | `mintSessionId()` / `SessionStore` |
| 5 | **Body shape** — `stream: true`, `read` **and** `shell` with verbatim descriptions and parameter schemas, the `<env>` marker in the system prompt, never `tool_choice: "none"` | `applyFingerprintTools()` |
| 6 | **TLS ClientHello** — the cipher list, identified by its JA4 hash | `lib/transport.js` |

Two of these deserve attention because they are counter-intuitive:

**Gate 4, the session id.** The 12-hex prefix is `~(ms · 0x1000 + counter)` masked to 48 bits.
`ms · 0x1000` needs about 53 bits at today's dates and the field holds 48, so the decoded time is
`ms mod 2^36` and the field wraps every ~2.18 years. Upstream compares in that same wrapped space.
That is why an id minted from `Date.now()` passes while a digest-derived id of *identical shape* is
refused almost every time: its decoded value is uniform over 2^36 ms and lands outside the window.
Anyone who reads this as a bug and "fixes" the field breaks the gate.

Also: free-tier quota is accounted **per session**. Minting a fresh id per request burns through it
and surfaces as `429 FreeUsageLimitError` with growing reset delays. `SessionStore` therefore keeps
exactly one stable session per conversation, like the real CLI, and relays a genuine gate-valid
OpenCode id untouched so its prompt-cache affinity survives.

**Gate 6, TLS.** Measured 2026-10-26 on one process, one egress IP, three transports: `node fetch`,
`node https` and `node http2` all returned 429; Bun's BoringSSL `fetch` returned 200 — with identical
body and headers. JA4 identifies the list by its cipher hash (`5b57614c22b0`) and **only** that hash is
compared; reordering the same list still passes.

Node can produce exactly that list natively: `tls.connect({ ciphers })` accepts TLS 1.3 suite names
alongside the OpenSSL ones and emits them verbatim, in order, with **no** GREASE inserted.
`test/transport.test.mjs` proves it by parsing a real ClientHello off a real socket and comparing the
`cipher_suites` field entry by entry. The impersonation therefore needs no native module — which
matters for a DSH Desktop plugin, because a binary dependency is the most likely thing to fail when
installing into an Electron-bundled Node on Windows.

---

## Diagnosis: which gate is stuck?

When the free models stop working after an OpenCode release, the probe script tells you **which** of
the six checks moved, instead of just reporting "403":

```bat
cd /d "%APPDATA%\dsh-desktop\harness\profiles\web\node_modules\dsh-9router"
node scripts\probe.mjs
node scripts\probe.mjs --ablate
node scripts\probe.mjs --model cat-jam-free
node scripts\probe.mjs --json
```

`node` there is either an installation of your own or — the Desktop ships no standalone Node — the shim the
app writes itself:

```bat
"%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd" scripts\probe.mjs
```

The script imports nothing but Node builtins, so it needs no `node_modules`: it runs from the installed copy
with nothing extra to install.

The default run fetches the model listing and makes **one** complete request. `--ablate` then removes
one gate at a time and expects a refusal — a gate that answers 200 there is not currently enforced
upstream. Finally the script repeats the same request on Node's stock ciphers. What matters is the
**pair** of the complete request and that stock-cipher run:

| complete | stock ciphers | ablations | verdict |
|---|---|---|---|
| 200 | refused | all refused | **normal** — everything correct, the TLS gate is enforced |
| 200 | 200 | all refused | the TLS gate is not enforced from this network (often a TLS-terminating proxy) |
| 403 | – | – | an **identity** gate moved |
| 429 | 200 | – | the **cipher list** is the variable: re-measure `transport.cipherList` |
| 429 | 429 | one body ablation returns 200 | the **expected body** moved — that ablation names it |
| 429 | 429 | all refused, listing answers | the shared **quota** is exhausted — retry later or set `OPENCODE_API_KEY` |

The last row is a diagnosis of exclusion, for a reason: this lane answers an exhausted quota and a refused
body with the same 429. Only the fact that a quota refusal does not depend on the request separates them —
every ablation is refused as well, the non-quota-gated `/models` listing still answers, and the same request
from another network or with a key succeeds.

> [!NOTE]
> The script talks to the real free lane. Each successful request draws on the shared anonymous quota,
> which is rate-limited by source. Most ablated requests are refused before they reach a model and so
> cost nothing. Run it deliberately, not in a loop.

The adapter's error messages are deliberately long and name the likely cause: a `403 FreeTierError`
points at the identity gates, while a `429 FreeUsageLimitError` distinguishes an exhausted quota from
a body or TLS refusal — because the lane answers both with 429.

---

## Models

The list is **not** hardcoded. OpenCode describes the free models as time-limited, so any fixed list is
guaranteed to go stale. `lib/discovery.js` therefore intersects two sources:

- **OpenCode's `/models`** says which ids exist — and almost nothing else.
- **`models.dev`** publishes per-model cost and capacity. A zero cost is the only machine-readable
  statement that a model is on the free offer; OpenCode's own listing does not make it.

The catalog is the intersection: an id both sources know, with zero cost. A retired model therefore
never reaches the picker, and a paid model is never advertised as free. The bundled snapshot in
`lib/catalog.js` then supplies the capacities, modalities and reasoning levels the listing omits, and
acts as the fallback when both sources are unreachable — an offline machine still sees a list instead
of nothing.

Current snapshot (excerpt, ordered by context):

| Model | Lane | Context | Max output | Vision | Reasoning |
|---|---|---|---|---|---|
| `muse-spark-1.3-contributor-free` | responses | 1,048,576 | 131,072 | yes | low…xhigh |
| `space-bunny-free` | chat | 1,048,576 | 524,288 | yes | low/high/max |
| `nemotron-3-ultra-free` | chat | 1,000,000 | 128,000 | – | low/high/max |
| `longcat-2.5-preview-free` | chat | 1,000,000 | 131,072 | yes | low/high/max |
| `nemotron-3.5-lightning-free` | chat | 262,144 | 262,144 | – | low/high/max |
| `union-alpha` | messages | 262,144 | 131,072 | yes | – |
| `north-mini-code-free` | chat | 256,000 | 64,000 | – | low/high/max |
| `big-pickle` | chat | 200,000 | 32,000 | – | low/high/max |
| `mimo-v2.6-flash-free` | chat | 200,000 | 32,000 | – | none…max |
| `deepseek-v4.1-flash-free` | chat | 200,000 | 128,000 | – | low/high/max |

`jev-1.13-free` is on the lane but is deliberately **not** offered: it is a structured-decision
endpoint that answers a picker selection, not an agent turn.

---

## Why no `attributionHeaders()`

The harness requires every provider request from an adapter to carry `attributionHeaders()`. This
adapter deliberately does not send it, and that is a real trade-off rather than an oversight:

`attributionHeaders()` renders the product identity as
`deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)`. The free lane rejects
a User-Agent **containing** `deepseek-harness` — case-insensitively, at any position — and additionally
requires the whole string to match OpenCode's v2 form. Attribution on this lane is a guaranteed
`403 FreeTierError`. Incidentally, this is where existing harness-side OpenCode integrations fail: they
spread `...attributionHeaders()` into their request headers.

Every request on this route therefore carries OpenCode's own User-Agent, keyed or not. A deployment
that needs the harness to identify itself to a provider should route that provider through
`@deepseek-ai/dsh-llm-pi-ai`, which sends attribution normally, and keep this plugin for the free lane
only.

---

## Tests

```bash
npm test
```

85 tests, all offline and deterministic. Four groups carry the weight:

- **`test/transport.test.mjs`** parses a real ClientHello off a real socket and compares the cipher
  list field by field — including a companion assertion that Node's default list *differs*, so the
  first test cannot pass vacuously.
- **`test/gate-server.mjs`** is a local stand-in for the free lane that enforces **every** gate and
  refuses with the same status codes and error types upstream uses.
- **`test/adapter-gate.test.mjs`** drives real agent turns through the real adapter against that
  stand-in, across all three lanes. A pass here is evidence rather than intent: remove any single
  property from the plugin and a test fails.
- **`test/integration.test.mjs`** mounts the plugin into a real Cordis context beside the real
  `@deepseek-ai/dsh-llm` service and drives a request through `ctx.llm.stream()`. That catches
  contract drift: `LlmAdapter` is an abstract class in a peer package, `registerAdapter` validates the
  route set, and `prepareCall` rejects a reasoning effort the model does not declare — none of which an
  adapter unit test can see.

---

## Limits

Stated plainly so nobody has to go looking:

- **The gates are upstream's and they move.** They have already moved twice (v1 → v2 on 2026-10-14;
  the TLS gate confirmed 2026-10-26). `scripts/probe.mjs --ablate` exists to localize a change, and
  `fingerprint.userAgent`, `fingerprint.definitions` and `transport.cipherList` are configurable so a
  deployment can respond without waiting for a release.
- **The anonymous quota is shared and rate-limited by source.** A 429 is an expected operating state
  here, not a defect. Your own `OPENCODE_API_KEY` fixes it.
- **Image input on the free lane has intermittently returned 503.** Hence `vision: auto` as the
  default and the harness's text projection as the safe path.
- **A paid key does not lift gates 1–6 for free model ids.** Upstream gates those behind the attested
  free-tier identity even on the keyed lane.
- **Legal and terms of service.** Reproducing a client identity may conflict with the provider's terms
  of use. Assess that yourself before relying on this in production. This plugin is MIT licensed and
  comes with no warranty of any kind.

---

## License

MIT — see [LICENSE](LICENSE).

This plugin is an independent community project. It is not affiliated with, authorized by, or endorsed
by OpenCode, DeepSeek or Dataelem.
