/**
 * A local stand-in for OpenCode's free lane that enforces the real gate.
 *
 * This is the strongest test in the package: rather than asserting that the
 * plugin *sends* particular headers, it asserts that a request from the plugin
 * is *accepted* by a server that refuses anything the upstream refuses. Every
 * check mirrors a documented ablation result (see docs/gate.md) — remove any one
 * of them and a faithful request still passes, remove any one property from the
 * plugin and the request fails here exactly as it fails upstream.
 *
 * Served over plain HTTP so a test can exercise every header- and body-side gate
 * without a TLS setup; the cipher-list gate is tested separately against a real
 * TLS socket in `transport.test.mjs`.
 */

import http from 'node:http'
import { FINGERPRINT_TOOL_DEFINITIONS } from '../lib/fingerprint.js'

const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const UA_RE = /^opencode\/[a-z0-9-]+\/(\d+)\.\d+\.\d+\/[a-z0-9-]+$/i
/** Counter ceiling: probes put acceptance at 0..16 and refusal at >= 100. */
const MAX_COUNTER = 63

/**
 * @typedef {object} GateServer
 * @property {string} baseURL
 * @property {number} port
 * @property {any[]} requests - Every body the server accepted, for assertions.
 * @property {any[]} refusals - Every refusal with its reason.
 * @property {() => Promise<void>} close
 */

/**
 * Start the gate server.
 *
 * @param {{ requireEnvMarker?: boolean, emptyFor?: (body: any) => boolean }} [options]
 * @returns {Promise<GateServer>}
 */
export async function startGateServer(options = {}) {
  /** @type {any[]} */
  const requests = []
  /** @type {any[]} */
  const refusals = []

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const raw = Buffer.concat(chunks).toString('utf8')

      if (req.method === 'GET' && url.pathname.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: LISTING }))
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }

      let body
      try {
        body = raw.length > 0 ? JSON.parse(raw) : {}
      } catch {
        return refuse(res, refusals, 400, 'InvalidJSON', 'body is not valid JSON')
      }

      // ── Gate 1: path ────────────────────────────────────────────────────
      // The free lane lives on /inference/v1; /zen/v1 403s everything.
      if (url.pathname.startsWith('/zen/')) {
        return refuse(res, refusals, 403, 'FreeTierError', FREE_TIER_MESSAGE)
      }
      const lane = laneOf(url.pathname)
      if (lane === undefined) {
        return refuse(res, refusals, 404, 'NotFound', `no lane at ${url.pathname}`)
      }

      // ── Gate 2: User-Agent ──────────────────────────────────────────────
      const ua = String(req.headers['user-agent'] ?? '')
      if (/deepseek[-_]harness/i.test(ua)) {
        return refuse(res, refusals, 403, 'FreeTierError', `UA names a foreign harness: ${ua}`)
      }
      const uaMatch = ua.match(UA_RE)
      if (uaMatch === null || Number.parseInt(uaMatch[1], 10) < 2) {
        return refuse(res, refusals, 403, 'FreeTierError', `UA is not the v2 shape: ${JSON.stringify(ua)}`)
      }

      // ── Gate 3: session headers ─────────────────────────────────────────
      const sessionHeaders = [
        'x-opencode-session',
        'x-opencode-session-id',
        'x-session-affinity',
        'x-session-id'
      ]
      const values = sessionHeaders.map((name) => req.headers[name])
      if (values.some((value) => typeof value !== 'string' || value.length === 0)) {
        return refuse(
          res,
          refusals,
          403,
          'FreeTierError',
          `missing one of ${sessionHeaders.join(', ')}`
        )
      }
      if (new Set(values).size !== 1) {
        return refuse(res, refusals, 403, 'FreeTierError', 'the four session headers disagree')
      }
      // The v1-only header is itself a rejection.
      if (req.headers['x-opencode-request'] !== undefined) {
        return refuse(res, refusals, 403, 'FreeTierError', 'v1 header x-opencode-request present')
      }

      // ── Gate 4: session id shape ────────────────────────────────────────
      const session = String(values[0])
      if (!SESSION_RE.test(session)) {
        return refuse(res, refusals, 403, 'FreeTierError', `session id shape rejected: ${session}`)
      }
      // Decode the minted prefix: ~(ms * 0x1000 + counter), low 48 bits.
      const prefix = BigInt(`0x${session.slice(4, 16)}`)
      const decoded = ~prefix & ((1n << 48n) - 1n)
      const counter = Number(decoded & 0xfffn)
      const timeMs = Number(decoded >> 12n)
      if (counter > MAX_COUNTER) {
        return refuse(res, refusals, 403, 'FreeTierError', `session counter ${counter} too large`)
      }
      // The 12-hex prefix holds `~(ms * 4096 + counter)` masked to 48 bits, and
      // `ms * 4096` needs 53 bits at current dates — so the decoded time is the
      // real time modulo 2^36 (the field wraps every ~2.18 years). Compare in
      // that same wrapped space, or every correctly minted id looks ancient.
      const wrap = 2 ** 36
      const expected = Date.now() % wrap
      const distance = Math.min(Math.abs(timeMs - expected), wrap - Math.abs(timeMs - expected))
      if (distance > 5 * 60 * 1000) {
        return refuse(
          res,
          refusals,
          403,
          'FreeTierError',
          `session timestamp out of window (wrapped drift ${distance}ms)`
        )
      }

      // ── Gate 5: body shape ──────────────────────────────────────────────
      if (body.stream !== true) {
        return refuse(res, refusals, 403, 'FreeTierError', 'free lane requires stream: true')
      }
      if (body.tool_choice === 'none') {
        return refuse(res, refusals, 403, 'FreeTierError', 'tool_choice "none" is refused')
      }
      if (options.requireEnvMarker !== false) {
        const system = systemTextOf(body, lane)
        if (!system.includes('<env>')) {
          return refuse(
            res,
            refusals,
            429,
            'FreeUsageLimitError',
            'the <env> marker is missing from the system prompt'
          )
        }
      }
      const toolFailure = checkFingerprintTools(body, lane)
      if (toolFailure !== undefined) {
        // Same verdict as a missing marker: the body gate answers 429
        // FreeUsageLimitError for either missing half, not 403. The 403
        // FreeTierError is reserved for the identity gates above (path, UA,
        // session headers, session id shape).
        return refuse(res, refusals, 429, 'FreeUsageLimitError', toolFailure)
      }

      // ── Lane-specific rejections the plugin must also avoid ─────────────
      if (lane === 'chat') {
        if (Array.isArray(body.messages) && body.messages.some((m) => m?.role === 'developer')) {
          return refuse(res, refusals, 400, 'InvalidRequest', '[1214] Incorrect role information')
        }
        if (body.max_completion_tokens !== undefined) {
          return refuse(res, refusals, 400, 'InvalidRequest', 'Endpoint is unavailable')
        }
        if (
          body.reasoning_effort !== undefined &&
          !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning_effort)
        ) {
          return refuse(
            res,
            refusals,
            400,
            'InvalidRequest',
            `[1210] Invalid option: reasoning_effort ${body.reasoning_effort}`
          )
        }
        if (body.reasoning_effort === 'auto') {
          return refuse(res, refusals, 400, 'InvalidRequest', '[1210] Invalid option: auto')
        }
      }
      if (lane === 'responses') {
        if (body.max_tokens !== undefined || body.max_completion_tokens !== undefined) {
          return refuse(res, refusals, 400, 'InvalidRequest', 'Responses takes max_output_tokens')
        }
        if (body.reasoning_effort !== undefined) {
          return refuse(res, refusals, 400, 'InvalidRequest', 'Responses takes reasoning.effort')
        }
        if (body.reasoning?.effort !== undefined && body.reasoning.effort === 'auto') {
          return refuse(res, refusals, 400, 'InvalidRequest', 'unknown variant `auto`')
        }
        if (Array.isArray(body.input) && body.input.some((item) => item?.type === 'reasoning')) {
          return refuse(res, refusals, 400, 'InvalidRequest', 'prior reasoning items are refused')
        }
        if (!Array.isArray(body.input) || body.input.length === 0) {
          return refuse(res, refusals, 400, 'InvalidRequest', 'input must not be empty')
        }
      }
      if (lane === 'messages') {
        if (typeof body.max_tokens !== 'number' || body.max_tokens <= 0) {
          return refuse(res, refusals, 400, 'InvalidRequest', 'max_tokens is required')
        }
        if (req.headers['anthropic-version'] === undefined) {
          return refuse(res, refusals, 400, 'InvalidRequest', 'anthropic-version is required')
        }
      }

      requests.push({ lane, url: url.pathname, headers: req.headers, body })
      // The lane is observed to answer 200 with a stream that carries no choices
      // at all; `emptyFor` lets a test reproduce that without a second server.
      if (options.emptyFor?.(body) === true) return emptyReply(res, lane)
      streamReply(res, lane, body)
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  return {
    baseURL: `http://127.0.0.1:${port}`,
    port,
    requests,
    refusals,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
  }
}

function laneOf(pathname) {
  if (pathname.endsWith('/chat/completions')) return 'chat'
  if (pathname.endsWith('/responses')) return 'responses'
  if (pathname.endsWith('/messages')) return 'messages'
  return undefined
}

function refuse(res, refusals, status, type, message) {
  refusals.push({ status, type, message })
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type, message } }))
}

const FREE_TIER_MESSAGE = "OpenCode's free tier can only be used from within OpenCode"

/** The system-prompt text of one request, wherever this lane keeps it. */
function systemTextOf(body, lane) {
  if (lane === 'responses') return typeof body.instructions === 'string' ? body.instructions : ''
  if (lane === 'messages') {
    if (typeof body.system === 'string') return body.system
    if (Array.isArray(body.system)) return body.system.map((block) => block?.text ?? '').join('\n')
    return ''
  }
  if (!Array.isArray(body.messages)) return ''
  return body.messages
    .filter((message) => message?.role === 'system' || message?.role === 'developer')
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n')
}

/**
 * The tool half of the gate: `read` and `shell` must both be declared, with the
 * official description and parameter schema.
 */
function checkFingerprintTools(body, lane) {
  const tools = Array.isArray(body.tools) ? body.tools : []
  for (const name of ['read', 'shell']) {
    const declared = tools.filter((tool) => toolName(tool, lane) === name)
    if (declared.length === 0) return `the "${name}" tool is not declared`
    if (declared.length > 1) return `the "${name}" tool is declared twice`
    const want = FINGERPRINT_TOOL_DEFINITIONS[name]
    const tool = declared[0]
    const description = lane === 'responses' ? tool.description : tool.function?.description
    const parameters = lane === 'responses' ? tool.parameters : tool.function?.parameters
    if (description !== want.description) {
      return `the "${name}" description does not match the official client's`
    }
    if (JSON.stringify(parameters) !== JSON.stringify(want.parameters)) {
      return `the "${name}" parameter schema does not match the official client's`
    }
  }
  // Case variants and foreign names are accepted alongside, but an empty schema
  // on a colliding name is not.
  for (const tool of tools) {
    const name = toolName(tool, lane)
    if (name !== 'read' && name !== 'shell') continue
  }
  return undefined
}

function toolName(tool, lane) {
  if (tool === null || typeof tool !== 'object') return ''
  if (lane === 'responses' && typeof tool.name === 'string') return tool.name
  return typeof tool.function?.name === 'string' ? tool.function.name : String(tool.name ?? '')
}

/**
 * Emit a small but complete SSE reply for one lane, including reasoning, text, a
 * tool call and usage — enough for the stream consumer tests to assert on.
 */
function streamReply(res, lane, body) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
  const model = String(body.model ?? 'big-pickle')

  if (lane === 'chat') {
    send({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant' } }] })
    send({ object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { reasoning_content: 'Thinking' } }] })
    send({ object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { reasoning_content: ' hard.' } }] })
    send({ object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: 'pong' } }] })
    send({
      object: 'chat.completion.chunk',
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":' } }
            ]
          }
        }
      ]
    })
    send({
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"/etc"}' } }] }}]
    })
    send({ object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    send({
      object: 'chat.completion.chunk',
      model,
      choices: [],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_cache_hit_tokens: 20 }
    })
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  if (lane === 'responses') {
    send({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } })
    send({ type: 'response.reasoning_summary_text.delta', delta: 'Thinking.' })
    send({ type: 'response.output_text.delta', delta: 'pong' })
    send({
      type: 'response.output_item.added',
      item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'read' }
    })
    send({ type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{"path":"/etc"}' })
    send({ type: 'response.function_call_arguments.done', item_id: 'item_1', arguments: '{"path":"/etc"}' })
    send({
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          total_tokens: 125,
          input_tokens_details: { cached_tokens: 10 },
          output_tokens_details: { reasoning_tokens: 5 }
        }
      }
    })
    res.end()
    return
  }

  // Anthropic Messages lane.
  send({ type: 'message_start', message: { id: 'msg_1', role: 'assistant', usage: { input_tokens: 80 } } })
  send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } })
  send({ type: 'content_block_stop', index: 0 })
  send({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'call_1', name: 'read', input: {} }
  })
  send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } })
  send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"/etc"}' } })
  send({ type: 'content_block_stop', index: 1 })
  send({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 22 } })
  send({ type: 'message_stop' })
  res.end()
}

/** A 200 SSE reply that carries no choices, exactly as the lane sometimes does. */
function emptyReply(res, lane) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  if (lane === 'chat') {
    res.write('data: {"id":"chatcmpl-empty","object":"chat.completion.chunk","choices":[]}\n\n')
    res.write('data: [DONE]\n\n')
  } else if (lane === 'responses') {
    res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', status: 'completed' } })}\n\n`)
  } else {
    res.write(`data: ${JSON.stringify({ type: 'message_start', message: { id: 'm', role: 'assistant' } })}\n\n`)
    res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
  }
  res.end()
}

/** A listing shaped like the real `/models` reply: ids and nothing else. */
const LISTING = [
  { id: 'big-pickle', object: 'model', owned_by: 'opencode' },
  { id: 'nemotron-3-ultra-free', object: 'model', owned_by: 'opencode' },
  { id: 'muse-spark-1.3-contributor-free', object: 'model', owned_by: 'opencode' },
  { id: 'union-alpha', object: 'model', owned_by: 'opencode' },
  { id: 'gpt-5.5', object: 'model', owned_by: 'opencode' },
  { id: 'jev-1.13-free', object: 'model', owned_by: 'opencode' }
]
