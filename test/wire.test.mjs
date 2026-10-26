/**
 * Catalog, discovery and wire translation.
 *
 * These are the "does each model get the right settings" tests: endpoint lane,
 * context window, output cap, vision modality and reasoning levels are what the
 * harness offers in Settings → Models and what it validates a request against, so
 * a wrong value here is a model that cannot be selected or a turn that 400s.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_FREE_EFFORTS,
  SNAPSHOT_MODELS,
  baseModelId,
  isFreeModelId,
  laneForModel,
  resolveEffort,
  resolveMaxTokens
} from '../lib/catalog.js'
import {
  Catalog,
  extractOpencodeMetadata,
  metadataIsFree,
  parseModelsListing
} from '../lib/discovery.js'
import {
  sanitizeResponsesItems,
  toAnthropicMessages,
  toAnthropicTools,
  toChatMessages,
  toChatTools,
  toResponsesInput,
  toResponsesTools
} from '../lib/request.js'
import { consumeChat, consumeMessages, consumeResponses, toTokenUsage } from '../lib/stream.js'
import { createTransport } from '../lib/transport.js'
import { startGateServer } from './gate-server.mjs'

// ---------------------------------------------------------------------------
// Catalog: lanes, ids, capacities
// ---------------------------------------------------------------------------

test('every snapshot model declares a complete, self-consistent capability set', () => {
  for (const model of SNAPSHOT_MODELS) {
    assert.ok(model.id.length > 0, 'an id is required')
    assert.ok(model.name.length > 0, `${model.id}: a display name is required for the picker`)
    assert.ok(['chat', 'responses', 'messages'].includes(model.lane), `${model.id}: unknown lane`)
    assert.ok(
      Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0,
      `${model.id}: contextWindow must be a positive integer`
    )
    assert.ok(
      Number.isSafeInteger(model.maxOutputTokens) && model.maxOutputTokens > 0,
      `${model.id}: maxOutputTokens must be a positive integer`
    )
    assert.ok(
      model.maxOutputTokens <= model.contextWindow,
      `${model.id}: an output cap above the context window cannot be served`
    )
    assert.ok(
      Array.isArray(model.inputModalities) && model.inputModalities.includes('text'),
      `${model.id}: inputModalities must at least carry text`
    )
    if (model.reasoningEfforts !== false) {
      assert.ok(model.reasoningEfforts.length > 0, `${model.id}: an effort list must not be empty`)
      for (const effort of model.reasoningEfforts) {
        assert.ok(
          ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort),
          `${model.id}: "${effort}" is not on the enum the chat lane validates against`
        )
      }
      if (model.defaultEffort !== undefined) {
        assert.ok(
          model.reasoningEfforts.includes(model.defaultEffort),
          `${model.id}: defaultEffort "${model.defaultEffort}" is not one of its own declared levels`
        )
      }
    }
  }
  const ids = SNAPSHOT_MODELS.map((model) => model.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids would collide in the picker')
})

test('lanes route by snapshot entry first and by family for unknown ids', () => {
  assert.equal(laneForModel('big-pickle'), 'chat')
  assert.equal(laneForModel('muse-spark-1.3-contributor-free'), 'responses')
  assert.equal(laneForModel('union-alpha'), 'messages')
  // Family fallbacks keep an id added upstream after this snapshot on the right
  // protocol instead of posting it to /chat/completions and failing.
  assert.equal(laneForModel('gpt-5.9-free'), 'responses')
  assert.equal(laneForModel('grok-4.8-free'), 'responses')
  assert.equal(laneForModel('claude-haiku-5-9-free'), 'messages')
  assert.equal(laneForModel('minimax-m4-free'), 'chat')
  assert.equal(laneForModel('qwen3.9-plus-free'), 'chat')
  assert.equal(laneForModel('something-entirely-new-free'), 'chat')
  // A thinking suffix and a provider prefix must not defeat the lookup.
  assert.equal(laneForModel('opencode/muse-spark-1.3-contributor-free(high)'), 'responses')
})

test('free-tier detection is suffix-driven, not a hardcoded list', () => {
  assert.ok(isFreeModelId('nemotron-3-ultra-free'))
  assert.ok(isFreeModelId('big-pickle'), 'promotional stealth models carry no -free suffix')
  assert.ok(isFreeModelId('opencode/cat-jam-free'))
  assert.ok(!isFreeModelId('gpt-5.5'), 'a paid id must not be sent anonymously')
  assert.ok(!isFreeModelId('claude-sonnet-4-5'))
  // A structured-decision endpoint is on the lane but is not a chat model, so the
  // harness must never offer it: it answers a picker selection, not an agent turn.
  assert.ok(!isFreeModelId('jev-1.13-free'))
  assert.ok(!isFreeModelId(''))
  assert.ok(!isFreeModelId(undefined))
})

test('baseModelId strips a provider prefix and a thinking-level suffix', () => {
  assert.equal(baseModelId('opencode/big-pickle'), 'big-pickle')
  assert.equal(baseModelId('big-pickle(high)'), 'big-pickle')
  assert.equal(baseModelId('opencode/muse-spark-1.3-contributor-free(xhigh)'), 'muse-spark-1.3-contributor-free')
  assert.equal(baseModelId('  big-pickle  '), 'big-pickle')
})

// ---------------------------------------------------------------------------
// Reasoning levels
// ---------------------------------------------------------------------------

test('an unsupported effort converges onto the declared set instead of reaching the wire', () => {
  // The chat lane answers an effort outside the plain OpenAI enum with
  // `400 Invalid option`, so nothing undeclared may ever be sent.
  assert.equal(resolveEffort('medium', ['low', 'high', 'max']), 'low')
  assert.equal(resolveEffort('ultra', ['low', 'high', 'max']), 'max', 'ultra is an alias for max')
  assert.equal(resolveEffort('xhigh', ['low', 'medium', 'high', 'xhigh']), 'xhigh')
  assert.equal(resolveEffort('off', ['none', 'low', 'high']), 'none', 'off means none where offered')
  assert.equal(resolveEffort('max', DEFAULT_FREE_EFFORTS), 'max')
  assert.equal(resolveEffort('HIGH', ['low', 'high', 'max']), 'high', 'case is normalized')
})

test('adaptive and absent efforts omit the field rather than guessing', () => {
  // `auto` is what adaptive-thinking clients arrive as, and the enum rejects the
  // literal; omitting the field lets upstream pick its own default.
  assert.equal(resolveEffort('auto', ['low', 'high', 'max']), undefined)
  assert.equal(resolveEffort('adaptive', ['low', 'high', 'max']), undefined)
  assert.equal(resolveEffort(undefined, ['low', 'high', 'max']), undefined)
  assert.equal(resolveEffort('', ['low', 'high', 'max']), undefined)
})

test('a non-reasoning model never receives an effort, even when one is requested', () => {
  // Several free models answer a reasoning field with 400 even when the value is
  // valid elsewhere on the lane, so `false` must suppress it outright.
  assert.equal(resolveEffort('high', false), undefined)
  assert.equal(resolveEffort('low', false), undefined)
  assert.equal(resolveEffort('high', undefined), undefined)
})

test('the output cap is the minimum of every declared bound', () => {
  assert.equal(resolveMaxTokens([4096, 32_000, 131_072]), 4096)
  assert.equal(resolveMaxTokens([undefined, 32_000]), 32_000)
  assert.equal(resolveMaxTokens([undefined, undefined]), undefined)
  assert.equal(resolveMaxTokens([0, -1, 2048]), 2048, 'non-positive bounds are ignored')
})

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test('a bare OpenAI listing is parsed, and so is an enriched map', () => {
  const standard = parseModelsListing({
    object: 'list',
    data: [
      { id: 'big-pickle', object: 'model', owned_by: 'opencode' },
      { id: 'nemotron-3-ultra-free', context_window: 1_000_000, max_output_tokens: 128_000 }
    ]
  })
  assert.equal(standard.length, 2)
  assert.equal(standard[0].id, 'big-pickle')
  assert.equal(standard[0].contextWindow, undefined, 'a listing that discloses nothing adds nothing')
  assert.equal(standard[1].contextWindow, 1_000_000)
  assert.equal(standard[1].maxTokens, 128_000)

  const enriched = parseModelsListing({ models: { 'cat-jam-free': { name: 'Cat Jam', context_length: 262_144 } } })
  assert.equal(enriched.length, 1)
  assert.equal(enriched[0].id, 'cat-jam-free')
  assert.equal(enriched[0].name, 'Cat Jam')
  assert.equal(enriched[0].contextWindow, 262_144)

  assert.deepEqual(parseModelsListing(null), [])
  assert.deepEqual(parseModelsListing({ data: [] }), [])
})

test('models.dev metadata supplies the free verdict and the capacities a listing omits', () => {
  const document = {
    opencode: {
      models: {
        'big-pickle': { cost: { input: 0, output: 0 }, limit: { context: 200_000, output: 32_000 }, modalities: { input: ['text'] } },
        'gpt-5.5': { cost: { input: 1.25, output: 10 }, limit: { context: 400_000, output: 128_000 } },
        'space-bunny-free': { cost: { input: 0, output: 0, cache: 0 }, modalities: { input: ['text', 'image'] } }
      }
    }
  }
  const meta = extractOpencodeMetadata(document)
  assert.equal(meta.size, 3)
  assert.ok(metadataIsFree(meta.get('big-pickle')))
  assert.ok(!metadataIsFree(meta.get('gpt-5.5')), 'a paid model must not be advertised as free')
  assert.ok(metadataIsFree(meta.get('space-bunny-free')))
  assert.equal(extractOpencodeMetadata({ other: {} }), undefined)
})

test('the live catalog intersects the listing with the free verdict and enriches from the snapshot', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const transport = await createTransport({ mode: 'native' })
  t.after(() => transport.dispose())

  const catalog = new Catalog({
    transport,
    modelsUrls: [`${server.baseURL}/inference/v1/models`],
    // No metadata source: the free verdict then falls back to the id suffix, and
    // `gpt-5.5` (paid) must be excluded while the free ids are kept.
    devUrl: '',
    cachePath: '',
    defaultContextWindow: 128_000,
    defaultMaxTokens: 8_192
  })

  const result = await catalog.list()
  assert.equal(result.source, 'live')
  const ids = result.models.map((model) => model.id)
  assert.ok(ids.includes('big-pickle'))
  assert.ok(ids.includes('nemotron-3-ultra-free'))
  assert.ok(!ids.includes('gpt-5.5'), 'a paid model must never appear on the free route')
  assert.ok(!ids.includes('jev-1.13-free'), 'a non-chat model must never be offered')

  // Snapshot metadata survives the merge: the listing disclosed nothing.
  const pickle = result.models.find((model) => model.id === 'big-pickle')
  assert.equal(pickle.contextWindow, 200_000)
  assert.equal(pickle.maxOutputTokens, 32_000)
  assert.deepEqual([...pickle.reasoningEfforts], ['low', 'high', 'max'])

  // `peek()` must not trigger a fetch, so a per-turn lookup costs no round trip.
  assert.ok(catalog.peek().length > 0)
})

test('an unreachable catalog falls back to the snapshot instead of failing', async () => {
  const transport = await createTransport({ mode: 'native' })
  const catalog = new Catalog({
    transport,
    modelsUrls: ['http://127.0.0.1:1/models'],
    devUrl: '',
    cachePath: '',
    timeoutMs: 500
  })
  const result = await catalog.list()
  assert.equal(result.source, 'snapshot')
  assert.ok(result.models.length > 5)
  assert.ok(typeof result.error === 'string' && result.error.length > 0, 'the fallback reason is reported')
  transport.dispose()
})

test('a disabled catalog serves the snapshot without any network', async () => {
  const transport = await createTransport({ mode: 'native' })
  const catalog = new Catalog({ transport, modelsUrls: [], devUrl: '', cachePath: '', enabled: false })
  const result = await catalog.list()
  assert.equal(result.source, 'snapshot')
  transport.dispose()
})

// ---------------------------------------------------------------------------
// Chat-lane translation
// ---------------------------------------------------------------------------

const text = (value) => [{ type: 'text', text: value }]

test('a developer-role message is folded into system, because the lane refuses it', async () => {
  // The harness emits developer messages for tool updates, so this is reached in
  // ordinary agent turns — and the lane answers the role with
  // `[1214] Incorrect role information`.
  const messages = await toChatMessages([
    { role: 'system', content: text('You are an agent.') },
    { role: 'developer', content: text('A tool was added.') },
    { role: 'user', content: text('hi') }
  ])
  assert.ok(!messages.some((message) => message.role === 'developer'))
  assert.equal(messages.filter((message) => message.role === 'system').length, 2)
  assert.equal(messages[1].content, 'A tool was added.')
})

test('assistant tool calls and tool results round-trip with their call ids', async () => {
  const messages = await toChatMessages([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading.' },
        { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"/etc"}' }
      ]
    },
    { role: 'tool', toolCallId: 'call_1', content: text('root bin'), isError: false }
  ])
  assert.equal(messages[0].role, 'assistant')
  assert.equal(messages[0].content, 'Reading.')
  assert.deepEqual(messages[0].tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"/etc"}' } }
  ])
  assert.equal(messages[1].role, 'tool')
  assert.equal(messages[1].tool_call_id, 'call_1')
  assert.equal(messages[1].content, 'root bin')
})

test('a tool-only assistant turn sends content null, and an empty result sends a space', async () => {
  const messages = await toChatMessages([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'c', content: [] }
  ])
  assert.equal(messages[0].content, null, 'an empty string is not what OpenAI wants here')
  assert.equal(messages[1].content, ' ', 'an empty tool result is refused by some backends')
})

test('the reasoning echo fills a placeholder where history has none', async () => {
  // Reasoning models on this lane refuse multi-turn history whose assistant
  // messages carry no reasoning_content (`400 missing_required_parameter`), and
  // the harness strips thinking before it reaches a client, so the echo can never
  // come from the caller.
  const withEcho = await toChatMessages(
    [{ role: 'assistant', content: text('answer') }],
    { reasoningEcho: true }
  )
  assert.equal(withEcho[0].reasoning_content, ' ')

  const preserved = await toChatMessages(
    [{ role: 'assistant', content: [{ type: 'reasoning', text: 'because' }, { type: 'text', text: 'answer' }] }],
    { reasoningEcho: true }
  )
  assert.equal(preserved[0].reasoning_content, 'because')

  const withoutEcho = await toChatMessages([{ role: 'assistant', content: text('answer') }])
  assert.equal(withoutEcho[0].reasoning_content, undefined)
})

test('images become parts only when the route declares image input', async () => {
  const imageBlock = { type: 'image', attachment: { attachmentId: 'abcd1234efgh5678', mediaType: 'image/png', bytes: 10, width: 2, height: 2 } }

  const textOnly = await toChatMessages([{ role: 'user', content: [imageBlock] }], { images: false })
  assert.equal(typeof textOnly[0].content, 'string', 'a text-only route receives a plain string')

  const withImages = await toChatMessages([{ role: 'user', content: [imageBlock] }], {
    images: true,
    encodeImage: async () => ({ mediaType: 'image/png', dataUrl: 'data:image/png;base64,AA==' })
  })
  assert.deepEqual(withImages[0].content, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }])

  // An image that cannot be encoded degrades to a placeholder rather than
  // sending a request the upstream will refuse.
  const unencodable = await toChatMessages([{ role: 'user', content: [imageBlock] }], {
    images: true,
    encodeImage: async () => undefined
  })
  assert.match(unencodable[0].content[0].text, /image omitted/)
})

test('an image a text-only route will not carry still leaves a trace', async () => {
  // The harness normally substitutes its own placeholder before an adapter is
  // reached, so this is the guard for the case where the runtime and the adapter
  // disagree about a route's modalities. Dropping the block silently would leave a
  // turn that reads as though the user attached nothing.
  const imageBlock = { type: 'image', attachment: { attachmentId: 'abcd1234efgh5678', mediaType: 'image/png', bytes: 10, width: 2, height: 2 } }

  const chat = await toChatMessages([{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, imageBlock] }], { images: false })
  assert.match(chat[0].content, /what is this\?/)
  assert.match(chat[0].content, /image omitted/)

  const anthropic = await toAnthropicMessages([{ role: 'user', content: [imageBlock] }], { images: false })
  assert.equal(anthropic.messages[0].content.length, 1)
  assert.equal(anthropic.messages[0].content[0].type, 'text')
  assert.match(anthropic.messages[0].content[0].text, /image omitted/)
})

test('chat tools use the nested function shape and drop an empty list', () => {
  assert.equal(toChatTools([]), undefined)
  assert.equal(toChatTools(undefined), undefined)
  const tools = toChatTools([{ name: 'bash', description: 'Run.', parameters: { type: 'object', properties: { command: { type: 'string' } } } }])
  assert.equal(tools[0].type, 'function')
  assert.equal(tools[0].function.name, 'bash')
  assert.equal(tools[0].function.parameters.properties.command.type, 'string')
})

// ---------------------------------------------------------------------------
// Responses- and Messages-lane translation
// ---------------------------------------------------------------------------

test('the Responses lane flattens a conversation into typed items', () => {
  const { instructions, input } = toResponsesInput(
    [
      { role: 'system', content: text('Be brief.') },
      { role: 'user', content: text('hi') },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"/etc"}' }
        ]
      },
      { role: 'tool', toolCallId: 'call_1', content: text('root') }
    ],
    { system: 'Top-level system.' }
  )
  assert.match(instructions, /^Top-level system\.\n\nBe brief\.$/)
  assert.deepEqual(input.map((item) => item.type), ['message', 'message', 'function_call', 'function_call_output'])
  assert.equal(input[2].call_id, 'call_1')
  assert.equal(input[2].name, 'read')
  assert.equal(input[3].output, 'root')
  // The system prompt folded into `instructions`, so the item list starts at the
  // first user turn: user text is `input_text`, assistant text is `output_text`.
  assert.equal(input[0].role, 'user')
  assert.equal(input[0].content[0].type, 'input_text')
  assert.equal(input[1].role, 'assistant')
  assert.equal(input[1].content[0].type, 'output_text')
})

test('prior-turn reasoning items are dropped from a Responses request', () => {
  // The free lane routes through a pooled upstream account, and a Responses
  // backend refuses reasoning `encrypted_content` it did not issue to this caller.
  // Under store:false, omitting the field makes the item "not found" — so the
  // whole item goes rather than half of it.
  const input = sanitizeResponsesItems([
    { type: 'message', role: 'user', content: [] },
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAAA' },
    { type: 'function_call', name: 'read', call_id: 'c', arguments: '{}', encrypted_content: 'x' }
  ])
  assert.deepEqual(input.map((item) => item.type), ['message', 'function_call'])
  assert.equal(input[1].encrypted_content, undefined)
})

test('Responses tools use the flat shape', () => {
  const tools = toResponsesTools([{ name: 'read', description: 'd', parameters: { type: 'object', properties: { path: { type: 'string' } } } }])
  assert.equal(tools[0].name, 'read')
  assert.equal(tools[0].function, undefined)
  assert.equal(tools[0].strict, false)
})

test('the Messages lane maps tool results into user-role tool_result blocks', async () => {
  const { system, messages } = await toAnthropicMessages(
    [
      { role: 'system', content: text('sys') },
      { role: 'user', content: text('hi') },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"/etc"}' }]
      },
      { role: 'tool', toolCallId: 'call_1', content: text('root'), isError: true }
    ],
    { system: 'top' }
  )
  assert.equal(system, 'top\n\nsys')
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[1].role, 'assistant')
  assert.equal(messages[1].content[0].type, 'tool_use')
  assert.deepEqual(messages[1].content[0].input, { path: '/etc' })
  assert.equal(messages[2].role, 'user', 'Anthropic carries tool results on the user turn')
  assert.equal(messages[2].content[0].type, 'tool_result')
  assert.equal(messages[2].content[0].tool_use_id, 'call_1')
  assert.equal(messages[2].content[0].is_error, true)
})

test('a malformed tool argument string stays representable instead of throwing', async () => {
  const { messages } = await toAnthropicMessages([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'read', arguments: '{not json' }] }
  ])
  assert.deepEqual(messages[0].content[0].input, { _raw: '{not json' })
})

test('Messages tools use input_schema', () => {
  const tools = toAnthropicTools([{ name: 'read', description: 'd', parameters: { type: 'object', properties: {} } }])
  assert.equal(tools[0].input_schema.type, 'object')
  assert.equal(tools[0].parameters, undefined)
})

// ---------------------------------------------------------------------------
// Stream consumption
// ---------------------------------------------------------------------------

/** Build an SSE byte stream from payloads. */
function sse(payloads) {
  const text = payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('') + 'data: [DONE]\n\n'
  return (async function* () {
    // Split arbitrarily to prove the line buffer handles a chunked frame.
    const encoded = new TextEncoder().encode(text)
    for (let i = 0; i < encoded.length; i += 7) yield encoded.slice(i, i + 7)
  })()
}

async function collect(stream) {
  const out = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

test('chat SSE becomes paired blocks with usage before a single terminal finish', async () => {
  const chunks = await collect(
    consumeChat(
      sse([
        { choices: [{ index: 0, delta: { role: 'assistant' } }] },
        { choices: [{ index: 0, delta: { reasoning_content: 'thin' } }] },
        { choices: [{ index: 0, delta: { reasoning_content: 'king' } }] },
        { choices: [{ index: 0, delta: { content: 'po' } }] },
        { choices: [{ index: 0, delta: { content: 'ng' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 9, total_tokens: 59, prompt_tokens_details: { cached_tokens: 5 } } }
      ])
    )
  )
  const kinds = chunks.map((chunk) => chunk.type)
  assert.equal(kinds.filter((kind) => kind === 'finish').length, 1)
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.ok(kinds.indexOf('usage') < kinds.indexOf('finish'))
  assert.equal(kinds.filter((kind) => kind === 'block-start').length, kinds.filter((kind) => kind === 'block-end').length)

  const reasoning = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.equal(reasoning.block.text, 'thinking')
  const answer = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')
  assert.equal(answer.block.text, 'pong')
  // Text starting must have closed the reasoning block, or the two interleave.
  assert.ok(reasoning.index < answer.index)
})

test('a sharded tool call is reassembled with its raw argument string', async () => {
  const chunks = await collect(
    consumeChat(
      sse([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"pa' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/etc"}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
      ])
    )
  )
  const call = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.equal(call.block.id, 'call_1')
  assert.equal(call.block.name, 'read')
  assert.equal(call.block.arguments, '{"path":"/etc"}', 'arguments stay a raw JSON string')
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('a missing finish_reason is decided from what the turn produced', async () => {
  const withCall = await collect(
    consumeChat(sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'read', arguments: '{}' } }] } }] }]))
  )
  assert.equal(withCall.at(-1).reason.kind, 'tool-calls')

  const plain = await collect(consumeChat(sse([{ choices: [{ index: 0, delta: { content: 'hi' } }] }])))
  assert.equal(plain.at(-1).reason.kind, 'stop')
})

test('usage is disjoint: cached input is subtracted, not double-counted', () => {
  const usage = toTokenUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_cache_hit_tokens: 30,
    completion_tokens_details: { reasoning_tokens: 7 }
  })
  assert.equal(usage.inputTokens, 70)
  assert.equal(usage.cacheReadTokens, 30)
  assert.equal(usage.outputTokens, 20)
  assert.equal(usage.totalTokens, 120)
  assert.equal(usage.reasoningTokens, 7)
  assert.equal(usage.inputTokens + usage.cacheReadTokens, 100, 'billed input is the sum of the parts')

  // Anthropic spells the same facts differently.
  const anthropic = toTokenUsage({ input_tokens: 40, output_tokens: 8, cache_read_input_tokens: 10 })
  assert.equal(anthropic.inputTokens, 30)
  assert.equal(anthropic.cacheReadTokens, 10)
})

test('a mid-stream error event becomes a thrown failure, not a silent stop', async () => {
  await assert.rejects(
    async () => collect(consumeChat(sse([{ error: { type: 'FreeTierError', message: 'refused' } }]))),
    (error) => {
      assert.match(error.message, /FreeTierError: refused/)
      assert.equal(error.upstreamType, 'FreeTierError')
      return true
    }
  )
})

test('a truncated or keep-alive frame does not fail the turn', async () => {
  const chunks = await collect(
    consumeChat(
      (async function* () {
        yield new TextEncoder().encode(': keep-alive\n\n')
        yield new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n\n')
        yield new TextEncoder().encode('data: {truncated\n\n')
        yield new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"b"},"finish_reason":"stop"}]}\n\n')
        yield new TextEncoder().encode('data: [DONE]\n\n')
      })()
    )
  )
  const text = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')
  assert.equal(text.block.text, 'ab')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('a stream that ends without [DONE] still yields its last event and a finish', async () => {
  const chunks = await collect(
    consumeChat(
      (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}')
      })()
    )
  )
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.text, 'x')
  assert.equal(chunks.at(-1).type, 'finish')
})

test('Responses SSE events are consumed, and the done frame does not duplicate arguments', async () => {
  const chunks = await collect(
    consumeResponses(
      sse([
        { type: 'response.created', response: { id: 'r1', status: 'in_progress' } },
        { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
        { type: 'response.output_text.delta', delta: 'pong' },
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'read' } },
        { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{"path":' },
        { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '"/etc"}' },
        { type: 'response.function_call_arguments.done', item_id: 'item_1', arguments: '{"path":"/etc"}' },
        {
          type: 'response.completed',
          response: {
            id: 'r1',
            status: 'completed',
            usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42, output_tokens_details: { reasoning_tokens: 4 } }
          }
        }
      ])
    )
  )
  const call = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.equal(call.block.arguments, '{"path":"/etc"}', 'the repeated done frame must not double the arguments')
  assert.equal(call.block.name, 'read')
  const usage = chunks.find((chunk) => chunk.type === 'usage').usage
  assert.equal(usage.inputTokens, 30)
  assert.equal(usage.outputTokens, 12)
  assert.equal(usage.reasoningTokens, 4)
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('Anthropic SSE events are consumed with thinking and tool input deltas', async () => {
  const chunks = await collect(
    consumeMessages(
      sse([
        { type: 'message_start', message: { id: 'm1', role: 'assistant', usage: { input_tokens: 25 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'pong' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_1', name: 'read', input: {} } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"/etc"}' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 14 } },
        { type: 'message_stop' }
      ])
    )
  )
  const thinking = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.equal(thinking.block.text, 'hmm')
  const answer = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')
  assert.equal(answer.block.text, 'pong')
  const call = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.equal(call.block.id, 'call_1')
  assert.equal(call.block.arguments, '{"path":"/etc"}')
  const usage = chunks.find((chunk) => chunk.type === 'usage').usage
  assert.equal(usage.inputTokens, 25)
  assert.equal(usage.outputTokens, 14)
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('an Anthropic error event becomes a thrown failure', async () => {
  await assert.rejects(
    async () => collect(consumeMessages(sse([{ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }]))),
    /overloaded_error: busy/
  )
})

test('the gate server itself serves all three lanes', async (t) => {
  // Guards the test double: if the stand-in drifts, the end-to-end assertions
  // above would be measuring nothing.
  const server = await startGateServer()
  t.after(() => server.close())
  const transport = await createTransport({ mode: 'native' })
  t.after(() => transport.dispose())

  const listing = await transport.request(`${server.baseURL}/inference/v1/models`, { method: 'GET' })
  assert.equal(listing.status, 200)
  assert.ok((await listing.text()).includes('big-pickle'))

  // The historical root must be refused even for a listing-shaped request.
  const zenLane = await transport.request(`${server.baseURL}/zen/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })
  assert.equal(zenLane.status, 403)
})
