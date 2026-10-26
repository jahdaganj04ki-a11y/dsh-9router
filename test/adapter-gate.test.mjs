/**
 * End-to-end: drive the real adapter against a server that enforces the real gate.
 *
 * This is the test that answers the question the plugin exists to answer — does a
 * request built by this adapter survive every check the free lane makes? The
 * server in `gate-server.mjs` refuses a request missing any one of them, with the
 * same status and error type the upstream uses, so a pass here is evidence rather
 * than intent.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenCodeFreeAdapter, endpointFor } from '../lib/adapter.js'
import { Catalog } from '../lib/discovery.js'
import { createTransport } from '../lib/transport.js'
import { resolveConfig } from '../lib/config.js'
import { startGateServer } from './gate-server.mjs'
import { mintSessionId } from '../lib/fingerprint.js'

/** Build an adapter pointed at the local gate server. */
async function makeAdapter(server, overrides = {}) {
  const resolved = resolveConfig({
    baseURL: server.baseURL,
    apiKeyEnv: '',
    catalog: { enabled: false },
    ...overrides
  })
  const transport = await createTransport({ mode: 'native' })
  const catalog = new Catalog({ transport, modelsUrls: [], enabled: false })
  const adapter = new OpenCodeFreeAdapter({
    displayName: resolved.displayName,
    connection: () => ({
      baseURL: resolved.baseURL,
      defaultContextWindow: resolved.defaultContextWindow,
      defaultMaxTokens: resolved.defaultMaxTokens,
      fingerprint: resolved.fingerprint.enabled,
      fingerprintOptions: {
        userAgent: resolved.fingerprint.userAgent,
        client: resolved.fingerprint.client,
        project: resolved.fingerprint.project,
        tools: resolved.fingerprint.tools,
        envMarker: resolved.fingerprint.envMarker
      },
      vision: resolved.vision,
      reasoningEcho: resolved.reasoningEcho
    }),
    resolveApiKey: async () => undefined,
    catalog,
    transport,
    imageTarget: () => resolved.image
  })
  return { adapter, transport }
}

const userMessage = (text) => ({
  id: 'msg-1',
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' }
})

const systemMessage = (text) => ({
  id: 'msg-0',
  role: 'system',
  content: [{ type: 'text', text }],
  source: { kind: 'system-prompt' }
})

const assistantToolCall = () => ({
  id: 'msg-2',
  role: 'assistant',
  content: [
    { type: 'text', text: 'Let me look.' },
    { type: 'tool-call', id: 'call_prev', name: 'read', arguments: '{"path":"/tmp"}' }
  ],
  source: { kind: 'model', provider: 'opencode-free', model: 'big-pickle' }
})

const toolResult = () => ({
  id: 'msg-3',
  role: 'tool',
  toolCallId: 'call_prev',
  content: [{ type: 'text', text: 'ok' }],
  isError: false,
  source: { kind: 'tool', callId: 'call_prev' }
})

const agentTools = [
  { name: 'read', description: 'The harness read tool.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'bash', description: 'Run a command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'shell', description: 'The harness shell tool.', parameters: { type: 'object', properties: { command: { type: 'string' }, workdir: { type: 'string' } }, required: ['command'] } },
  { name: 'write_file', description: 'Write a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }
]

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('a full agent turn on the chat lane passes every gate', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const { adapter, transport } = await makeAdapter(server)
  t.after(() => transport.dispose())

  const chunks = await collect(
    adapter.stream({
      provider: 'opencode-free',
      model: 'big-pickle',
      messages: [systemMessage('You are an agent.'), userMessage('read /etc'), assistantToolCall(), toolResult(), userMessage('again')],
      tools: agentTools,
      // big-pickle declares low/high/max, so ask for a level it actually serves;
      // convergence of an undeclared level is asserted in its own test below.
      reasoningEffort: 'high',
      maxTokens: 4096,
      sessionId: 'sess-abc-123'
    })
  )

  assert.deepEqual(server.refusals, [], `the gate refused the request: ${JSON.stringify(server.refusals)}`)
  assert.equal(server.requests.length, 1)
  const request = server.requests[0]
  assert.equal(request.lane, 'chat')
  assert.equal(request.url, '/inference/v1/chat/completions')

  // The harness's own tool names survive: `read`/`shell` were normalized in place
  // rather than aliased, because their arguments can carry the official schema.
  const names = request.body.tools.map((tool) => tool.function.name).sort()
  assert.deepEqual(names, ['bash', 'read', 'shell', 'write_file'])
  assert.equal(request.body.reasoning_effort, 'high')
  assert.equal(request.body.max_tokens, 4096)
  assert.equal(request.body.max_completion_tokens, undefined)
  assert.equal(request.body.stream, true)
  assert.deepEqual(request.body.stream_options, { include_usage: true })
  // `developer` role is folded into `system`; the lane refuses it otherwise.
  assert.ok(!request.body.messages.some((message) => message.role === 'developer'))
  // The reasoning echo is present on the historical assistant turn.
  const assistant = request.body.messages.find((message) => message.role === 'assistant')
  assert.equal(typeof assistant.reasoning_content, 'string')
  assert.ok(assistant.reasoning_content.length > 0)
  assert.equal(assistant.tool_calls[0].function.name, 'read')

  // The stream is well-formed: paired blocks, usage before finish, one finish.
  const kinds = chunks.map((chunk) => chunk.type)
  assert.equal(kinds.filter((kind) => kind === 'finish').length, 1)
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  assert.ok(kinds.indexOf('usage') < kinds.indexOf('finish'), 'usage must precede finish')
  assert.equal(kinds.filter((kind) => kind === 'block-start').length, kinds.filter((kind) => kind === 'block-end').length)

  const text = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')
  assert.equal(text.block.text, 'pong')
  const reasoning = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.equal(reasoning.block.text, 'Thinking hard.')
  const toolCall = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.equal(toolCall.block.name, 'read')
  assert.equal(toolCall.block.arguments, '{"path":"/etc"}')

  // Disjoint token accounting: the 20 cached tokens are subtracted from input.
  const usage = chunks.find((chunk) => chunk.type === 'usage').usage
  assert.equal(usage.inputTokens, 100)
  assert.equal(usage.cacheReadTokens, 20)
  assert.equal(usage.outputTokens, 30)
  assert.equal(usage.totalTokens, 150)
})

test('the four session headers agree and no v1 header is sent', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const { adapter, transport } = await makeAdapter(server)
  t.after(() => transport.dispose())

  await collect(adapter.stream({ provider: 'opencode-free', model: 'big-pickle', messages: [userMessage('hi')] }))

  const headers = server.requests[0].headers
  const sessionHeaders = ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id']
  const values = sessionHeaders.map((name) => headers[name])
  assert.ok(values.every((value) => typeof value === 'string' && value.length > 0))
  assert.equal(new Set(values).size, 1, 'all four session headers must carry one value')
  assert.match(values[0], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(headers['x-opencode-request'], undefined, 'the v1-only header must not be sent')
  assert.equal(headers['x-opencode-client'], 'cli')
  assert.equal(headers.authorization, 'Bearer public')
  assert.equal(headers['user-agent'], 'opencode/latest/2.0.26/cli')
  assert.ok(!/deepseek[-_]harness/i.test(headers['user-agent']), 'the harness UA would 403 on this lane')
})

test('one conversation keeps one session, and a real OpenCode session is relayed', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const { adapter, transport } = await makeAdapter(server)
  t.after(() => transport.dispose())

  await collect(adapter.stream({ provider: 'opencode-free', model: 'big-pickle', messages: [userMessage('a')], sessionId: 'sess-1' }))
  await collect(adapter.stream({ provider: 'opencode-free', model: 'big-pickle', messages: [userMessage('b')], sessionId: 'sess-1' }))
  const [first, second] = server.requests.map((request) => request.headers['x-opencode-session'])
  assert.equal(first, second, 'a conversation must keep one session for quota and cache affinity')

  server.requests.length = 0
  // A genuine id arriving from a real OpenCode client is relayed untouched, which
  // keeps that client's cache affinity. It has to be genuinely minted: the gate
  // decodes the embedded timestamp, so a fabricated id of the right *shape* is
  // refused even though `isGateSessionId` accepts it.
  const genuine = mintSessionId()
  await collect(adapter.stream({ provider: 'opencode-free', model: 'big-pickle', messages: [userMessage('c')], sessionId: genuine }))
  assert.equal(server.requests[0].headers['x-opencode-session'], genuine)
  assert.deepEqual(server.refusals, [], JSON.stringify(server.refusals))
})

test('a Responses-lane model is routed to /responses with its own field names', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const { adapter, transport } = await makeAdapter(server)
  t.after(() => transport.dispose())

  await collect(
    adapter.stream({
      provider: 'opencode-free',
      model: 'muse-spark-1.3-contributor-free',
      messages: [systemMessage('Be brief.'), userMessage('hi')],
      tools: [{ name: 'read', description: 'd', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
      maxTokens: 2048,
      reasoningEffort: 'high'
    })
  )

  assert.deepEqual(server.refusals, [], JSON.stringify(server.refusals))
  const request = server.requests[0]
  assert.equal(request.lane, 'responses')
  assert.equal(request.url, '/inference/v1/responses')
  assert.equal(request.body.max_tokens, undefined)
  assert.equal(request.body.max_output_tokens, 2048)
  assert.equal(request.body.reasoning_effort, undefined)
  assert.deepEqual(request.body.reasoning, { effort: 'high', summary: 'auto' })
  assert.equal(request.body.store, false)
  assert.equal(request.body.tool_choice, 'auto')
  // The Responses wire uses the flat tool shape.
  assert.equal(request.body.tools.find((tool) => tool.name === 'read').parameters.type, 'object')
  // The system prompt travels as `instructions` and still carries the marker.
  assert.ok(request.body.instructions.includes('Be brief.'))
  assert.ok(request.body.instructions.includes('<env>'))

  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'opencode-free', model: 'muse-spark-1.3-contributor-free', messages: [userMessage('again')] })) {
    chunks.push(chunk)
  }
  const usage = chunks.find((chunk) => chunk.type === 'usage')?.usage
  assert.equal(usage.inputTokens, 90, 'cached input tokens are subtracted on the Responses lane too')
  assert.equal(usage.reasoningTokens, 5)
})

test('a Messages-lane model is routed to /messages with an anthropic version', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const { adapter, transport } = await makeAdapter(server)
  t.after(() => transport.dispose())

  const chunks = await collect(
    adapter.stream({
      provider: 'opencode-free',
      model: 'union-alpha',
      messages: [systemMessage('sys'), userMessage('hi'), assistantToolCall(), toolResult()],
      tools: [{ name: 'read', description: 'd', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
      maxTokens: 1024
    })
  )

  assert.deepEqual(server.refusals, [], JSON.stringify(server.refusals))
  const request = server.requests[0]
  assert.equal(request.lane, 'messages')
  assert.equal(request.body.max_tokens, 1024)
  assert.ok(request.headers['anthropic-version'])
  assert.ok(request.body.system.includes('sys'))
  // A tool result becomes a user-role tool_result block on this lane.
  const toolResultMessage = request.body.messages.find((message) =>
    Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result')
  )
  assert.equal(toolResultMessage.role, 'user')
  assert.equal(toolResultMessage.content[0].tool_use_id, 'call_prev')

  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'tool-calls')
})

test('an unknown model id still lands on a lane and is served', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const { adapter, transport } = await makeAdapter(server)
  t.after(() => transport.dispose())

  // Family fallback: a grok id added upstream after this snapshot was taken.
  await collect(adapter.stream({ provider: 'opencode-free', model: 'grok-4.8-free', messages: [userMessage('hi')] }))
  assert.deepEqual(server.refusals, [], JSON.stringify(server.refusals))
  assert.equal(server.requests[0].lane, 'responses')

  server.requests.length = 0
  await collect(adapter.stream({ provider: 'opencode-free', model: 'totally-new-free', messages: [userMessage('hi')] }))
  assert.equal(server.requests[0].lane, 'chat')
})

test('turning the fingerprint off produces a refusal, proving the gate is what passes', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const { adapter, transport } = await makeAdapter(server, { fingerprint: { enabled: false } })
  t.after(() => transport.dispose())

  await assert.rejects(
    async () => collect(adapter.stream({ provider: 'opencode-free', model: 'big-pickle', messages: [userMessage('hi')] })),
    (error) => {
      // With the fingerprint off the request carries neither the verbatim tools
      // nor the <env> marker, and the body gate answers 429 for a missing half.
      assert.equal(error.code, 'RATE_LIMIT')
      assert.match(error.message, /agent-shape gate/)
      return true
    }
  )
  assert.ok(server.refusals.length > 0)
  assert.equal(server.refusals[0].type, 'FreeUsageLimitError')
})

test('disabling only the tool injection is refused, and only the env marker is refused', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())

  {
    const { adapter, transport } = await makeAdapter(server, { fingerprint: { tools: false } })
    t.after(() => transport.dispose())
    await assert.rejects(
      async () => collect(adapter.stream({ provider: 'opencode-free', model: 'big-pickle', messages: [userMessage('hi')] })),
      (error) => error.code === 'RATE_LIMIT'
    )
    assert.match(server.refusals[0].message, /"read" tool is not declared/)
  }
  server.refusals.length = 0

  {
    const { adapter, transport } = await makeAdapter(server, { fingerprint: { envMarker: false } })
    t.after(() => transport.dispose())
    await assert.rejects(
      async () => collect(adapter.stream({ provider: 'opencode-free', model: 'big-pickle', messages: [userMessage('hi')] })),
      (error) => {
        assert.equal(error.code, 'RATE_LIMIT')
        assert.match(error.message, /agent-shape gate/)
        return true
      }
    )
    assert.equal(server.refusals[0].type, 'FreeUsageLimitError')
    assert.match(server.refusals[0].message, /<env> marker is missing/)
  }
})

test('an unsupported reasoning effort converges onto the model\'s declared set', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const { adapter, transport } = await makeAdapter(server)
  t.after(() => transport.dispose())

  // big-pickle declares low/high/max and cannot disable thinking, so `medium`
  // must converge rather than reach the wire and draw a 400.
  await collect(
    adapter.stream({ provider: 'opencode-free', model: 'big-pickle', messages: [userMessage('hi')], reasoningEffort: 'medium' })
  )
  assert.deepEqual(server.refusals, [], JSON.stringify(server.refusals))
  assert.ok(['low', 'high', 'max'].includes(server.requests[0].body.reasoning_effort))

  server.requests.length = 0
  await collect(
    adapter.stream({ provider: 'opencode-free', model: 'big-pickle', messages: [userMessage('hi')], reasoningEffort: 'none' })
  )
  assert.deepEqual(server.refusals, [], JSON.stringify(server.refusals))

  server.requests.length = 0
  // `auto` is dropped entirely: the enum rejects the literal, and omitting the
  // field is what adaptive means.
  await collect(
    adapter.stream({ provider: 'opencode-free', model: 'big-pickle', messages: [userMessage('hi')], reasoningEffort: 'auto' })
  )
  assert.equal(server.requests[0].body.reasoning_effort, undefined)
})

test('a non-reasoning model never receives an effort field', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const { adapter, transport } = await makeAdapter(server)
  t.after(() => transport.dispose())

  await collect(
    adapter.stream({
      provider: 'opencode-free',
      model: 'ling-3.0-flash-fin-free',
      messages: [userMessage('hi')],
      reasoningEffort: 'high'
    })
  )
  assert.deepEqual(server.refusals, [], JSON.stringify(server.refusals))
  assert.equal(server.requests[0].body.reasoning_effort, undefined)
})

test('resolveModel reports context, output cap, vision and reasoning for the picker', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const { adapter, transport } = await makeAdapter(server)
  t.after(() => transport.dispose())

  const info = await adapter.resolveModel('opencode-free', 'muse-spark-1.3-contributor-free')
  assert.equal(info.provider, 'opencode-free')
  assert.equal(info.id, 'muse-spark-1.3-contributor-free')
  assert.equal(info.context.contextWindow, 1_048_576)
  assert.equal(info.defaultMaxTokens, 131_072)
  assert.deepEqual(info.inputModalities, ['text', 'image'])
  assert.deepEqual(
    info.reasoning.efforts.map((effort) => effort.id),
    ['low', 'medium', 'high', 'xhigh']
  )
  assert.equal(info.reasoning.defaultEffort, 'medium')
  assert.ok(info.reasoning.efforts.every((effort) => typeof effort.name === 'string' && effort.name.length > 0))

  const textOnly = await adapter.resolveModel('opencode-free', 'big-pickle')
  assert.deepEqual(textOnly.inputModalities, ['text'])
  assert.deepEqual(textOnly.reasoning.efforts.map((effort) => effort.id), ['low', 'high', 'max'])

  const nonReasoning = await adapter.resolveModel('opencode-free', 'ling-3.0-flash-fin-free')
  assert.equal(nonReasoning.reasoning, undefined)

  // vision: 'off' must narrow every route to text, so the harness itself
  // substitutes its placeholder instead of the adapter risking a 503.
  const { adapter: noVision, transport: t2 } = await makeAdapter(server, { vision: 'off' })
  t.after(() => t2.dispose())
  assert.deepEqual((await noVision.resolveModel('opencode-free', 'muse-spark-1.3-contributor-free')).inputModalities, ['text'])

  // An undescribed model still gets a usable context number for compaction.
  const unknown = await adapter.resolveModel('opencode-free', 'brand-new-model')
  assert.equal(unknown.context.contextWindow, 262_144)
})

test('listModels advertises the free roster for GUI selection', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const { adapter, transport } = await makeAdapter(server)
  t.after(() => transport.dispose())

  const models = await adapter.listModels('opencode-free')
  assert.ok(models.length > 5)
  assert.ok(models.every((model) => model.provider === 'opencode-free'))
  assert.ok(models.some((model) => model.id === 'big-pickle'))
  assert.ok(models.every((model) => Array.isArray(model.inputModalities)))
})

test('endpointFor keeps a pinned lane or versioned root and defaults to /inference/v1', () => {
  assert.equal(endpointFor('https://opencode.ai', 'chat'), 'https://opencode.ai/inference/v1/chat/completions')
  assert.equal(endpointFor('https://opencode.ai/', 'responses'), 'https://opencode.ai/inference/v1/responses')
  assert.equal(endpointFor('https://opencode.ai', 'messages'), 'https://opencode.ai/inference/v1/messages')
  assert.equal(
    endpointFor('https://opencode.ai/zen/v1', 'chat'),
    'https://opencode.ai/zen/v1/chat/completions',
    'a pinned versioned root is honoured so a paid key can stay on /zen/v1'
  )
  assert.equal(
    endpointFor('https://gw.example/v1/chat/completions', 'responses'),
    'https://gw.example/v1/chat/completions',
    'a fully pinned lane path is used verbatim'
  )
})

test('a 200 stream with no content is reported as a retryable EMPTY_RESPONSE', async (t) => {
  // The free lane is observed to answer 200 with an SSE stream that carries no
  // choices. Yielding nothing would become an empty assistant message and end the
  // turn with nothing for the loop to act on, so the adapter classifies it.
  const server = await startGateServer({ emptyFor: () => true })
  t.after(() => server.close())
  const { adapter, transport } = await makeAdapter(server)
  t.after(() => transport.dispose())

  await assert.rejects(
    async () => collect(adapter.stream({ provider: 'opencode-free', model: 'big-pickle', messages: [userMessage('hi')] })),
    (error) => {
      assert.equal(error.code, 'EMPTY_RESPONSE')
      assert.match(error.message, /no content/)
      return true
    }
  )
  assert.deepEqual(server.refusals, [], 'the gate accepted the request; the emptiness is upstream, not ours')
})

test('a stream that produced a tool call is not mistaken for an empty response', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const { adapter, transport } = await makeAdapter(server)
  t.after(() => transport.dispose())

  const chunks = await collect(
    adapter.stream({ provider: 'opencode-free', model: 'big-pickle', messages: [userMessage('hi')] })
  )
  assert.equal(chunks.at(-1).type, 'finish', 'the terminal finish must still be yielded')
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  assert.ok(chunks.some((chunk) => chunk.type === 'block-end'))
})

test('the route retry policy is captured at registration and defaults to the harness set', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())

  const { adapter, transport } = await makeAdapter(server)
  t.after(() => transport.dispose())
  // No policy configured: `undefined` selects the harness's normal-mode defaults,
  // which already retry EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT and TRANSPORT.
  assert.equal(adapter.providerRetryPolicy('opencode-free'), undefined)

  const configured = resolveConfig({
    baseURL: server.baseURL,
    apiKeyEnv: '',
    catalog: { enabled: false },
    retryPolicy: { mode: 'normal', maxRetries: 2 }
  })
  const transport2 = await createTransport({ mode: 'native' })
  t.after(() => transport2.dispose())
  const withPolicy = new OpenCodeFreeAdapter({
    connection: () => ({
      baseURL: configured.baseURL,
      defaultContextWindow: configured.defaultContextWindow,
      defaultMaxTokens: configured.defaultMaxTokens,
      fingerprint: true,
      fingerprintOptions: configured.fingerprint,
      vision: 'auto',
      reasoningEcho: true
    }),
    resolveApiKey: async () => undefined,
    catalog: new Catalog({ transport: transport2, modelsUrls: [], enabled: false }),
    transport: transport2,
    retryPolicy: {
      mode: 'normal',
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
      maxRetries: 2,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']
    }
  })
  const policy = withPolicy.providerRetryPolicy('opencode-free')
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 2)
  assert.ok(policy.retryableCodes.includes('RATE_LIMIT'))
  assert.ok(policy.retryableCodes.includes('EMPTY_RESPONSE'))
})
