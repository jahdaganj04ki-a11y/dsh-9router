/**
 * SSE → harness stream translation for all three free-lane protocols.
 *
 * The two sides model "a stream" differently, and this file is the bridge. The
 * upstreams emit **flat deltas** — `delta.content`, `delta.reasoning_content`,
 * `delta.tool_calls[i]` on the chat lane; typed `response.*` events on the
 * Responses lane; `content_block_delta` on the Anthropic lane — while the harness
 * wants **paired blocks**: `block-start`, deltas carrying a block index, then
 * `block-end` carrying the assembled block, then `usage`, then exactly one
 * terminal `finish`.
 *
 * Upstream never states when a block begins or ends, so this state machine
 * decides: text starting closes an open reasoning block, a tool call starting
 * closes both, and the end of the stream closes whatever is still open. Getting
 * that wrong interleaves thinking and answer text in the transcript.
 *
 * Protocol invariants enforced here, because the harness relies on them:
 * - `usage` precedes `finish`, and nothing follows `finish`.
 * - Tool arguments stay raw JSON strings; they are never parsed.
 * - Token counts are **disjoint**: `inputTokens` is uncached input only, so an
 *   OpenAI-style `prompt_tokens` that folds cache hits into itself has them
 *   subtracted back out. Without that, a cached conversation double-counts its
 *   input on every turn.
 *
 * This module depends on types only and imports no harness runtime value, so a
 * unit test can feed it a synthetic stream without standing up the harness.
 *
 * @module dsh-9router/stream
 */

import { restoreToolNames } from './fingerprint.js'

/**
 * Normalize a body into an async iterable of byte chunks.
 *
 * The native Node transport hands over an `IncomingMessage` (already async
 * iterable) and the optional wreq transport hands over a web `ReadableStream`
 * (which needs a reader). One entry point keeps the consumers transport-agnostic.
 *
 * @param {any} body
 * @returns {AsyncIterable<Uint8Array>}
 */
export async function* toByteChunks(body) {
  if (body === null || body === undefined) return
  if (typeof body.getReader === 'function') {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        if (value !== undefined && value !== null) yield new Uint8Array(value)
      }
    } finally {
      // An early return ([DONE], downstream break, abort) without releasing
      // would hang the connection.
      try {
        reader.releaseLock()
      } catch {
        // Already released.
      }
    }
    return
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) {
      yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
    }
    return
  }
  throw new Error('dsh-9router: response body is neither a Node stream nor a ReadableStream')
}

/**
 * Split a byte stream into SSE events.
 *
 * Only `data:` lines carry payloads; comments, `event:` lines and keep-alive
 * blanks are skipped, and `[DONE]` is a terminator rather than a payload. A
 * partial line is held in the buffer — network chunking splits a JSON line in
 * two, and parsing per chunk instead of per line is the most common bug in an
 * implementation like this.
 *
 * @param {any} body
 * @returns {AsyncGenerator<string>} The raw payload text of each `data:` line.
 */
export async function* ssePayloads(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of toByteChunks(body)) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '').trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line.startsWith('data:')) continue
      const payload = line.slice('data:'.length).trim()
      if (payload === '[DONE]') return
      if (payload.length > 0) yield payload
    }
  }
  // When upstream omits the trailing newline the last event lives only in the buffer.
  const tail = buffer.trim()
  if (tail.startsWith('data:')) {
    const payload = tail.slice('data:'.length).trim()
    if (payload.length > 0 && payload !== '[DONE]') yield payload
  }
}

/**
 * Block bookkeeping shared by the three protocol consumers: index allocation and
 * the open/close discipline that keeps text, reasoning and tool calls from
 * interleaving.
 */
class BlockEmitter {
  #nextIndex = 0
  #text
  #reasoning
  /** @type {Map<string | number, { index: number, id: string, name: string, args: string[] }>} */
  #tools = new Map()
  /** @type {string[]} */
  #toolOrder = []

  sawToolCall = false
  /** @type {any} */
  usage

  /** @param {() => Map<string, string> | null} aliasMap */
  constructor(aliasMap) {
    this.aliasMap = aliasMap
  }

  /** Open the text block if needed; closes reasoning first. */
  *openText() {
    if (this.#text !== undefined) return
    yield* this.closeReasoning()
    this.#text = { index: this.#nextIndex++, parts: [] }
    yield { type: 'block-start', index: this.#text.index, blockType: 'text' }
  }

  *pushText(text) {
    if (typeof text !== 'string' || text.length === 0) return
    yield* this.openText()
    this.#text.parts.push(text)
    yield { type: 'text-delta', index: this.#text.index, text }
  }

  *closeText() {
    const open = this.#text
    if (open === undefined) return
    this.#text = undefined
    yield { type: 'block-end', index: open.index, block: { type: 'text', text: open.parts.join('') } }
  }

  *openReasoning() {
    if (this.#reasoning !== undefined) return
    this.#reasoning = { index: this.#nextIndex++, parts: [] }
    yield { type: 'block-start', index: this.#reasoning.index, blockType: 'reasoning' }
  }

  *pushReasoning(text) {
    if (typeof text !== 'string' || text.length === 0) return
    yield* this.openReasoning()
    this.#reasoning.parts.push(text)
    yield { type: 'reasoning-delta', index: this.#reasoning.index, text }
  }

  *closeReasoning() {
    const open = this.#reasoning
    if (open === undefined) return
    this.#reasoning = undefined
    yield {
      type: 'block-end',
      index: open.index,
      block: { type: 'reasoning', text: open.parts.join('') }
    }
  }

  /**
   * Feed one tool-call delta.
   *
   * @param {string | number} key - Upstream shard identity (`tool_calls[].index` or a Responses item id).
   * @param {{ id?: string, name?: string, arguments?: string }} delta
   */
  *pushToolCall(key, delta) {
    this.sawToolCall = true
    let entry = this.#tools.get(key)
    if (entry === undefined) {
      // Once tool calls begin, text and reasoning are done.
      yield* this.closeReasoning()
      yield* this.closeText()
      entry = { index: this.#nextIndex++, id: '', name: '', args: [] }
      this.#tools.set(key, entry)
      this.#toolOrder.push(key)
      yield { type: 'block-start', index: entry.index, blockType: 'tool-call' }
    }
    if (typeof delta.id === 'string' && delta.id.length > 0) entry.id = delta.id
    if (typeof delta.name === 'string' && delta.name.length > 0) entry.name = delta.name

    const args = typeof delta.arguments === 'string' ? delta.arguments : ''
    if (args.length > 0) entry.args.push(args)
    if (args.length > 0 || typeof delta.name === 'string') {
      yield {
        type: 'tool-call-delta',
        index: entry.index,
        id: entry.id,
        ...(entry.name.length > 0 ? { name: entry.name } : {}),
        argumentsDelta: args
      }
    }
  }

  /** Close every open block and emit the assembled tool calls. */
  *closeAll() {
    yield* this.closeReasoning()
    yield* this.closeText()
    const aliases = this.aliasMap?.() ?? null
    for (const key of this.#toolOrder) {
      const entry = this.#tools.get(key)
      if (entry === undefined) continue
      // Restore the caller's own tool spelling: a name moved to `<key>_client`
      // to satisfy the fingerprint gate must come back as what the harness
      // actually declared, or it will not find a handler for the call.
      const name = aliases !== null && aliases.has(entry.name) ? aliases.get(entry.name) : entry.name
      yield {
        type: 'block-end',
        index: entry.index,
        block: { type: 'tool-call', id: entry.id, name, arguments: entry.args.join('') }
      }
    }
  }

  *emitUsage() {
    if (this.usage === undefined || this.usage === null) return
    yield { type: 'usage', usage: this.usage }
  }
}

/**
 * Convert upstream usage into the harness's disjoint accounting.
 *
 * `prompt_tokens` on OpenAI-shaped gateways folds cache hits into itself, and
 * DeepSeek-family gateways spell the same fact `prompt_cache_hit_tokens`. Both
 * are subtracted so a cached turn is not billed twice in the token meter.
 *
 * @param {any} usage
 * @returns {{ inputTokens: number, outputTokens: number, totalTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, reasoningTokens?: number }}
 */
export function toTokenUsage(usage) {
  const prompt = numberOr(usage?.prompt_tokens, numberOr(usage?.input_tokens, 0))
  const output = numberOr(usage?.completion_tokens, numberOr(usage?.output_tokens, 0))
  const cached = numberOr(
    usage?.prompt_cache_hit_tokens,
    numberOr(usage?.prompt_tokens_details?.cached_tokens, numberOr(usage?.cache_read_input_tokens, 0))
  )
  const cacheWrite = numberOr(usage?.cache_creation_input_tokens, undefined)
  const reasoning = numberOr(usage?.completion_tokens_details?.reasoning_tokens, undefined)
  const total = numberOr(usage?.total_tokens, undefined)
  return {
    inputTokens: Math.max(prompt - cached, 0),
    outputTokens: output,
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(cacheWrite === undefined || cacheWrite <= 0 ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning })
  }
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Map an upstream finish/stop reason onto the harness vocabulary.
 *
 * @param {string | null | undefined} reason
 * @param {boolean} sawToolCall - Fallback when upstream omits the reason, which
 *   several gateways do on the tool-call frame.
 */
export function toFinishKind(reason, sawToolCall) {
  switch (String(reason ?? '').toLowerCase()) {
    case 'tool_calls':
    case 'tool_use':
      return 'tool-calls'
    case 'length':
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max-tokens'
    case 'content_filter':
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
      return sawToolCall ? 'tool-calls' : 'stop'
    default:
      return sawToolCall ? 'tool-calls' : 'stop'
  }
}

/**
 * Consume the OpenAI Chat Completions lane.
 *
 * @param {any} body
 * @param {{ aliasMap?: () => Map<string, string> | null }} [options]
 * @returns {AsyncGenerator<any>}
 */
export async function* consumeChat(body, options = {}) {
  const state = new BlockEmitter(options.aliasMap)
  let finish

  for await (const payload of ssePayloads(body)) {
    let event
    try {
      event = JSON.parse(payload)
    } catch {
      // One bad frame must not fail the turn: keep-alive text and truncated
      // frames land here.
      continue
    }
    if (event?.error) throw upstreamError(event.error)
    if (event?.usage != null) state.usage = toTokenUsage(event.usage)

    const choice = event?.choices?.[0]
    if (choice === undefined) continue
    if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
      finish = choice.finish_reason
    }
    const delta = choice.delta
    if (delta === undefined || delta === null) continue

    // Vendors disagree on the reasoning field name: DeepSeek-family uses
    // `reasoning_content`, the free lane's MiMo route (OpenRouter-backed) streams
    // `reasoning` plus `reasoning_details[]`. Read whichever carries a value.
    const reasoning = delta.reasoning_content ?? delta.reasoning ?? firstReasoningDetail(delta)
    yield* state.pushReasoning(reasoning)
    yield* state.pushText(typeof delta.content === 'string' ? delta.content : '')

    for (const call of delta.tool_calls ?? []) {
      if (call === null || typeof call !== 'object') continue
      const key = typeof call.index === 'number' ? call.index : state.sawToolCall ? 'auto' : 0
      yield* state.pushToolCall(key, {
        id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments
      })
    }
  }

  yield* state.closeAll()
  yield* state.emitUsage()
  yield { type: 'finish', reason: { kind: toFinishKind(finish, state.sawToolCall) } }
}

/** The free lane's MiMo route can stream thinking as `reasoning_details[].text`. */
function firstReasoningDetail(delta) {
  const details = delta?.reasoning_details
  if (!Array.isArray(details)) return undefined
  for (const detail of details) {
    if (typeof detail?.text === 'string' && detail.text.length > 0) return detail.text
  }
  return undefined
}

/**
 * Consume the OpenAI Responses lane (`muse-spark-*` and the gpt/grok families).
 *
 * Responses types every event rather than shipping a flat delta, so this reads
 * the event name and ignores the ones that carry nothing model-visible.
 *
 * @param {any} body
 * @param {{ aliasMap?: () => Map<string, string> | null }} [options]
 * @returns {AsyncGenerator<any>}
 */
export async function* consumeResponses(body, options = {}) {
  const state = new BlockEmitter(options.aliasMap)
  let finish
  /** item id -> tool call shard key */
  const items = new Map()

  for await (const payload of ssePayloads(body)) {
    let event
    try {
      event = JSON.parse(payload)
    } catch {
      continue
    }
    if (event?.error) throw upstreamError(event.error)
    const type = String(event?.type ?? '')

    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      const response = event.response
      if (response?.usage != null) state.usage = toTokenUsage(responsesUsage(response.usage))
      finish = response?.status === 'incomplete' ? 'max_tokens' : response?.incomplete_details?.reason
      continue
    }
    if (type === 'response.output_text.delta') {
      yield* state.pushText(typeof event.delta === 'string' ? event.delta : '')
      continue
    }
    if (type === 'response.reasoning_text.delta') {
      yield* state.pushReasoning(typeof event.delta === 'string' ? event.delta : '')
      continue
    }
    if (type === 'response.reasoning_summary_text.delta') {
      yield* state.pushReasoning(typeof event.delta === 'string' ? event.delta : '')
      continue
    }
    if (type === 'response.output_item.added') {
      const item = event.item
      if (item?.type !== 'function_call') continue
      items.set(item.id ?? `item-${items.size}`, item.id ?? `item-${items.size}`)
      yield* state.pushToolCall(item.id ?? `item-${items.size}`, {
        id: item.call_id ?? item.id,
        name: item.name,
        arguments: ''
      })
      continue
    }
    if (type === 'response.function_call_arguments.delta') {
      const key = event.item_id ?? event.output_index ?? 'auto'
      yield* state.pushToolCall(key, { arguments: typeof event.delta === 'string' ? event.delta : '' })
      continue
    }
    if (type === 'response.function_call_arguments.done') {
      // The `done` frame repeats the whole argument string; emitting it again
      // would double every tool argument, so it is read for nothing.
      continue
    }
  }

  yield* state.closeAll()
  yield* state.emitUsage()
  yield { type: 'finish', reason: { kind: toFinishKind(finish, state.sawToolCall) } }
}

/** Responses names its usage fields after input/output rather than prompt/completion. */
function responsesUsage(usage) {
  return {
    prompt_tokens: usage?.input_tokens,
    completion_tokens: usage?.output_tokens,
    total_tokens: usage?.total_tokens,
    prompt_tokens_details: { cached_tokens: usage?.input_tokens_details?.cached_tokens },
    completion_tokens_details: { reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens }
  }
}

/**
 * Consume the Anthropic Messages lane (`union-alpha`, `claude-*`).
 *
 * @param {any} body
 * @param {{ aliasMap?: () => Map<string, string> | null }} [options]
 * @returns {AsyncGenerator<any>}
 */
export async function* consumeMessages(body, options = {}) {
  const state = new BlockEmitter(options.aliasMap)
  let finish
  /** Anthropic block index -> tool shard key */
  const blocks = new Map()

  for await (const payload of ssePayloads(body)) {
    let event
    try {
      event = JSON.parse(payload)
    } catch {
      continue
    }
    if (event?.type === 'error') throw upstreamError(event.error ?? event)
    const type = String(event?.type ?? '')

    if (type === 'message_start') {
      // Anthropic reports input tokens up front and output tokens at the end;
      // both land in one harness usage chunk at the terminal frame.
      if (event.message?.usage != null) state.usage = toTokenUsage(event.message.usage)
      continue
    }
    if (type === 'content_block_start') {
      const block = event.content_block
      if (block?.type !== 'tool_use') continue
      blocks.set(event.index, event.index)
      yield* state.pushToolCall(event.index, { id: block.id, name: block.name, arguments: '' })
      continue
    }
    if (type === 'content_block_delta') {
      const delta = event.delta
      if (delta?.type === 'text_delta') yield* state.pushText(delta.text)
      else if (delta?.type === 'thinking_delta') yield* state.pushReasoning(delta.thinking)
      else if (delta?.type === 'input_json_delta') {
        yield* state.pushToolCall(event.index, { arguments: delta.partial_json })
      }
      continue
    }
    if (type === 'message_delta') {
      if (event.usage != null) {
        const base = state.usage ?? { inputTokens: 0, outputTokens: 0 }
        state.usage = {
          ...base,
          outputTokens: numberOr(event.usage.output_tokens, base.outputTokens),
          ...(typeof event.usage.input_tokens === 'number'
            ? { inputTokens: event.usage.input_tokens }
            : {})
        }
      }
      if (typeof event.delta?.stop_reason === 'string') finish = event.delta.stop_reason
      continue
    }
  }

  yield* state.closeAll()
  yield* state.emitUsage()
  yield { type: 'finish', reason: { kind: toFinishKind(finish, state.sawToolCall) } }
}

/**
 * Turn an upstream error envelope into something an adapter can classify.
 *
 * The two free-lane failures matter most, because they read like quota problems
 * but are actually fingerprint problems: `FreeTierError` means the request did
 * not look like OpenCode, and `FreeUsageLimitError` means the shape was accepted
 * and the shared quota is exhausted — or, when it arrives on a request whose
 * shape is known-good, that the TLS fingerprint did not match.
 *
 * @param {any} error
 * @returns {Error & { upstreamType?: string, upstreamStatus?: number }}
 */
export function upstreamError(error) {
  const type = typeof error?.type === 'string' ? error.type : undefined
  const message =
    error?.message ?? error?.error?.message ?? JSON.stringify(error ?? {}).slice(0, 500)
  const failure = new Error(`opencode: ${type !== undefined ? `${type}: ` : ''}${message}`)
  if (type !== undefined) failure.upstreamType = type
  if (typeof error?.status === 'number') failure.upstreamStatus = error.status
  return failure
}

/** Re-exported for adapters that classify a whole response body. */
export { restoreToolNames }
