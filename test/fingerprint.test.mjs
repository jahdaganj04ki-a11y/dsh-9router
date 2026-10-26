/**
 * The client fingerprint: session minting, header set, tool gate, env marker.
 *
 * Each assertion here corresponds to one documented ablation result — a property
 * whose removal turns a passing request into a 403 or 429 upstream.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FINGERPRINT_TOOL_DEFINITIONS,
  OPENCODE_USER_AGENT,
  SessionStore,
  applyEnvFingerprint,
  applyFingerprintTools,
  concealFingerprintToolNames,
  fingerprintHeaders,
  isGateSessionId,
  isV2UserAgent,
  mintSessionId,
  restoreToolNames
} from '../lib/fingerprint.js'

test('a minted session id has the descending shape the gate decodes', () => {
  for (let i = 0; i < 500; i++) {
    const id = mintSessionId()
    assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, id)
    assert.ok(isGateSessionId(id))

    // Decode what upstream decodes: ~(ms * 0x1000 + counter), low 48 bits.
    const prefix = BigInt(`0x${id.slice(4, 16)}`)
    const decoded = ~prefix & ((1n << 48n) - 1n)
    const counter = Number(decoded & 0xfffn)
    const timeMs = Number(decoded >> 12n)

    // The counter must stay inside the accepted range. Probes put acceptance at
    // 0..16 and refusal at >= 100; the CLI resets it each millisecond.
    assert.ok(counter >= 1 && counter <= 63, `counter ${counter} outside the accepted range`)
    // The embedded time must be current. `ms * 4096` needs ~53 bits and the field
    // holds 48, so the decoded value is the real time modulo 2^36 — compare in
    // that same wrapped space. This is what separates a minted id from a
    // digest-derived one of identical shape, which upstream refuses.
    const wrap = 2 ** 36
    const expected = Date.now() % wrap
    const drift = Math.min(Math.abs(timeMs - expected), wrap - Math.abs(timeMs - expected))
    assert.ok(drift < 60_000, `embedded timestamp drifted ${drift}ms from now (wrapped)`)
  }
})

test('a burst of ids in one millisecond keeps the counter inside the gate range', () => {
  const fixed = Date.now()
  const ids = Array.from({ length: 200 }, () => mintSessionId(fixed))
  for (const id of ids) {
    const decoded = ~(BigInt(`0x${id.slice(4, 16)}`)) & ((1n << 48n) - 1n)
    const counter = Number(decoded & 0xfffn)
    assert.ok(counter <= 63, `counter ${counter} exceeded the gate ceiling under a same-ms burst`)
  }
  assert.equal(new Set(ids).size, ids.length, 'ids must still be unique')
})

test('digest-derived and random ids of the right shape are recognized as unverifiable', () => {
  // The shape check is the cheap half of the gate; these pass it and would still
  // be refused upstream on the decoded timestamp. The point of the test is that
  // the store never produces them in the first place.
  assert.ok(isGateSessionId('ses_000000000000ABCDEFGHIJKLMN'))
  assert.ok(!isGateSessionId('ses_tooshort'))
  assert.ok(!isGateSessionId('550e8400-e29b-41d4-a716-446655440000'))
  assert.ok(!isGateSessionId(undefined))
})

test('the session store keeps one id per conversation and relays a genuine one', () => {
  const store = new SessionStore()
  const a = store.resolve('conversation-1')
  const b = store.resolve('conversation-1')
  const c = store.resolve('conversation-2')
  assert.equal(a, b, 'one conversation must keep one session for quota and cache affinity')
  assert.notEqual(a, c)

  const genuine = 'ses_0000ffffffffABCDEFGHIJKLMN'
  assert.equal(store.resolve(genuine), genuine, 'a real OpenCode id is relayed untouched')
  assert.equal(store.size, 2)
  store.dispose()
})

test('the header set carries all four session headers with one value and no v1 header', () => {
  const session = mintSessionId()
  const headers = fingerprintHeaders({ session })

  for (const name of ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id']) {
    assert.equal(headers[name], session, `${name} must carry the session value`)
  }
  // Sending the v1-only header is itself a rejection.
  assert.equal(headers['x-opencode-request'], undefined)
  assert.equal(headers['user-agent'], OPENCODE_USER_AGENT)
  assert.equal(headers.authorization, 'Bearer public')
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(headers.accept, 'text/event-stream')
  assert.equal(headers['x-opencode-client'], 'cli')

  const keyed = fingerprintHeaders({ session, apiKey: 'sk-real', stream: false })
  assert.equal(keyed.authorization, 'Bearer sk-real')
  assert.equal(keyed.accept, '*/*')

  const anthropic = fingerprintHeaders({ session, anthropic: true })
  assert.ok(anthropic['anthropic-version'])
})

test('the User-Agent is the v2 shape and attribution would break it', () => {
  assert.ok(isV2UserAgent(OPENCODE_USER_AGENT))
  assert.ok(isV2UserAgent('opencode/stable/2.1.0/cli'))
  assert.ok(!isV2UserAgent('opencode/1.18.31'), 'the v1 form is refused')
  assert.ok(!isV2UserAgent('opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'))
  // The harness's own attribution value fails both the whole-string match and
  // the substring rejection — this is why the adapter never sends it here.
  assert.ok(!isV2UserAgent('deepseek-harness/0.2.1 (+https://github.com/deepseek-ai/deepseek-harness)'))
  assert.match('deepseek-harness/0.2.1 (+url)', /deepseek[-_]harness/i)
  assert.ok(!isV2UserAgent(`${OPENCODE_USER_AGENT} deepseek-harness/0.2.1`), 'a suffix breaks the whole-string match')
})

test('the official read and shell definitions are injected verbatim', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }
  const map = applyFingerprintTools(body, false)

  assert.equal(map.size, 0, 'with no caller tools there is nothing to alias')
  const names = body.tools.map((tool) => tool.function.name)
  assert.deepEqual(names.sort(), ['read', 'shell'])

  for (const name of ['read', 'shell']) {
    const tool = body.tools.find((entry) => entry.function.name === name)
    assert.equal(tool.function.description, FINGERPRINT_TOOL_DEFINITIONS[name].description)
    assert.deepEqual(tool.function.parameters, FINGERPRINT_TOOL_DEFINITIONS[name].parameters)
    assert.equal(tool.type, 'function')
  }
  // The model is told the placeholders are off-limits, or it calls them.
  const system = body.messages.find((message) => message.role === 'system')
  assert.match(system.content, /Do not call the `read` or `shell` tools/)
  assert.match(system.content, /placeholders that do nothing/)
  // The env marker is required independently of the tools.
  assert.ok(applyEnvFingerprint(body, false) === false, 'the marker is already present')
  assert.match(system.content, /<env>/)
})

test('a colliding caller tool with compatible arguments is normalized in place', () => {
  const callerTool = {
    type: 'function',
    function: {
      name: 'read',
      description: 'The harness read tool, worded differently.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  }
  const body = { model: 'm', messages: [], tools: [callerTool], stream: true }
  const map = applyFingerprintTools(body, false)

  assert.equal(map.size, 0, 'an in-place normalization needs no alias')
  const read = body.tools.find((tool) => tool.function.name === 'read')
  assert.equal(read.function.description, FINGERPRINT_TOOL_DEFINITIONS.read.description)
  assert.deepEqual(read.function.parameters, FINGERPRINT_TOOL_DEFINITIONS.read.parameters)
  // No duplicate declaration: the gate refuses two tools named `read`.
  assert.equal(body.tools.filter((tool) => tool.function.name === 'read').length, 1)
})

test('a colliding caller tool with incompatible arguments is aliased and restored', () => {
  const callerRead = {
    type: 'function',
    function: {
      name: 'read',
      description: 'Reads a widget.',
      // `widgetId` is not one of OpenCode's parameter names, so the official
      // definition cannot be adopted without hiding an argument.
      parameters: { type: 'object', properties: { widgetId: { type: 'string' } }, required: ['widgetId'] }
    }
  }
  const body = {
    model: 'm',
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"widgetId":"w1"}' } }]
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' }
    ],
    tools: [callerRead],
    stream: true
  }
  const map = applyFingerprintTools(body, false)

  assert.equal(map.get('read_client'), 'read')
  const names = body.tools.map((tool) => tool.function.name).sort()
  assert.deepEqual(names, ['read', 'read_client', 'shell'])
  // The historical call is rewritten too, or it names a tool no longer declared.
  // Index by role rather than position: the env-marker injection prepends a
  // system message when the request had none.
  const assistant = body.messages.find((message) => message.role === 'assistant')
  assert.equal(assistant.tool_calls[0].function.name, 'read_client')

  // Response side: the caller's own spelling comes back.
  const restored = restoreToolNames(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'read_client', arguments: '{}' } }] } }] },
    map
  )
  assert.equal(restored.choices[0].delta.tool_calls[0].function.name, 'read')

  const restoredMessage = restoreToolNames(
    { choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'read_client', arguments: '{}' } }] } }] },
    map
  )
  assert.equal(restoredMessage.choices[0].message.tool_calls[0].function.name, 'read')

  const restoredAnthropic = restoreToolNames(
    { type: 'content_block_start', content_block: { type: 'tool_use', id: 'c', name: 'read_client' } },
    map
  )
  assert.equal(restoredAnthropic.content_block.name, 'read')

  const restoredResponses = restoreToolNames(
    { item: { type: 'function_call', name: 'read_client', call_id: 'c' } },
    map
  )
  assert.equal(restoredResponses.item.name, 'read')
})

test('case variants and foreign tool names are left verbatim', () => {
  const body = {
    model: 'm',
    messages: [],
    tools: [
      { type: 'function', function: { name: 'Read', description: 'd', parameters: { type: 'object', properties: { p: { type: 'string' } } } } },
      { type: 'function', function: { name: 'web_search', description: 'd', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }
    ],
    stream: true
  }
  const map = applyFingerprintTools(body, false)
  assert.equal(map.size, 0)
  const names = body.tools.map((tool) => tool.function.name).sort()
  assert.deepEqual(names, ['Read', 'read', 'shell', 'web_search'])
})

test('a duplicate declaration of one fingerprint name keeps only the first', () => {
  const definition = { type: 'function', function: { name: 'read', description: 'x', parameters: { type: 'object', properties: { a: { type: 'string' } } } } }
  const { tools } = concealFingerprintToolNames([definition, { ...definition }])
  assert.equal(tools.filter((tool) => tool.function.name === 'read' || tool.function.name === 'read_client').length, 1)
})

test('tool_choice "none" is never left on the wire', () => {
  const chat = { model: 'm', messages: [], tools: [], tool_choice: 'none', stream: true }
  applyFingerprintTools(chat, false)
  assert.equal(chat.tool_choice, undefined)

  // The Responses lane keeps its explicit auto default.
  const responses = { model: 'm', input: [], stream: true }
  applyFingerprintTools(responses, true)
  assert.equal(responses.tool_choice, 'auto')
})

test('an explicit tool_choice naming an aliased tool is retargeted', () => {
  const body = {
    model: 'm',
    messages: [],
    tools: [
      {
        type: 'function',
        function: { name: 'shell', description: 'custom', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } }
      }
    ],
    tool_choice: { type: 'function', function: { name: 'shell' } },
    stream: true
  }
  // The choice object is read by name at the top level in the Responses shape
  // and nested in the chat shape; either way it must not name a missing tool.
  body.tool_choice = { type: 'function', name: 'shell' }
  applyFingerprintTools(body, false)
  assert.equal(body.tool_choice.name, 'shell_client')
})

test('the env marker is appended to an existing system prompt, not substituted', () => {
  const body = { model: 'm', messages: [{ role: 'system', content: 'You are an agent.' }, { role: 'user', content: 'hi' }], stream: true }
  assert.equal(applyEnvFingerprint(body, false), true)
  const system = body.messages[0]
  assert.match(system.content, /^You are an agent\.\n\n/)
  assert.match(system.content, /<env>/)
  assert.match(system.content, /Working directory: /)
  assert.match(system.content, /Platform: /)
  // Idempotent: a prompt that already carries the marker is left alone.
  assert.equal(applyEnvFingerprint(body, false), false)
})

test('the env marker is added when there is no system message at all', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }
  assert.equal(applyEnvFingerprint(body, false), true)
  assert.equal(body.messages[0].role, 'system')
  assert.match(body.messages[0].content, /<env>/)
  assert.equal(body.messages[1].content, 'hi')
})

test('the env marker is applied even when tool injection is switched off', () => {
  // The marker gate is independent of the tool gate: a request missing *either*
  // half is answered 429 regardless of headers, UA or session shape. Dropping the
  // marker along with the tools would be a silent, hard-to-diagnose failure.
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], stream: true }
  applyFingerprintTools(body, false, { tools: false })
  const system = body.messages.find((message) => message.role === 'system')
  assert.ok(system !== undefined, 'the marker needs a system message to live in')
  assert.match(system.content, /<env>/)
  assert.ok(!/Do not call/.test(system.content), 'no placeholder note without injected tools')
  assert.deepEqual(body.tools, [])
})

test('the env marker reaches the Responses and Anthropic system slots', () => {
  const responses = { model: 'm', instructions: 'Be brief.', input: [], stream: true }
  assert.equal(applyEnvFingerprint(responses, true), true)
  assert.match(responses.instructions, /^Be brief\.\n\n/)
  assert.match(responses.instructions, /<env>/)

  const anthropic = { model: 'm', system: [{ type: 'text', text: 'You are helpful.' }], messages: [], stream: true }
  assert.equal(applyEnvFingerprint(anthropic, false, { claude: true }), true)
  assert.match(anthropic.system[0].text, /<env>/)
  assert.match(anthropic.system[0].text, /^You are helpful\./)

  const responsesWithoutInstructions = { model: 'm', input: [], stream: true }
  applyEnvFingerprint(responsesWithoutInstructions, true)
  assert.match(responsesWithoutInstructions.instructions, /<env>/)
})

test('fingerprint injection can be switched off independently', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], stream: true }
  const map = applyFingerprintTools(body, false, { tools: false, envMarker: false })
  assert.equal(map.size, 0)
  assert.deepEqual(body.tools, [])
  assert.equal(body.messages.length, 1, 'nothing at all was injected')
})
