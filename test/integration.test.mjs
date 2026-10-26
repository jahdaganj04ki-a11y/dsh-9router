/**
 * Integration: mount the plugin into a real Cordis context beside the real
 * `@deepseek-ai/dsh-llm` service, and drive a request through `ctx.llm.stream()`.
 *
 * This is the closest thing to running inside DSH Desktop that a test can get, and
 * it is the one that catches contract drift: `LlmAdapter` is an abstract class in
 * a peer package, `registerAdapter` validates the route set, `registerConfigurableProviders`
 * validates the directory entry, and `stream()` runs the harness's own
 * `prepareCall` — which rejects a reasoning effort the model does not declare and
 * materializes the adapter's output cap before anything reaches the wire. A unit
 * test of the adapter alone cannot see any of that.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as plugin from '../index.js'
import { startGateServer } from './gate-server.mjs'

/**
 * Boot a context with the LLM service and this plugin mounted.
 *
 * @param {object} server - The gate server from `gate-server.mjs`.
 * @param {Record<string, any>} [config]
 */
async function boot(server, config = {}) {
  const root = new Context()
  root.plugin(LlmRuntime)
  await settle()
  assert.ok(root.llm !== undefined, 'the LLM service did not mount')

  root.plugin(plugin, {
    baseURL: server.baseURL,
    apiKeyEnv: '',
    catalog: { enabled: false },
    ...config
  })
  await settle()
  return root
}

/** Let Cordis run its mount queue and any injected-service effects. */
async function settle(ms = 60) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

test('the plugin mounts and registers its provider route in a real context', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const ctx = await boot(server)

  const providers = ctx.llm.listProviders()
  assert.equal(providers.length, 1)
  assert.equal(providers[0].id, 'opencode-free')
  assert.equal(providers[0].name, 'OpenCode Free')

  // The settings directory row is what makes the provider visible in
  // Settings → Models rather than only in the composer's picker.
  const directory = ctx.llm.listConfigurableProviders()
  assert.equal(directory.length, 1)
  assert.equal(directory[0].provider, 'opencode-free')
  assert.equal(directory[0].displayName, 'OpenCode Free')
  assert.equal(directory[0].defaultBaseURL, `${server.baseURL}/inference/v1/chat/completions`)
  assert.deepEqual(directory[0].nativeAuth, { env: [], oauth: false })
  assert.equal(directory[0].error, undefined)
})

test('the harness lists and resolves models through the registered adapter', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const ctx = await boot(server)

  const models = await ctx.llm.listModels('opencode-free')
  assert.ok(models.length > 5)
  assert.ok(models.every((model) => model.provider === 'opencode-free'))

  // `resolveModelInfo` runs the harness's own normalization, which rejects a
  // `systemPromptUpdate` or effort list it does not understand — so a pass here
  // proves the metadata shape is the one this dsh version accepts.
  const info = await ctx.llm.resolveModelInfo('opencode-free', 'muse-spark-1.3-contributor-free')
  assert.equal(info.context.contextWindow, 1_048_576)
  assert.equal(info.defaultMaxTokens, 131_072)
  assert.deepEqual([...info.inputModalities], ['text', 'image'])
  assert.deepEqual(
    info.reasoning.efforts.map((effort) => effort.id),
    ['low', 'medium', 'high', 'xhigh']
  )

  // An effort the model does not declare is rejected before any provider I/O.
  await assert.rejects(
    async () => ctx.llm.resolveCallConfig({ provider: 'opencode-free', model: 'muse-spark-1.3-contributor-free', reasoningEffort: 'ultra' }),
    /ultra|effort/i
  )
})

test('prepareCall materializes the adapter output cap when the caller omits one', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const ctx = await boot(server, { maxTokens: 8192 })

  const prepared = await ctx.llm.prepareCall({ provider: 'opencode-free', model: 'big-pickle' })
  // big-pickle caps at 32000 and the deployment at 8192; the smaller wins.
  assert.equal(prepared.config.maxTokens, 8192)
  assert.equal(prepared.context.contextWindow, 200_000)
  assert.deepEqual([...prepared.inputModalities], ['text'])
  assert.equal(typeof prepared.stream, 'function')
})

test('a full request through ctx.llm.stream() passes the gate and yields harness chunks', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const ctx = await boot(server)

  /** @type {any[]} */
  const chunks = []
  for await (const chunk of ctx.llm.stream({
    provider: 'opencode-free',
    model: 'big-pickle',
    messages: [
      {
        id: 'm0',
        role: 'system',
        content: [{ type: 'text', text: 'You are an agent.' }],
        source: { kind: 'system-prompt' }
      },
      {
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: 'read /etc' }],
        source: { kind: 'user' }
      }
    ],
    tools: [
      {
        name: 'read',
        description: 'The harness read tool.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
      },
      {
        name: 'bash',
        description: 'Run a command.',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
      }
    ],
    maxTokens: 2048,
    reasoningEffort: 'high'
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(server.refusals, [], `the gate refused the request: ${JSON.stringify(server.refusals)}`)
  assert.equal(server.requests.length, 1)
  assert.equal(server.requests[0].url, '/inference/v1/chat/completions')
  assert.equal(server.requests[0].body.reasoning_effort, 'high')
  assert.equal(server.requests[0].body.max_tokens, 2048)
  // The harness's own `bash` tool travels alongside the injected fingerprint pair.
  const toolNames = server.requests[0].body.tools.map((tool) => tool.function.name).sort()
  assert.deepEqual(toolNames, ['bash', 'read', 'shell'])

  const kinds = chunks.map((chunk) => chunk.type)
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  assert.ok(kinds.includes('block-start') && kinds.includes('block-end') && kinds.includes('usage'))
  assert.ok(kinds.indexOf('usage') < kinds.indexOf('finish'))

  // The harness's BlockAssembler accepts the chunk sequence, which is the real
  // contract: a block left unclosed makes `blocks()` throw.
  const { BlockAssembler } = await import('@deepseek-ai/dsh-llm')
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  const blocks = assembler.blocks()
  assert.ok(blocks.some((block) => block.type === 'text' && block.text === 'pong'))
  assert.ok(blocks.some((block) => block.type === 'reasoning'))
  const call = blocks.find((block) => block.type === 'tool-call')
  assert.equal(call.name, 'read')
  assert.equal(call.arguments, '{"path":"/etc"}')
})

test('model discovery is registered under the plugin namespace', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const ctx = await boot(server)

  // The namespace is the loader entry id; outside a profile it falls back to the
  // plugin's own default, which is what the directory row also reports.
  const settingsNs = ctx.llm.listConfigurableProviders()[0].settingsNs
  const discovered = await ctx.llm.discoverModels(settingsNs, { provider: 'opencode-free' })
  assert.ok(Array.isArray(discovered))
  assert.ok(discovered.every((model) => typeof model.id === 'string'))
  assert.ok(discovered.some((model) => model.id === 'big-pickle'))
  const muse = discovered.find((model) => model.id === 'muse-spark-1.3-contributor-free')
  assert.equal(muse.contextWindow, 1_048_576)
  assert.deepEqual([...muse.inputModalities], ['text', 'image'])
})

test('disposing the plugin fiber withdraws the route and the directory entry', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const ctx = await boot(server)
  assert.equal(ctx.llm.listProviders().length, 1)
  assert.equal(ctx.llm.listConfigurableProviders().length, 1)

  // `ctx.plugin()` returns the Fiber, and Cordis disposes a plugin's effects with
  // it. DSH Desktop relies on that: Safe Mode blocks third-party plugins, the
  // plugin page removes them, and HMR reloads them — each of which disposes a
  // fiber and expects no route, directory entry or session cache to survive.
  const second = ctx.plugin(plugin, {
    baseURL: server.baseURL,
    apiKeyEnv: '',
    catalog: { enabled: false },
    provider: 'opencode-second'
  })
  await settle()
  assert.equal(ctx.llm.listProviders().length, 2, 'a second, differently-named route mounts alongside the first')
  assert.equal(ctx.llm.listConfigurableProviders().length, 2)

  second.dispose()
  await settle()
  assert.deepEqual(
    ctx.llm.listProviders().map((entry) => entry.id),
    ['opencode-free'],
    'disposing a fiber must withdraw exactly its own route'
  )
  assert.equal(ctx.llm.listConfigurableProviders().length, 1, 'and its own directory entry')

  // Now the plugin's own fiber: Safe Mode, a plugin removal and an HMR reload all
  // do exactly this, and none of them may leave a route, a directory entry or a
  // discovery offer standing.
  const first = ctx.plugin(plugin, {
    baseURL: server.baseURL,
    apiKeyEnv: '',
    catalog: { enabled: false },
    provider: 'opencode-third'
  })
  await settle()
  assert.equal(ctx.llm.listProviders().length, 2)
  // The namespace follows the provider route, so two mounts cannot collapse into
  // one directory row and one discovery offer and dispose each other's state.
  const namespace = ctx.llm.listConfigurableProviders().find((entry) => entry.provider === 'opencode-third')?.settingsNs
  assert.equal(namespace, 'opencode-third')
  const firstNamespace = ctx.llm.listConfigurableProviders().find((entry) => entry.provider === 'opencode-free')?.settingsNs
  assert.equal(firstNamespace, 'opencode-free')
  assert.ok(
    (await ctx.llm.discoverModels(namespace, { provider: 'opencode-third' })).length > 0,
    'discovery is registered while mounted'
  )

  first.dispose()
  await settle()
  assert.deepEqual(ctx.llm.listProviders().map((entry) => entry.id), ['opencode-free'])
  await assert.rejects(
    async () => ctx.llm.discoverModels(namespace, { provider: 'opencode-third' }),
    /discovery|namespace|NO_|not|route/i,
    'the discovery offer must be withdrawn with the fiber, not left serving'
  )
})

test('a duplicate route registration is refused rather than silently shadowed', async (t) => {
  const server = await startGateServer()
  t.after(() => server.close())
  const ctx = await boot(server)

  // Registering a route another adapter already owns fails with DUPLICATE_ADAPTER,
  // so a second copy of this plugin under the same provider name cannot quietly
  // take over the first one's models.
  let caught
  try {
    ctx.plugin(plugin, { baseURL: server.baseURL, apiKeyEnv: '', catalog: { enabled: false } })
    await settle()
  } catch (error) {
    caught = error
  }
  const reported = caught ?? ctx.registry?.tasks?.find?.((task) => task.value !== undefined)?.value
  assert.ok(
    reported === undefined || /DUPLICATE_ADAPTER|already|opencode-free/i.test(String(reported?.message ?? reported)),
    `expected a duplicate-route refusal, got ${String(reported?.message ?? reported)}`
  )
  assert.equal(ctx.llm.listProviders().length, 1, 'the original registration keeps serving')
})

test('invalid config is refused with a message naming the field', async () => {
  // Validated at plugin load, not mid-request: a typo in `cordis.patch.yml`
  // should fail mounting with the field named, rather than surfacing three turns
  // later as an opaque provider error.
  const { resolveConfig } = await import('../lib/config.js')
  assert.throws(() => resolveConfig({ vision: 'sometimes' }), /vision must be one of/)
  assert.throws(() => resolveConfig({ baseURL: 'not-a-url' }), /baseURL must be an http/)
  assert.throws(() => resolveConfig({ transport: { mode: 'carrier-pigeon' } }), /transport\.mode must be one of/)
  assert.throws(() => resolveConfig({ maxTokens: -5 }), /maxTokens must be a positive integer/)
  assert.throws(() => resolveConfig({ defaultContextWindow: 1.5 }), /defaultContextWindow must be a positive integer/)
  assert.throws(() => resolveConfig({ catalog: { ttlMs: -1 } }), /catalog\.ttlMs must be a non-negative number/)
  assert.throws(() => resolveConfig({ provider: '' }), /provider must be a non-empty string/)

  // And the empty config resolves to the intended zero-configuration posture.
  const resolved = resolveConfig({})
  assert.equal(resolved.provider, 'opencode-free')
  assert.equal(resolved.baseURL, 'https://opencode.ai')
  assert.equal(resolved.apiKeyEnv, 'OPENCODE_API_KEY')
  assert.equal(resolved.fingerprint.enabled, true)
  assert.equal(resolved.fingerprint.userAgent, 'opencode/latest/2.0.26/cli')
  assert.equal(resolved.transport.mode, 'auto')
  assert.equal(resolved.vision, 'auto')
  assert.equal(resolved.catalog.enabled, true)
  assert.ok(resolved.catalog.modelsUrls[0].endsWith('/inference/v1/models'))
  assert.ok(resolved.catalog.cachePath.length > 0)
  // An explicit empty cachePath disables the file cache rather than defaulting it.
  assert.equal(resolveConfig({ catalog: { cachePath: '' } }).catalog.cachePath, '')
})
