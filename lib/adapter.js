/**
 * The `LlmAdapter` for OpenCode's free lane.
 *
 * This is the piece that makes the free models usable from DSH Desktop instead of
 * only from OpenCode. Everything the free-tier gate checks is applied here or in
 * `fingerprint.js` / `transport.js`, and everything the harness needs to know
 * about a model — endpoint lane, context window, output cap, vision, reasoning
 * levels — is answered from the catalog.
 *
 * One deliberate omission: this adapter does **not** call the harness's
 * `attributionHeaders()`. That helper renders the product identity as
 * `deepseek-harness/<version> (+<url>)`, and the free lane rejects a User-Agent
 * merely *containing* `deepseek-harness` — case-insensitively, at any position —
 * in addition to matching the whole string against OpenCode's v2 form. Sending
 * attribution here is a guaranteed `403 FreeTierError`, so every request on this
 * route carries OpenCode's own UA instead, keyed or not. That is a real trade-off
 * and it is documented rather than hidden: a deployment that needs the harness to
 * identify itself to a provider should route that provider through
 * `@deepseek-ai/dsh-llm-pi-ai`, which sends attribution normally, and keep this
 * plugin for the free lane only.
 *
 * @module dsh-9router/adapter
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import {
  OPENCODE_USER_AGENT,
  SessionStore,
  applyFingerprintTools,
  fingerprintHeaders
} from './fingerprint.js'
import {
  SNAPSHOT_MODELS,
  baseModelId,
  findModel,
  isFreeModelId,
  laneForModel,
  resolveEffort,
  resolveMaxTokens
} from './catalog.js'
import {
  encodeImage,
  sanitizeResponsesItems,
  toAnthropicMessages,
  toAnthropicTools,
  toChatMessages,
  toChatTools,
  toResponsesInput,
  toResponsesTools
} from './request.js'
import { consumeChat, consumeMessages, consumeResponses } from './stream.js'

/**
 * @typedef {object} Connection
 * @property {string} baseURL - Endpoint root, without `/inference/v1`.
 * @property {number} [maxTokens] - Deployment output cap.
 * @property {number} defaultContextWindow
 * @property {number} defaultMaxTokens
 * @property {boolean} fingerprint
 * @property {{ userAgent: string, client: string, project: string, tools: boolean, envMarker: boolean }} fingerprintOptions
 * @property {'auto' | 'on' | 'off'} vision
 * @property {boolean} reasoningEcho
 */

/**
 * @typedef {object} AdapterOptions
 * @property {() => Connection} connection - Read per request, so config changes need no restart.
 * @property {() => Promise<string | undefined>} resolveApiKey - `undefined` = anonymous free lane.
 * @property {import('./discovery.js').Catalog} catalog
 * @property {import('./transport.js').Transport} transport
 * @property {() => any} [resolveAttachments] - `ctx.attachments`, for the vision path.
 * @property {() => { width: number, height: number, maxBytes: number }} [imageTarget]
 * @property {(event: string, detail?: string) => void} [onDiagnostic]
 */

export class OpenCodeFreeAdapter extends LlmAdapter {
  #connection
  #resolveApiKey
  #catalog
  #transport
  #resolveAttachments
  #imageTarget
  #onDiagnostic
  #sessions
  #displayName
  #retryPolicy

  /** @param {AdapterOptions & { displayName?: string, retryPolicy?: any }} options */
  constructor(options) {
    super()
    this.#retryPolicy = options.retryPolicy
    this.#connection = options.connection
    this.#resolveApiKey = options.resolveApiKey
    this.#catalog = options.catalog
    this.#transport = options.transport
    this.#resolveAttachments = options.resolveAttachments ?? (() => undefined)
    this.#imageTarget =
      options.imageTarget ?? (() => ({ width: 2048, height: 2048, maxBytes: 1_048_576 }))
    this.#onDiagnostic = options.onDiagnostic ?? (() => {})
    this.#displayName = options.displayName ?? 'OpenCode Free'
    this.#sessions = new SessionStore()
  }

  providerInfo(provider) {
    return { id: provider, name: this.#displayName }
  }

  /**
   * The retry policy captured with this route's registration.
   *
   * Returning `undefined` selects the harness's normal-mode defaults. The codes
   * matter: `dsh-llm-retry` only re-runs a failure whose code is in the policy's
   * retryable set, which by default is EMPTY_RESPONSE, RATE_LIMIT, SERVER,
   * TIMEOUT and TRANSPORT. This adapter therefore reports a 5xx as `SERVER` and a
   * handshake failure as `TRANSPORT` rather than inventing codes that would never
   * be retried — a free lane that answers 429 or drops a stream is exactly the
   * case where a retry is worth having.
   */
  providerRetryPolicy(_provider) {
    return this.#retryPolicy
  }

  /**
   * Advertise the models the free lane serves right now.
   *
   * The GUI requires catalog membership for selection and submission, so an
   * adapter that returns nothing here is invisible in the model picker no matter
   * how well its `stream()` works.
   */
  async listModels(provider) {
    const { models } = await this.#catalog.list()
    return models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      inputModalities: this.#modalitiesFor(model)
    }))
  }

  /**
   * Resolve one exact model's capability.
   *
   * This is where the harness learns what to offer in Settings → Models and the
   * model picker: the context window that drives compaction, the output cap
   * materialized into a request that names none, the selectable reasoning levels,
   * and whether images may be attached at all.
   */
  async resolveModel(provider, model, signal) {
    const { models } = await this.#catalog.list(signal)
    const connection = this.#connection()
    const known = findModel(models, model) ?? findModel(SNAPSHOT_MODELS, model)

    if (known === undefined) {
      // The catalog is advisory: absence does not mean unusable, because the free
      // lane adds models between releases. Fall back to the configured defaults
      // so the layer above still has a context number to base compaction on.
      return {
        provider,
        id: baseModelId(model),
        name: baseModelId(model),
        context: { contextWindow: connection.defaultContextWindow },
        defaultMaxTokens: connection.defaultMaxTokens,
        inputModalities: ['text']
      }
    }

    return {
      provider,
      id: known.id,
      name: known.name,
      ...(known.description === undefined ? {} : { description: known.description }),
      context: { contextWindow: known.contextWindow },
      defaultMaxTokens: resolveMaxTokens([known.maxOutputTokens, connection.maxTokens]),
      inputModalities: this.#modalitiesFor(known),
      ...(known.reasoningEfforts === false || known.reasoningEfforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts: known.reasoningEfforts.map((id) => ({
                id,
                name: effortLabel(id),
                description: effortDescription(id)
              })),
              ...(known.defaultEffort === undefined ? {} : { defaultEffort: known.defaultEffort })
            }
          })
    }
  }

  /**
   * Whether this route may declare image input.
   *
   * Declaring it is what makes the harness hand the adapter real image blocks;
   * not declaring it makes the harness substitute its own deterministic
   * placeholder text. Because the free lane has answered image input with 503,
   * the default `auto` follows the catalog per model, and `off` forces the safe
   * text-only projection for a deployment that sees image failures.
   */
  #modalitiesFor(model) {
    const vision = this.#connection().vision
    if (vision === 'off') return ['text']
    if (vision === 'on') return ['text', 'image']
    return model.inputModalities.includes('image') ? ['text', 'image'] : ['text']
  }

  /**
   * One provider attempt.
   *
   * The harness wraps this in the `llm/stream` waterfall and normalizes a throw
   * into a terminal `error`/`aborted` finish chunk, so failures here are thrown
   * as `LlmError` with a stable code rather than yielded.
   */
  async *stream(options) {
    const connection = this.#connection()
    const model = baseModelId(options.model)
    // `list()`, not `peek()`: the runtime resolved this exact model's modalities,
    // context and lane through `resolveModel()` while preparing the call, and a
    // request must be built from the same facts. Reading a cold memo here could
    // disagree with what the harness already decided — most damagingly by
    // declaring text-only while the runtime hands over real image blocks, which
    // would then be dropped instead of encoded. The catalog is memoized with a TTL
    // and `prepareCall` just warmed it, so this costs no round trip in practice.
    const { models } = await this.#catalog.list(options.signal)
    const known = findModel(models, model) ?? findModel(SNAPSHOT_MODELS, model)
    const lane = known?.lane ?? laneForModel(model)
    const apiKey = await this.#resolveApiKey()
    const free = apiKey === undefined || isFreeModelId(model)

    const url = endpointFor(connection.baseURL, lane)
    const aliasMap = { current: /** @type {Map<string, string> | null} */ (null) }

    const body = await this.#buildBody(options, { connection, known, lane, free })

    // The fingerprint is the whole point of this adapter: without it the free
    // lane answers 403 FreeTierError. It is skipped only when a paid key routes
    // the request off the free lane, or when a deployment explicitly turns it off.
    if (connection.fingerprint && free) {
      aliasMap.current = applyFingerprintTools(body, lane === 'responses', {
        claude: lane === 'messages',
        tools: connection.fingerprintOptions.tools,
        envMarker: connection.fingerprintOptions.envMarker
      })
    }

    const session = this.#sessions.resolve(options.sessionId ?? options.purpose ?? 'default')
    const headers = fingerprintHeaders({
      session,
      stream: true,
      userAgent: connection.fingerprint && free ? connection.fingerprintOptions.userAgent : undefined,
      client: connection.fingerprintOptions.client,
      project: connection.fingerprintOptions.project,
      apiKey,
      anthropic: lane === 'messages',
      extra: this.#extraHeaders(connection, known)
    })

    const response = await this.#transport.request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    })

    if (response.status < 200 || response.status >= 300) {
      const failure = await describeFailure(response, {
        apiKey: apiKey !== undefined,
        lane,
        model,
        transport: this.#transport,
        fingerprint: connection.fingerprint && free
      })
      this.#onDiagnostic('request-failed', `${failure.code}: ${failure.message}`)
      throw failure
    }
    if (response.body === null || response.body === undefined) {
      throw new LlmError('dsh-9router: provider returned no response body', 'SERVER', { status })
    }

    const consume =
      lane === 'responses' ? consumeResponses : lane === 'messages' ? consumeMessages : consumeChat

    // This lane is observed to answer 200 with an SSE stream that carries no
    // choices at all, which would otherwise become an empty assistant message and
    // silently end the turn with nothing for the loop to act on. The harness
    // vocabulary for that is EMPTY_RESPONSE, which its retry policy treats as safe
    // to repeat — so the terminal finish is held back until we know whether
    // anything durable was produced, because nothing may follow a finish chunk.
    let sawVisibleContent = false
    /** @type {any} */
    let finish

    try {
      for await (const chunk of consume(response.body, { aliasMap: () => aliasMap.current })) {
        if (chunk.type === 'finish') {
          finish = chunk
          continue
        }
        if (chunk.type === 'block-end') {
          const block = chunk.block
          if (
            (block.type === 'text' && block.text.length > 0) ||
            (block.type === 'reasoning' && block.text.length > 0) ||
            block.type === 'tool-call'
          ) {
            sawVisibleContent = true
          }
        }
        yield chunk
      }
    } catch (error) {
      // An SSE-level `error` event or a truncated stream: classify it the same
      // way as an HTTP failure so the retry policy and the UI see one vocabulary.
      throw classifyStreamError(error, { apiKey: apiKey !== undefined, transport: this.#transport })
    }

    if (!sawVisibleContent && finish?.reason?.kind === 'stop') {
      throw new LlmError(
        `dsh-9router: ${model} completed with no content (${lane} lane, HTTP ${response.status}). ` +
          'The free lane does this when a pooled upstream returns a degenerate completion; the attempt ' +
          'produced nothing durable, so it is reported as retryable rather than as an empty answer.',
        'EMPTY_RESPONSE',
        { status: response.status }
      )
    }
    if (finish !== undefined) yield finish
  }

  /**
   * Build the wire body for one lane.
   *
   * @param {any} options - Harness `GenerateOptions`.
   * @param {{ connection: Connection, known: any, lane: string, free: boolean }} ctx
   */
  async #buildBody(options, { connection, known, lane, free }) {
    const wantsImages = this.#modalitiesFor(known ?? { inputModalities: ['text'] }).includes('image')
    const encoder = wantsImages
      ? async (block) =>
          encodeImage(
            this.#resolveAttachments(),
            block,
            this.#imageTarget(),
            options.signal
          )
      : undefined

    const maxTokens = resolveMaxTokens([
      options.maxTokens,
      connection.maxTokens,
      known?.maxOutputTokens,
      connection.defaultMaxTokens
    ])
    const effort = resolveEffort(options.reasoningEffort, known?.reasoningEfforts)

    if (lane === 'responses') {
      const { instructions, input } = toResponsesInput(options.messages, {
        system: options.system
      })
      /** @type {any} */
      const body = {
        model: options.model,
        input: sanitizeResponsesItems(input),
        stream: true,
        // The free lane routes through a pooled upstream account, so stored
        // Responses state would be unreadable on the next turn. Prior-turn
        // reasoning items are dropped for the same reason (see
        // `sanitizeResponsesItems`), so there is nothing to ask the backend to
        // encrypt back to us.
        store: false
      }
      if (instructions !== undefined) body.instructions = instructions
      const tools = toResponsesTools(options.tools)
      if (tools !== undefined) body.tools = tools
      if (maxTokens !== undefined) body.max_output_tokens = maxTokens
      if (effort !== undefined) body.reasoning = { effort, summary: 'auto' }
      if (options.temperature !== undefined) body.temperature = options.temperature
      if (known?.forceAutoToolChoice === true) body.tool_choice = 'auto'
      return body
    }

    if (lane === 'messages') {
      const { system, messages } = await toAnthropicMessages(options.messages, {
        system: options.system,
        images: wantsImages,
        encodeImage: encoder
      })
      /** @type {any} */
      const body = {
        model: options.model,
        messages,
        stream: true,
        // Anthropic requires an output cap; omitting it is a 400.
        max_tokens: maxTokens ?? connection.defaultMaxTokens
      }
      if (system !== undefined) body.system = system
      const tools = toAnthropicTools(options.tools)
      if (tools !== undefined) body.tools = tools
      if (options.temperature !== undefined) body.temperature = options.temperature
      if (options.stop !== undefined && options.stop.length > 0) body.stop_sequences = [...options.stop]
      return body
    }

    // Chat Completions lane — the default, and where most free models live.
    const messages = await toChatMessages(options.messages, {
      // Reasoning models on this lane refuse multi-turn history whose assistant
      // messages carry no reasoning_content (400 missing_required_parameter), and
      // the harness strips thinking before it reaches a client, so the echo can
      // never come from the caller. Inject a placeholder where one is missing.
      reasoningEcho: connection.reasoningEcho && (known?.reasoningEchoRequired ?? true),
      images: wantsImages,
      encodeImage: encoder
    })
    /** @type {any} */
    const body = {
      model: options.model,
      messages,
      stream: true,
      stream_options: { include_usage: true }
    }
    const tools = toChatTools(options.tools)
    if (tools !== undefined) body.tools = tools
    if (options.temperature !== undefined) body.temperature = options.temperature
    // `max_completion_tokens` is answered with "Endpoint is unavailable" on this
    // lane, so the cap always travels as `max_tokens`.
    if (maxTokens !== undefined) body.max_tokens = maxTokens
    if (effort !== undefined) body.reasoning_effort = effort
    if (options.stop !== undefined && options.stop.length > 0) body.stop = [...options.stop]
    // Fields the free lane rejects or ignores; sending them invites a 400.
    for (const key of ['store', 'metadata', 'prompt_cache_key', 'safety_identifier', 'service_tier']) {
      delete body[key]
    }
    void free
    return body
  }

  /**
   * Route-level headers beyond the fingerprint.
   *
   * OpenCode's own provider sends an explicit image opt-in, which the upstream
   * forwards; a text-only request is unchanged by it.
   */
  #extraHeaders(connection, known) {
    /** @type {Record<string, string>} */
    const extra = {}
    const modalities = this.#modalitiesFor(known ?? { inputModalities: ['text'] })
    if (connection.vision !== 'off' && modalities.includes('image')) {
      extra['typesafe-danger-zone-images'] = 'true'
    }
    return extra
  }

  /** Forget every remembered session; used on disposal and in tests. */
  disposeSessions() {
    this.#sessions.dispose()
  }
}

/**
 * The endpoint for one lane.
 *
 * The free lane moved from `/zen/v1` to `/inference/v1` with OpenCode v2, and the
 * old path now answers every free request with `403 FreeTierError` even when the
 * rest of the request is byte-perfect. A `baseURL` that already names a lane path
 * is honoured, so a deployment can pin `/zen/v1` for a paid key.
 *
 * @param {string} baseURL
 * @param {'chat' | 'responses' | 'messages'} lane
 * @returns {string}
 */
export function endpointFor(baseURL, lane) {
  const root = String(baseURL ?? '').replace(/\/+$/, '')
  const suffix =
    lane === 'responses' ? '/responses' : lane === 'messages' ? '/messages' : '/chat/completions'

  // Already pinned to a concrete lane path: use it verbatim.
  if (/\/(chat\/completions|responses|messages)$/.test(root)) return root

  // Already pinned to a versioned root (`.../inference/v1` or `.../zen/v1`):
  // append only the lane suffix.
  if (/\/v\d+$/.test(root)) return `${root}${suffix}`

  // A bare origin, or `.../zen`: put the request on the free lane's own root.
  return `${root}/inference/v1${suffix}`
}

/** Human-readable label for a reasoning level. */
export function effortLabel(id) {
  switch (String(id).toLowerCase()) {
    case 'none':
    case 'off':
      return 'Off'
    case 'minimal':
      return 'Minimal'
    case 'low':
      return 'Low'
    case 'medium':
      return 'Medium'
    case 'high':
      return 'High'
    case 'xhigh':
      return 'Extra high'
    case 'max':
      return 'Max'
    default:
      return String(id)
  }
}

/** One line explaining what a level does, for the picker's tooltip. */
function effortDescription(id) {
  switch (String(id).toLowerCase()) {
    case 'none':
    case 'off':
      return 'Answer without a visible thinking phase'
    case 'max':
      return 'The most thinking this model offers; slowest and largest output'
    default:
      return undefined
  }
}

/**
 * Classify an HTTP failure into a stable, provider-neutral code.
 *
 * The two free-lane failures are the ones worth explaining at length, because
 * both read like quota problems and neither is:
 *
 * - `FreeTierError` (403) means the request did not look like OpenCode. The gate
 *   has five independent checks and this says one of them failed — which in
 *   practice is a stale User-Agent, a missing session header, an un-minted
 *   session id, or a fingerprint tool the upstream reworded.
 * - `FreeUsageLimitError` (429) means the shape was accepted and the shared
 *   anonymous quota is exhausted — or, on a request whose shape is known-good,
 *   that the TLS fingerprint did not match.
 *
 * @param {any} response - A `TransportResponse`.
 * @param {{ apiKey: boolean, lane: string, model: string, transport: any, fingerprint: boolean }} ctx
 * @returns {Promise<LlmError>}
 */
export async function describeFailure(response, ctx) {
  const raw = await response.text().catch(() => '')
  let detail = raw.slice(0, 600)
  let upstreamType
  try {
    const parsed = JSON.parse(raw)
    upstreamType = parsed?.error?.type ?? parsed?.type
    detail = parsed?.error?.message ?? parsed?.message ?? detail
  } catch {
    // A gateway's HTML 502 page is kept verbatim and truncated.
  }

  const where = `${ctx.model} on the ${ctx.lane} lane`
  const status = response.status

  if (upstreamType === 'FreeTierError' || status === 403) {
    return new LlmError(
      `dsh-9router: the free tier refused this request (${where}): ${detail}. ` +
        'This is OpenCode\'s client-identity gate, not a quota or credential problem. ' +
        (ctx.fingerprint
          ? `The fingerprint was applied, so the most likely causes are an upstream change to the expected User-Agent (currently "${OPENCODE_USER_AGENT}") or to the verbatim read/shell tool definitions — run \`npm run probe\` in this package to see which check fails, and override the value in the plugin config.`
          : 'The fingerprint is switched off (fingerprint.enabled: false), which only works with a paid key; enable it for the free lane.') +
        (ctx.transport?.mode === 'native'
          ? ' Note also that transport.mode is "native": the free lane keys on the TLS cipher list, so use "impersonate" or "auto".'
          : ''),
      'AUTH',
      { status }
    )
  }

  if (upstreamType === 'FreeUsageLimitError' || status === 429) {
    const retryAfter = Number(response.header?.('retry-after'))
    // This status is doing double duty upstream, and telling the two apart is
    // the whole diagnostic value here:
    //   - a genuinely exhausted shared anonymous quota, and
    //   - a request the *body* or *TLS* gate rejected, which the lane also
    //     answers 429 rather than 403.
    // The refusal text names the missing half when it is the body gate.
    const bodyGate = /<env>|marker|\bread\b|\bshell\b|tool/i.test(detail)
    const tlsSuspect = !bodyGate && !ctx.apiKey && ctx.transport?.mode === 'native'
    const advice = bodyGate
      ? 'The request body did not satisfy the free lane\'s agent-shape gate (the verbatim read/shell tools and the <env> system marker). If fingerprint.tools or fingerprint.envMarker was switched off, turn it back on; if both are on, upstream most likely reworded a tool definition — run `npm run probe` to diff against the official client.'
      : tlsSuspect
        ? 'The shape was accepted but the TLS ClientHello was not: the free lane keys on the cipher list, and transport.mode is "native". Set transport.mode to "impersonate" or "auto".'
        : ctx.apiKey
          ? 'This account\'s free allowance is exhausted; retry later or check the balance at https://opencode.ai/zen'
          : 'This plugin is on the shared anonymous free quota, which is rate-limited by source. Set OPENCODE_API_KEY for a private quota, or wait for the reset.'
    return new LlmError(
      `dsh-9router: free-tier request limited (${where}): ${detail}. ${advice}`,
      'RATE_LIMIT',
      {
        status,
        ...(Number.isFinite(retryAfter) && retryAfter > 0
          ? { providerRetryAfterMs: retryAfter * 1000 }
          : {})
      }
    )
  }

  if (status === 401) {
    return new LlmError(
      ctx.apiKey
        ? `dsh-9router: the API key was rejected (${where}): ${detail}`
        : `dsh-9router: this request needs a credential (${where}): ${detail}. Set OPENCODE_API_KEY, or use a free model id so the anonymous lane applies.`,
      ctx.apiKey ? 'INVALID_CREDENTIAL' : 'MISSING_CREDENTIAL',
      { status }
    )
  }

  if (status === 400) {
    return new LlmError(
      `dsh-9router: the request was rejected (${where}): ${detail}. ` +
        'On this lane a 400 usually names an unsupported reasoning_effort, a developer-role message, or max_completion_tokens — all three are rewritten by this adapter, so an unexpected 400 points at a model that moved lanes. Check the catalog lane for this id.',
      'INVALID_REQUEST',
      { status }
    )
  }

  if (status === 503 && /image/i.test(detail)) {
    return new LlmError(
      `dsh-9router: this model refused image input (${where}): ${detail}. Set vision: "off" in the plugin config to have the harness send its text placeholder instead.`,
      'UNSUPPORTED_MODALITY',
      { status }
    )
  }

  if (status >= 500) {
    // `SERVER` is in the default retryable set; a bespoke code here would mean a
    // transient upstream 502 is never retried.
    return new LlmError(`dsh-9router: upstream error ${status} (${where}): ${detail}`, 'SERVER', { status })
  }

  return new LlmError(`dsh-9router: provider returned HTTP ${status} (${where}): ${detail}`, 'INVALID_REQUEST', {
    status
  })
}

/**
 * Classify a failure raised mid-stream.
 *
 * @param {unknown} error
 * @param {{ apiKey: boolean, transport: any }} ctx
 * @returns {LlmError}
 */
export function classifyStreamError(error, ctx) {
  if (error instanceof LlmError) return error
  const message = error instanceof Error ? error.message : String(error)
  const upstreamType = /** @type {any} */ (error)?.upstreamType

  if (upstreamType === 'FreeTierError') {
    return new LlmError(
      `dsh-9router: the free tier refused this streamed request: ${message}. See the 403 guidance in this plugin's README.`,
      'AUTH'
    )
  }
  if (upstreamType === 'FreeUsageLimitError') {
    return new LlmError(
      `dsh-9router: free-tier quota limited mid-stream: ${message}. ${
        ctx.apiKey ? 'Retry later.' : 'Set OPENCODE_API_KEY for a private quota.'
      }`,
      'RATE_LIMIT'
    )
  }
  if (/abort/i.test(message)) {
    return new LlmError(`dsh-9router: request aborted: ${message}`, 'ABORTED')
  }
  if (/timeout|timed out/i.test(message)) {
    return new LlmError(`dsh-9router: request timed out: ${message}`, 'TIMEOUT')
  }
  if (/cipher|tls|ssl|handshake/i.test(message)) {
    return new LlmError(
      `dsh-9router: TLS failure (${message}). The free lane keys on the ClientHello cipher list; transport.mode "${ctx.transport?.mode}" could not complete a handshake.`,
      'TRANSPORT'
    )
  }
  return new LlmError(`dsh-9router: stream failed: ${message}`, 'SERVER')
}
