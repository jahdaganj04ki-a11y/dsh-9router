#!/usr/bin/env node
/**
 * Live gate probe — find out *which* free-tier check is refusing you.
 *
 * The free lane has six independent gates (path, User-Agent, session headers,
 * session id shape, body shape, TLS ClientHello) and refuses a request that fails
 * any one of them, with an error message that names none of them. When the plugin
 * stops working after an upstream release, this script says which half moved.
 *
 * Run it from the package directory:
 *
 *     node scripts/probe.mjs              # listing + one positive request
 *     node scripts/probe.mjs --ablate     # also remove one gate at a time
 *     node scripts/probe.mjs --model cat-jam-free
 *     node scripts/probe.mjs --json       # machine-readable result
 *
 * Network and quota notes: this talks to the real `opencode.ai` free lane and each
 * successful request draws on the shared anonymous quota, which is rate-limited by
 * source. The default run makes one completion request; `--ablate` makes up to a
 * dozen more, most of which are refused before they reach a model and so cost
 * nothing. Run it deliberately, not in a loop.
 */

import process from 'node:process'
import { Catalog } from '../lib/discovery.js'
import { SNAPSHOT_MODELS, isFreeModelId } from '../lib/catalog.js'
import {
  FINGERPRINT_TOOL_DEFINITIONS,
  OPENCODE_USER_AGENT,
  applyFingerprintTools,
  fingerprintHeaders,
  mintSessionId
} from '../lib/fingerprint.js'
import { OPENCODE_CIPHER_LIST, createTransport } from '../lib/transport.js'

const BASE_URL = 'https://opencode.ai'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const asJson = flag('json')
const ablate = flag('ablate')
const model = option('model', 'big-pickle')
const transportMode = option('transport', 'impersonate')

/** @type {{ name: string, ok: boolean, detail: string }[]} */
const results = []

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!asJson) console.log(`${ok ? '  ok  ' : ' FAIL '} ${name.padEnd(34)} ${detail}`)
}

function heading(text) {
  if (!asJson) console.log(`\n${text}`)
}

/**
 * The smallest request that satisfies every gate: one user turn, no tools of its
 * own, so the injected fingerprint pair is the only tool declaration.
 */
function probeBody(modelId) {
  const body = {
    model: modelId,
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 64
  }
  applyFingerprintTools(body, false)
  return body
}

async function send(transport, path, { headers, body }) {
  try {
    const response = await transport.request(`${BASE_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeoutMs: 45_000
    })
    const text = await response.text()
    let type
    let message
    try {
      const parsed = JSON.parse(text)
      type = parsed?.error?.type ?? parsed?.type
      message = parsed?.error?.message ?? parsed?.message
    } catch {
      // An SSE body is not JSON; look for an error event inside it instead.
      const match = text.match(/"type":"([A-Za-z]+Error)"/)
      if (match !== null) type = match[1]
    }
    return { status: response.status, type, message, text }
  } catch (error) {
    return { status: 0, type: 'TransportError', message: error instanceof Error ? error.message : String(error), text: '' }
  }
}

const session = mintSessionId()
const goodHeaders = fingerprintHeaders({ session })

async function main() {
  if (!asJson) {
    console.log('dsh-9router free-lane probe')
    console.log(`  endpoint   ${BASE_URL}/inference/v1`)
    console.log(`  model      ${model}`)
    console.log(`  transport  ${transportMode}`)
    console.log(`  session    ${session}`)
    console.log(`  ua         ${OPENCODE_USER_AGENT}`)
  }

  // ── 1. TLS ────────────────────────────────────────────────────────────────
  heading('1. TLS ClientHello')
  let transport
  try {
    transport = await createTransport({ mode: transportMode, cipherList: OPENCODE_CIPHER_LIST })
    record('transport', true, `${transport.mode} — ${transport.describe}`)
  } catch (error) {
    record('transport', false, error.message)
    finish(1)
    return
  }

  // ── 2. Listing ────────────────────────────────────────────────────────────
  heading('2. Model listing')
  for (const path of ['/inference/v1/models', '/zen/v1/models']) {
    try {
      const response = await transport.request(`${BASE_URL}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': OPENCODE_USER_AGENT },
        timeoutMs: 20_000
      })
      const text = await response.text()
      const parsed = JSON.parse(text)
      const ids = (Array.isArray(parsed?.data) ? parsed.data : [])
        .map((entry) => entry?.id)
        .filter((id) => typeof id === 'string')
      const free = ids.filter((id) => isFreeModelId(id))
      record(
        `GET ${path}`,
        response.status === 200,
        `${response.status}, ${ids.length} models, ${free.length} free`
      )
      if (!asJson && path === '/inference/v1/models' && free.length > 0) {
        console.log(`         free: ${free.join(', ')}`)
      }
    } catch (error) {
      record(`GET ${path}`, false, error.message)
    }
  }

  // ── 3. The positive request ───────────────────────────────────────────────
  heading('3. One fully fingerprinted request')
  const positive = await send(transport, '/inference/v1/chat/completions', {
    headers: goodHeaders,
    body: probeBody(model)
  })
  record(
    'complete request',
    positive.status === 200,
    describe(positive)
  )
  if (positive.status === 200) {
    const answered = /pong/i.test(positive.text) || positive.text.includes('"delta"')
    record('streamed a completion', answered, answered ? 'the lane served the model' : 'no delta in the reply')
  } else {
    explain(positive)
  }

  // ── 4. Ablation ───────────────────────────────────────────────────────────
  if (ablate) {
    heading('4. Ablation — one gate removed at a time (each should FAIL)')
    const cases = [
      ['historical /zen/v1 path', () => send(transport, '/zen/v1/chat/completions', { headers: goodHeaders, body: probeBody(model) })],
      ['v1 User-Agent', () => send(transport, '/inference/v1/chat/completions', { headers: { ...goodHeaders, 'user-agent': 'opencode/1.18.31' }, body: probeBody(model) })],
      ['harness attribution UA', () => send(transport, '/inference/v1/chat/completions', { headers: { ...goodHeaders, 'user-agent': 'deepseek-harness/0.2.1 (+https://github.com/deepseek-ai/deepseek-harness)' }, body: probeBody(model) })],
      ['no x-opencode-session-id', () => { const h = { ...goodHeaders }; delete h['x-opencode-session-id']; return send(transport, '/inference/v1/chat/completions', { headers: h, body: probeBody(model) }) }],
      ['no x-opencode-session', () => { const h = { ...goodHeaders }; delete h['x-opencode-session']; return send(transport, '/inference/v1/chat/completions', { headers: h, body: probeBody(model) }) }],
      ['v1 x-opencode-request added', () => send(transport, '/inference/v1/chat/completions', { headers: { ...goodHeaders, 'x-opencode-request': 'req_1' }, body: probeBody(model) })],
      ['random session id', () => send(transport, '/inference/v1/chat/completions', { headers: fingerprintHeaders({ session: `ses_${'0'.repeat(12)}${'A'.repeat(14)}` }), body: probeBody(model) })],
      ['no tools', () => { const body = probeBody(model); body.tools = []; return send(transport, '/inference/v1/chat/completions', { headers: goodHeaders, body }) }],
      ['stubbed read tool', () => { const body = probeBody(model); body.tools = body.tools.map((t) => t.function.name === 'read' ? { ...t, function: { ...t.function, description: 'Read a file.' } } : t); return send(transport, '/inference/v1/chat/completions', { headers: goodHeaders, body }) }],
      ['no <env> marker', () => { const body = probeBody(model); body.messages = body.messages.filter((m) => m.role !== 'system'); return send(transport, '/inference/v1/chat/completions', { headers: goodHeaders, body }) }],
      ['tool_choice none', () => { const body = probeBody(model); body.tool_choice = 'none'; return send(transport, '/inference/v1/chat/completions', { headers: goodHeaders, body }) }],
      ['stream false', () => { const body = probeBody(model); body.stream = false; delete body.stream_options; return send(transport, '/inference/v1/chat/completions', { headers: goodHeaders, body }) }]
    ]

    for (const [label, run] of cases) {
      const outcome = await run()
      // Every ablation is expected to be refused. A 200 here means the gate this
      // case targets is not currently enforced, which is itself worth knowing.
      record(
        label,
        outcome.status !== 200,
        outcome.status === 200 ? '200 — this gate is not currently enforced' : describe(outcome)
      )
    }

    heading('5. TLS ablation — the same request on stock Node ciphers')
    const native = await createTransport({ mode: 'native' })
    const nativeOutcome = await send(native, '/inference/v1/chat/completions', {
      headers: fingerprintHeaders({ session: mintSessionId() }),
      body: probeBody(model)
    })
    native.dispose()
    record(
      'native OpenSSL ciphers',
      nativeOutcome.status !== 200,
      nativeOutcome.status === 200
        ? '200 — the TLS gate is not currently enforced from this network'
        : describe(nativeOutcome)
    )
  }

  // ── 6. Catalog sanity ─────────────────────────────────────────────────────
  heading(ablate ? '6. Catalog' : '4. Catalog')
  const catalog = new Catalog({
    transport,
    modelsUrls: [`${BASE_URL}/inference/v1/models`, `${BASE_URL}/zen/v1/models`],
    ttlMs: 0,
    timeoutMs: 20_000,
    cachePath: ''
  })
  const result = await catalog.list()
  record(
    'catalog resolution',
    result.models.length > 0,
    `${result.models.length} models from ${result.source}${result.error ? ` (${result.error})` : ''}`
  )
  if (!asJson) {
    const known = new Set(SNAPSHOT_MODELS.map((entry) => entry.id))
    const unknown = result.models.filter((entry) => !known.has(entry.id)).map((entry) => entry.id)
    if (unknown.length > 0) {
      console.log(`         not in the bundled snapshot (using synthesized defaults): ${unknown.join(', ')}`)
    }
    const missing = [...known].filter((id) => !result.models.some((entry) => entry.id === id))
    if (missing.length > 0) {
      console.log(`         in the snapshot but not on the lane now: ${missing.join(', ')}`)
    }
  }

  transport.dispose()
  finish(results.every((entry) => entry.ok) ? 0 : 1)
}

function describe(outcome) {
  const parts = [`HTTP ${outcome.status}`]
  if (outcome.type !== undefined) parts.push(outcome.type)
  if (outcome.message !== undefined) parts.push(String(outcome.message).slice(0, 140))
  return parts.join(' · ')
}

/** Translate the two failures that read like quota problems but are not. */
function explain(outcome) {
  if (asJson) return
  if (outcome.type === 'FreeTierError' || outcome.status === 403) {
    console.log('\n  → FreeTierError: the request did not look like OpenCode. One of the identity')
    console.log('    gates (path, User-Agent, session headers, session id shape) is out of date.')
    console.log('    Re-run with --ablate to find which one.')
  }
  if (outcome.type === 'FreeUsageLimitError' || outcome.status === 429) {
    console.log('\n  → FreeUsageLimitError: either the shared anonymous quota is exhausted, or the')
    console.log('    body/TLS gate refused the request — this lane answers both with 429.')
    console.log('    Re-run with --ablate: if the body ablations all fail as expected but the')
    console.log('    "native OpenSSL ciphers" case succeeds, it is the TLS gate; if the complete')
    console.log('    request above also fails on --transport impersonate, it is the quota.')
  }
  if (outcome.status === 0) {
    console.log('\n  → No HTTP status at all: the request never completed. Check outbound HTTPS')
    console.log('    access to opencode.ai, a corporate proxy, or a TLS handshake failure.')
  }
}

function finish(code) {
  if (asJson) console.log(JSON.stringify({ model, transport: transportMode, results }, null, 2))
  else {
    const failed = results.filter((entry) => !entry.ok)
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
    if (failed.length > 0) console.log(`failing: ${failed.map((entry) => entry.name).join(', ')}`)
  }
  process.exit(code)
}

main().catch((error) => {
  console.error('probe failed:', error)
  process.exit(1)
})

/** Declared for the fingerprint tool definitions the probe sends verbatim. */
export const PROBE_TOOL_NAMES = Object.keys(FINGERPRINT_TOOL_DEFINITIONS)
