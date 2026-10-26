/**
 * The OpenCode v2 free-tier client fingerprint.
 *
 * OpenCode's free lane answers any request that does not look like it came from
 * the official client with `403 FreeTierError: "OpenCode's free tier can only be
 * used from within OpenCode"`. That is the error every other agent, harness and
 * proxy sees, and it is why the free models appear to be OpenCode-exclusive.
 *
 * The gate is not one check but five independent ones, and a request must pass
 * all of them. Each is mirrored here from a live probe of the official
 * `opencode-ai@1.19.x` / OpenCode v2.0.26 client (see docs/gate.md for the
 * evidence trail and the per-item ablation results):
 *
 *  1. **Path** — the free lane moved from `/zen/v1` to `/inference/v1`. The old
 *     path 403s even when everything else is byte-perfect.
 *  2. **User-Agent** — `opencode/<channel>/<version>/<client>` with major >= 2,
 *     matched as a whole string. The v1 form `opencode/1.18.31` 403s, and so
 *     does any suffix: attribution comments such as the harness's own
 *     `deepseek-harness/x.y.z (+url)` are rejected, and a UA merely *containing*
 *     `deepseek-harness` is rejected regardless of position or case.
 *  3. **Session headers** — four headers carrying one value:
 *     `x-opencode-session`, `x-opencode-session-id`, `x-session-affinity` and
 *     `x-session-id`. Dropping any one of them 403s. The v1-only
 *     `x-opencode-request` header must NOT be sent — its presence alone 403s.
 *  4. **Session id shape** — a minted OpenCode 2.0 descending id
 *     (`ses_` + 12 hex + 14 base62). Upstream decodes the hex: the embedded
 *     counter must be small (0–16 observed passing, >= 100 refused) and the
 *     embedded timestamp must be current — digest-derived or random ids of the
 *     right shape are refused because their decoded time lands outside the
 *     free-tier window.
 *  5. **Body shape** — `stream: true`, OpenCode's own `read` and `shell` tools
 *     declared with their descriptions and parameter schemas verbatim, the CLI's
 *     `<env>` marker present in the system prompt, and no `tool_choice: "none"`
 *     (which 403s on its own).
 *
 * A sixth gate lives below HTTP: the free lane keys on the TLS ClientHello
 * cipher list. That one is `transport.js`'s job, not this file's.
 *
 * @module dsh-9router/fingerprint
 */

import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

/**
 * OpenCode v2 User-Agent. The upstream gate matches the whole string and
 * requires major >= 2, so this value is not a template to decorate: no
 * attribution comment, no product suffix, no extra whitespace.
 */
export const OPENCODE_USER_AGENT = 'opencode/latest/2.0.26/cli'

/** Value of the `x-opencode-client` header the CLI sends. */
export const OPENCODE_CLIENT = 'cli'

/**
 * Anonymous credential the free lane accepts. A real Zen/Console key replaces
 * it and moves the request onto the keyed lane, which is not gated this way.
 */
export const FREE_TIER_KEY = 'public'

/** OpenCode 2.0 session id: `ses_` + 12 hex (minted) + 14 base62. */
export const SESSION_ID_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const SESSION_PREFIX_MASK = (1n << 48n) - 1n

/**
 * The counter field the gate decodes out of the session prefix. Live probes put
 * the accepted ceiling somewhere between 16 and 100; the real CLI resets it each
 * millisecond, so staying in 1..16 is both faithful and comfortably inside.
 */
const MAX_GATE_COUNTER = 16

/**
 * Tool names the free-tier gate looks for. Both must be present, and upstream
 * compares each one's description and parameter schema against the official
 * client's, so the definitions below are load-bearing text, not documentation.
 */
export const FINGERPRINT_TOOL_NAMES = ['read', 'shell']

/**
 * OpenCode's own `read` and `shell` definitions, verbatim from the v2.0.26 CLI.
 *
 * Do not reword, re-wrap or re-key these: the gate compares the description
 * string exactly and the parameters structurally. `shell`'s description is
 * composed from `process.platform` upstream — the CLI running on Windows says
 * "Commands run on Windows using pwsh." where this captured Linux build says
 * "Commands run on Linux using bash." — and the Linux wording is what the probe
 * confirmed the gate accepts, so it is the default here on every platform. Pass
 * `shellDescription` in the fingerprint config to send the Windows wording
 * instead if a future upstream build starts requiring it.
 */
export const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description:
      'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to read' },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'The line or directory entry to start reading from (1-based)'
        },
        limit: {
          type: 'integer',
          minimum: 0,
          description:
            'The maximum number of lines or directory entries to read (defaults to and capped at 2000)'
        }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  shell: {
    description:
      'Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command string to execute' },
        workdir: {
          type: 'string',
          description:
            'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.'
        },
        timeout: {
          type: 'integer',
          minimum: 0,
          description:
            'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.'
        },
        background: {
          type: 'boolean',
          description:
            "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion."
        }
      },
      required: ['command'],
      additionalProperties: false
    }
  }
}

// ---------------------------------------------------------------------------
// Session ids
// ---------------------------------------------------------------------------

let lastTimestamp = 0
let counter = 0

function randomBase62(length) {
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += BASE62[bytes[i] % 62]
  return out
}

/**
 * The 12-hex prefix of an OpenCode 2.0 descending id: the low 48 bits of
 * `~(timeMs * 0x1000 + counter)`, exactly what the CLI mints.
 *
 * One subtlety worth stating, because it looks like a bug and is not: at current
 * dates `timeMs * 0x1000` needs about 53 bits, so masking to 48 truncates it and
 * the field wraps every 2^36 ms (~2.18 years). Decoding a prefix therefore yields
 * `timeMs mod 2^36`, not `timeMs`. Upstream compares in that same wrapped space,
 * which is why minting from `Date.now()` passes while a digest-derived id of the
 * identical shape does not: its decoded value is uniform over 2^36 ms and lands
 * outside the window almost every time. Do not "fix" this by widening the field —
 * the id is 12 hex characters on the wire and the wrap is inherent to it.
 *
 * @param {number} timeMs - Milliseconds to embed. Must be current: upstream
 *   decodes this and refuses a time outside the free-tier window.
 * @param {number} counterValue - Per-millisecond counter, 1..{@link MAX_GATE_COUNTER}.
 * @returns {string} 12 lowercase hex characters.
 */
export function descendingTimeHex(timeMs, counterValue) {
  return (
    (~((BigInt(timeMs) * 0x1000n) + BigInt(counterValue)) & SESSION_PREFIX_MASK)
      .toString(16)
      .padStart(12, '0')
  )
}

/**
 * Mint a gate-valid OpenCode 2.0 session id.
 *
 * The counter resets whenever the millisecond changes, mirroring the CLI, which
 * keeps it inside the range the gate decodes as valid even under a burst of
 * requests.
 *
 * @param {number} [timestamp] - Milliseconds to embed; defaults to now.
 * @returns {string} A `ses_`-prefixed descending id.
 */
export function mintSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter = counter >= MAX_GATE_COUNTER ? 1 : counter + 1
  return `ses_${descendingTimeHex(timestamp, counter)}${randomBase62(14)}`
}

/**
 * Whether a string is a session id the free-tier gate accepts.
 *
 * Shape alone is not sufficient — upstream also decodes the embedded timestamp —
 * but shape is the cheap half, and an id that fails it is certain to fail.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isGateSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id.trim())
}

/**
 * One stable, gate-valid session id per conversation.
 *
 * Free-tier quota is accounted per session, so minting a fresh id on every
 * request burns through it and surfaces as `429 FreeUsageLimitError` with a
 * growing reset delay. The real CLI reuses one long-lived session per
 * conversation and gets both the quota semantics and prompt-cache affinity from
 * it; this store mirrors that, keyed by whatever identity the caller has.
 */
export class SessionStore {
  #sessions = new Map()
  #max
  #ttlMs
  #timer

  /**
   * @param {{ max?: number, ttlMs?: number }} [options]
   */
  constructor({ max = 1000, ttlMs = 6 * 60 * 60 * 1000 } = {}) {
    this.#max = max
    this.#ttlMs = ttlMs
    const timer = setInterval(() => this.#sweep(), Math.min(ttlMs, 5 * 60 * 1000))
    // Never hold a harness or test process open for a cache sweep.
    if (typeof timer.unref === 'function') timer.unref()
    this.#timer = timer
  }

  /**
   * Resolve the session id for one conversation identity.
   *
   * A genuine OpenCode id arriving from upstream is passed through untouched, so
   * relaying a real client keeps its affinity. Anything else — a harness session
   * id, a UUID, nothing at all — is minted once and then remembered under that
   * key.
   *
   * @param {unknown} key - Conversation identity; equal keys share one session.
   * @returns {string} A gate-valid session id.
   */
  resolve(key) {
    if (isGateSessionId(key)) return String(key).trim()

    const id = typeof key === 'string' && key.length > 0 ? key : 'anonymous'
    const existing = this.#sessions.get(id)
    if (existing !== undefined) {
      existing.lastUsed = Date.now()
      // Re-insert so the Map stays in use order and eviction drops the coldest.
      this.#sessions.delete(id)
      this.#sessions.set(id, existing)
      return existing.sessionId
    }

    // The embedded timestamp must be current at mint time, so this is not
    // derivable from a digest of the key: two conversations started an hour
    // apart must each carry their own fresh time.
    const sessionId = mintSessionId()
    if (this.#sessions.size >= this.#max) {
      const oldest = this.#sessions.keys().next().value
      if (oldest !== undefined) this.#sessions.delete(oldest)
    }
    this.#sessions.set(id, { sessionId, lastUsed: Date.now() })
    return sessionId
  }

  /** Number of remembered sessions. Exposed for diagnostics and tests. */
  get size() {
    return this.#sessions.size
  }

  /** Drop every remembered session and stop the sweep timer. */
  dispose() {
    this.#sessions.clear()
    clearInterval(this.#timer)
  }

  #sweep() {
    const now = Date.now()
    for (const [key, entry] of this.#sessions) {
      if (now - entry.lastUsed > this.#ttlMs) this.#sessions.delete(key)
    }
  }
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/**
 * Build the header set the official v2 client sends on a free-lane model request.
 *
 * All four session headers carry the same value — that is what the gate checks,
 * and dropping any one of them is a 403 on its own. The v1-only
 * `x-opencode-request` header is deliberately absent: sending it 403s.
 *
 * Note what is NOT here: the harness's own `attributionHeaders()` value. It
 * renders as `deepseek-harness/<version> (+<url>)`, which fails the whole-string
 * UA match and additionally trips the `deepseek-harness` substring rejection.
 * Sending it on this lane is the single most common reason a harness-side
 * OpenCode integration 403s, so this plugin never merges it into a free-lane
 * request. Attribution is preserved on the keyed lane, where the gate does not
 * apply.
 *
 * @param {object} input
 * @param {string} input.session - Gate-valid session id from {@link SessionStore}.
 * @param {boolean} [input.stream] - Whether the response is SSE.
 * @param {string} [input.userAgent] - Override; must still match the v2 shape.
 * @param {string} [input.client] - `x-opencode-client` value.
 * @param {string} [input.project] - `x-opencode-project` value.
 * @param {string} [input.apiKey] - Real key; falls back to `Bearer public`.
 * @param {Record<string, string>} [input.extra] - Additional headers, e.g. the image opt-in.
 * @param {boolean} [input.anthropic] - Add `anthropic-version` for the messages lane.
 * @returns {Record<string, string>} Lowercased header names to values.
 */
export function fingerprintHeaders({
  session,
  stream = true,
  userAgent = OPENCODE_USER_AGENT,
  client = OPENCODE_CLIENT,
  project = 'global',
  apiKey,
  extra,
  anthropic = false
}) {
  /** @type {Record<string, string>} */
  const headers = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : '*/*',
    'user-agent': userAgent,
    authorization: `Bearer ${apiKey !== undefined && apiKey.length > 0 ? apiKey : FREE_TIER_KEY}`,
    'x-opencode-client': client,
    'x-opencode-session': session,
    'x-opencode-session-id': session,
    'x-session-affinity': session,
    'x-session-id': session,
    'x-opencode-project': project
  }
  if (anthropic) headers['anthropic-version'] = '2023-06-01'
  if (extra !== undefined) {
    for (const [name, value] of Object.entries(extra)) headers[name.toLowerCase()] = value
  }
  return headers
}

/**
 * Whether a User-Agent still satisfies the v2 gate.
 *
 * Used to decide if an incoming UA may be relayed verbatim (keeping a genuine
 * client's cache affinity) or must be replaced with our own.
 *
 * @param {unknown} ua
 * @returns {boolean}
 */
export function isV2UserAgent(ua) {
  const match = String(ua ?? '').match(/^opencode\/[a-z0-9-]+\/(\d+)\.\d+\.\d+\/[a-z0-9-]+$/i)
  return match !== null && Number.parseInt(match[1], 10) >= 2
}

// ---------------------------------------------------------------------------
// Body shape: tools
// ---------------------------------------------------------------------------

/**
 * Read a tool name from either the flat Responses shape (`{name}`) or the chat
 * shape (`{function:{name}}`).
 *
 * @param {unknown} tool
 * @returns {string}
 */
function toolNameOf(tool) {
  if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) return ''
  const flat = /** @type {{ name?: unknown }} */ (tool)
  if (typeof flat.name === 'string' && flat.name.trim().length > 0) return flat.name.trim()
  const fn = /** @type {{ function?: unknown }} */ (tool).function
  if (fn !== null && typeof fn === 'object' && !Array.isArray(fn)) {
    const name = /** @type {{ name?: unknown }} */ (fn).name
    if (typeof name === 'string') return name.trim()
  }
  return ''
}

function chatFunctionOf(tool) {
  const fn = tool?.function
  return fn !== null && typeof fn === 'object' && !Array.isArray(fn) ? fn : null
}

/** The fingerprint name when `name` is exactly one; `''` otherwise. */
export function fingerprintToolKey(name) {
  const trimmed = String(name ?? '').trim()
  return FINGERPRINT_TOOL_NAMES.includes(trimmed) ? trimmed : ''
}

function definitionsFor(options) {
  const override = options?.definitions
  return override ?? FINGERPRINT_TOOL_DEFINITIONS
}

/** Whether `tool` already carries the exact official definition for `key`. */
function isFingerprintDefinition(tool, key, definitions) {
  const def = tool && (chatFunctionOf(tool) || tool)
  const want = definitions[key]
  if (want === undefined || def === undefined || def === null) return false
  return (
    def.description === want.description &&
    JSON.stringify(def.parameters) === JSON.stringify(want.parameters)
  )
}

/**
 * Whether `tool` already speaks the official parameter names for `key`, so the
 * official definition can replace its own without hiding or inventing an
 * argument the caller's handler expects.
 *
 * This is the common case rather than an edge: the harness's own file and shell
 * tools do the same jobs under the same names with slightly different wording,
 * and OpenCode itself varies `shell`'s description by platform. Adopting the
 * official definition in place keeps the caller's name — so there is no alias to
 * restore and no placeholder to explain to the model.
 */
function canNormalizeInPlace(tool, key, definitions) {
  const def = tool && (chatFunctionOf(tool) || tool)
  const props = def?.parameters?.properties
  if (props === null || typeof props !== 'object' || Array.isArray(props)) return false
  const want = definitions[key]
  const wanted = Object.keys(want.parameters.properties ?? {})
  const declared = Object.keys(props)
  if (declared.some((name) => !wanted.includes(name))) return false
  return want.parameters.required.every((name) => declared.includes(name))
}

function withFingerprintDefinition(tool, key, definitions) {
  const { description, parameters } = definitions[key]
  const fn = chatFunctionOf(tool)
  return fn
    ? { ...tool, function: { ...fn, description, parameters } }
    : { ...tool, description, parameters }
}

function withToolName(tool, name) {
  const fn = chatFunctionOf(tool)
  return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name }
}

/**
 * Move caller tools off the fingerprint names where their arguments cannot carry
 * the official definition, and leave everything else verbatim.
 *
 * Upstream accepts foreign tool names alongside `read`/`shell` — including case
 * variants such as `Read` — so only exact-name collisions need handling. Two
 * declarations of one name are rejected, so the first wins.
 *
 * @param {unknown[] | undefined} tools
 * @param {{ definitions?: object }} [options]
 * @returns {{ tools: unknown[], map: Map<string, string> }} `map`: sent name -> original name.
 */
export function concealFingerprintToolNames(tools, options) {
  /** @type {Map<string, string>} */
  const map = new Map()
  if (!Array.isArray(tools) || tools.length === 0) return { tools: tools ?? [], map }
  const definitions = definitionsFor(options)

  const taken = new Set(tools.map(toolNameOf))
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {unknown[]} */
  const out = []

  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) {
      out.push(tool)
      continue
    }
    const key = fingerprintToolKey(toolNameOf(tool))
    if (key === '') {
      out.push(tool)
      continue
    }
    if (seen.has(key)) continue // duplicate declaration: keep the first
    seen.add(key)

    if (isFingerprintDefinition(tool, key, definitions)) {
      out.push(tool)
      continue
    }
    if (canNormalizeInPlace(tool, key, definitions)) {
      out.push(withFingerprintDefinition(tool, key, definitions))
      continue
    }
    let alias = `${key}_client`
    for (let i = 2; taken.has(alias); i++) alias = `${key}_client${i}`
    taken.add(alias)
    map.set(alias, key)
    out.push(withToolName(tool, alias))
  }
  return { tools: out, map }
}

/**
 * Append the official definition for each fingerprint tool the request lacks.
 *
 * @param {unknown[]} tools - Mutated in place.
 * @param {boolean} flat - `true` for the Responses wire (`{name}`), `false` for chat/messages.
 * @param {{ definitions?: object }} [options]
 * @returns {string[]} Names that were appended.
 */
export function appendMissingFingerprintTools(tools, flat, options) {
  const definitions = definitionsFor(options)
  /** @type {string[]} */
  const appended = []
  if (!Array.isArray(tools)) return appended
  for (const name of FINGERPRINT_TOOL_NAMES) {
    if (definitions[name] === undefined) continue
    if (tools.some((tool) => fingerprintToolKey(toolNameOf(tool)) === name)) continue
    const { description, parameters } = definitions[name]
    tools.push(
      flat
        ? { type: 'function', name, description, parameters, strict: false }
        : { type: 'function', function: { name, description, parameters } }
    )
    appended.push(name)
  }
  return appended
}

function aliasesByOriginal(map) {
  return new Map([...map].map(([alias, original]) => [original, alias]))
}

/**
 * Repoint an explicit `tool_choice` away from a name that just moved to an alias.
 *
 * A forced choice naming a tool that is no longer declared would be refused, and
 * `tool_choice: "none"` is refused outright by the gate — see
 * {@link applyFingerprintTools}.
 */
function retargetToolChoice(body, map) {
  const choice = body?.tool_choice
  if (choice === null || typeof choice !== 'object' || Array.isArray(choice)) return
  const name = typeof choice.name === 'string' ? choice.name.trim() : ''
  if (name === '') return
  const aliases = aliasesByOriginal(map)
  if (aliases.has(name)) body.tool_choice = { ...choice, name: aliases.get(name) }
}

/**
 * Rewrite tool-call names already recorded in history, so a renamed tool's past
 * calls still line up with its declaration.
 */
function aliasHistoryToolCalls(body, map) {
  if (!map?.size) return
  const aliases = aliasesByOriginal(map)

  if (Array.isArray(body.input)) {
    body.input = body.input.map((item) =>
      item?.type === 'function_call' && aliases.has(item.name)
        ? { ...item, name: aliases.get(item.name) }
        : item
    )
  }
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message) => {
      if (!Array.isArray(message?.tool_calls)) return message
      return {
        ...message,
        tool_calls: message.tool_calls.map((call) =>
          aliases.has(call?.function?.name)
            ? { ...call, function: { ...call.function, name: aliases.get(call.function.name) } }
            : call
        )
      }
    })
  }
}

/**
 * Tell the model the injected tools are off-limits.
 *
 * Without this the model does call them — a live probe on "what files are in
 * /etc?" produced a `read` call against the placeholder. Wording matters: an
 * earlier "these tools are not available" phrasing made the model refuse the
 * caller's own read/bash tools as well, while "placeholders … use the other
 * tools" left them working.
 */
function noteUnavailableTools(body, flat, names, claude = false) {
  const list = names.map((name) => `\`${name}\``).join(' or ')
  const note =
    names.length > 1
      ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
      : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`

  if (flat) {
    body.instructions =
      typeof body.instructions === 'string' && body.instructions.trim().length > 0
        ? `${body.instructions}\n\n${note}`
        : note
    return
  }
  if (claude || body.system !== undefined) {
    body.system = appendSystemText(body.system, note)
    return
  }
  if (!Array.isArray(body.messages)) return
  const first = body.messages[0]
  if (first?.role === 'system' && typeof first.content === 'string') {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...body.messages.slice(1)]
  } else {
    body.messages = [{ role: 'system', content: note }, ...body.messages]
  }
}

// ---------------------------------------------------------------------------
// Body shape: the <env> marker
// ---------------------------------------------------------------------------

const ENV_TAG = '<env>'
const ENV_HEADING = 'Here is some useful information about the environment you are running in:'

/**
 * The CLI's environment block. The marker gate reads text only — a foreign
 * system prompt plus this exact block passes — so it is appended to the caller's
 * own prompt rather than replacing it. Values mirror a real CLI instance on this
 * host, which keeps the block plausible without inventing a workspace.
 *
 * @param {{ workingDirectory?: string, isGitRepo?: boolean }} [options]
 * @returns {string}
 */
export function envFingerprintPrompt(options = {}) {
  const workingDirectory = options.workingDirectory ?? process.cwd()
  const tmpDir = path.join(os.tmpdir(), 'opencode')
  return [
    ENV_HEADING,
    ENV_TAG,
    `  Working directory: ${workingDirectory}`,
    `  Workspace root folder: ${workingDirectory}`,
    `  Is directory a git repo: ${options.isGitRepo === true ? 'yes' : 'no'}`,
    `  Platform: ${process.platform}`,
    `  Prefer ${tmpDir} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
    '</env>'
  ].join('\n')
}

/** Whether the marker is already present; a genuine client prompt is passed through. */
function systemCarriesEnv(system) {
  if (typeof system === 'string') return system.includes(ENV_TAG)
  if (Array.isArray(system)) {
    return system.some((block) => typeof block?.text === 'string' && block.text.includes(ENV_TAG))
  }
  return false
}

/** Append `text` to a system prompt held as a string, as text blocks, or unset. */
export function appendSystemText(system, text) {
  if (typeof system === 'string') return system.trim().length > 0 ? `${system}\n\n${text}` : text
  const blocks = Array.isArray(system) ? [...system] : []
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (typeof block?.text === 'string') {
      const existing = block.text.trim()
      blocks[i] = { ...block, text: existing.length > 0 ? `${existing}\n\n${text}` : text }
      return blocks
    }
  }
  return [...blocks, { type: 'text', text }]
}

/**
 * Append the `<env>` marker across all three request shapes: Responses
 * (`instructions`), chat (`messages[]` system) and Claude (top-level `system`).
 *
 * Fail-open: the marker is an enhancement, so a surprising body is left
 * untouched rather than rejected here.
 *
 * @param {object} body
 * @param {boolean} flat - `true` for the Responses wire.
 * @param {{ claude?: boolean, prompt?: string }} [options]
 * @returns {boolean} Whether the marker was added.
 */
export function applyEnvFingerprint(body, flat, options = {}) {
  const claude = options.claude === true
  const prompt = options.prompt ?? envFingerprintPrompt()
  try {
    if (body === null || typeof body !== 'object') return false

    if (flat) {
      if (body.instructions !== undefined && typeof body.instructions !== 'string') return false
      if (systemCarriesEnv(body.instructions)) return false
      body.instructions =
        typeof body.instructions === 'string' && body.instructions.trim().length > 0
          ? `${body.instructions}\n\n${prompt}`
          : prompt
      return true
    }

    if (claude || body.system !== undefined) {
      if (systemCarriesEnv(body.system)) return false
      body.system = appendSystemText(body.system, prompt)
      return true
    }

    if (!Array.isArray(body.messages)) return false
    const index = body.messages.findIndex((message) => message?.role === 'system')
    if (index >= 0) {
      const target = body.messages[index]
      if (systemCarriesEnv(target.content)) return false
      const content = appendSystemText(target.content, prompt)
      body.messages = body.messages.map((message, i) => (i === index ? { ...message, content } : message))
      return true
    }
    body.messages = [{ role: 'system', content: prompt }, ...body.messages]
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// The whole request-side pass
// ---------------------------------------------------------------------------

/**
 * Apply the complete body-side fingerprint to one outgoing request.
 *
 * Normalizes caller tools that collide with a fingerprint name, appends the
 * official definitions for any that are missing, tells the model the appended
 * ones are placeholders, adds the `<env>` marker, and clears a
 * `tool_choice: "none"` the gate would refuse.
 *
 * @param {object} body - Mutated in place, matching how the harness hands an adapter its request.
 * @param {boolean} flat - `true` for the Responses wire (`{name}` tools), `false` for chat/messages.
 * @param {{ claude?: boolean, tools?: boolean, envMarker?: boolean, prompt?: string, definitions?: object }} [options]
 * @returns {Map<string, string>} `map`: sent name -> original name, for response-side restore.
 */
export function applyFingerprintTools(body, flat, options = {}) {
  /** @type {Map<string, string>} */
  if (body === null || typeof body !== 'object') return new Map()

  /** @type {Map<string, string>} */
  let map = new Map()

  if (options.tools !== false) {
    const concealed = concealFingerprintToolNames(body.tools, options)
    map = concealed.map
    body.tools = Array.isArray(concealed.tools) ? concealed.tools : []
    const appended = appendMissingFingerprintTools(body.tools, flat, options)
    retargetToolChoice(body, map)
    aliasHistoryToolCalls(body, map)
    if (appended.length > 0) noteUnavailableTools(body, flat, appended, options.claude === true)
  }

  // The `<env>` marker is required on *every* free-lane request, with or without
  // tools: a request missing either half of the body gate is answered with
  // `429 FreeUsageLimitError` regardless of headers, UA or session shape. This
  // runs outside the `tools` branch so switching tool injection off does not
  // silently drop the marker with it.
  if (options.envMarker !== false) {
    applyEnvFingerprint(body, flat, { claude: options.claude === true, prompt: options.prompt })
  }

  // Never leave "none" on the wire: the gate answers it with 403 FreeTierError.
  // The Responses lane keeps its explicit `auto` default.
  if (body.tool_choice === 'none') delete body.tool_choice
  else if (body.tool_choice === undefined && flat && options.tools !== false) body.tool_choice = 'auto'

  return map
}

/**
 * Add the `<env>` marker on its own, for a request whose tools are already fine
 * or whose fingerprint tool injection is switched off.
 *
 * The marker gate is independent of the tool gate: a request missing *either*
 * half is answered with `429 FreeUsageLimitError` regardless of headers, UA or
 * session shape, and both halves together pass.
 *
 * @param {object} body
 * @param {boolean} flat
 * @param {{ claude?: boolean, prompt?: string }} [options]
 * @returns {boolean}
 */
export function applyEnvMarkerOnly(body, flat, options = {}) {
  return applyEnvFingerprint(body, flat, options)
}

/**
 * Restore caller tool spellings in a response or streaming event.
 *
 * Handles the shapes this plugin actually receives: OpenAI chat deltas and
 * messages, OpenAI Responses items and events, and Anthropic content blocks.
 *
 * @param {any} payload
 * @param {Map<string, string> | null | undefined} map - sent name -> original name.
 * @returns {any} The payload, copied only where a name actually changed.
 */
export function restoreToolNames(payload, map) {
  if (!map?.size || payload === null || payload === undefined) return payload
  if (Array.isArray(payload)) return payload.map((item) => restoreToolNames(item, map))
  if (typeof payload !== 'object') return payload

  let out = payload
  const put = (key, value) => {
    if (out === payload) out = { ...payload }
    out[key] = value
  }

  // Anthropic streaming content_block_start.
  if (payload.type === 'content_block_start') {
    const block = payload.content_block
    if (block?.type === 'tool_use' && typeof block.name === 'string' && map.has(block.name)) {
      put('content_block', { ...block, name: map.get(block.name) })
    }
  }

  // Anthropic non-streaming message body.
  if (Array.isArray(payload.content)) {
    put(
      'content',
      payload.content.map((block) =>
        block?.type === 'tool_use' && typeof block.name === 'string' && map.has(block.name)
          ? { ...block, name: map.get(block.name) }
          : block
      )
    )
  }

  // OpenAI Chat Completions: streaming delta and JSON message shapes.
  if (Array.isArray(payload.choices)) {
    put(
      'choices',
      payload.choices.map((choice) => {
        let changed = false
        const next = { ...choice }
        for (const holder of ['delta', 'message']) {
          const value = choice?.[holder]
          if (!value || !Array.isArray(value.tool_calls) || value.tool_calls.length === 0) continue
          const calls = value.tool_calls.map((call) => {
            const name = call?.function?.name
            if (typeof name === 'string' && map.has(name)) {
              changed = true
              return { ...call, function: { ...call.function, name: map.get(name) } }
            }
            return call
          })
          next[holder] = { ...value, tool_calls: calls }
        }
        return changed ? next : choice
      })
    )
  }

  // OpenAI Responses final JSON body.
  if (Array.isArray(payload.output)) {
    put(
      'output',
      payload.output.map((item) =>
        item?.type === 'function_call' && typeof item.name === 'string' && map.has(item.name)
          ? { ...item, name: map.get(item.name) }
          : item
      )
    )
  }

  // OpenAI Responses SSE events (response.output_item.added / .done).
  const item = payload.item
  if (item?.type === 'function_call' && typeof item.name === 'string' && map.has(item.name)) {
    put('item', { ...item, name: map.get(item.name) })
  }

  return out
}
