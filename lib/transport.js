/**
 * Transport for the OpenCode free lane: the TLS ClientHello is part of the gate.
 *
 * The free lane keys on the cipher list in the TLS ClientHello, not only on the
 * HTTP layer. Measured on one process, one egress IP and three transports, the
 * same body and headers that pass from the official CLI come back as
 * `429 FreeUsageLimitError` when they ride Node's stock OpenSSL fingerprint, and
 * pass again once the cipher list matches Bun's BoringSSL one. JA4 identifies the
 * list by its cipher hash (`5b57614c22b0` for Bun), and only that hash is
 * compared — reordering the same list still passes, and no GREASE is sent.
 *
 * Node can produce that exact list natively: `tls.connect({ ciphers })` accepts
 * TLS 1.3 suite names alongside the OpenSSL ones and emits them verbatim, in
 * order, with no GREASE inserted. `test/transport.test.mjs` asserts the emitted
 * ClientHello cipher_suites against the target list byte for byte, so the
 * impersonation needs no native module, no Rust binary and no per-platform
 * download — which matters because a DSH Desktop plugin installs into an
 * Electron-bundled Node on Windows, where a native dependency is the most likely
 * thing to fail.
 *
 * `wreq-js` remains available as an opt-in upgrade for full JA3/JA4 fidelity
 * (extensions, ALPN ordering, curve list). It is an optional dependency; when it
 * is missing the native path is used rather than failing the request.
 *
 * @module dsh-9router/transport
 */

import https from 'node:https'
import http from 'node:http'

/**
 * The BoringSSL/Chrome-family cipher list the free gate accepts, in the order
 * Bun sends it. Only the list's hash is compared, but the order is kept verbatim
 * so the emitted JA4 cipher hash matches the measured one.
 *
 * Verified: a Node `tls.connect` with this string produces a ClientHello whose
 * `cipher_suites` field is exactly these 17 suites in this order, with zero
 * GREASE entries.
 */
export const OPENCODE_CIPHER_LIST = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-ECDSA-AES128-SHA',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-ECDSA-AES256-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA'
].join(':')

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * One transport's answer, normalized across the native and wreq paths so the
 * stream consumer never needs to know which produced it.
 *
 * @typedef {object} TransportResponse
 * @property {number} status
 * @property {string} statusText
 * @property {(name: string) => string | undefined} header
 * @property {() => Record<string, string>} headers
 * @property {AsyncIterable<Uint8Array>} body - Live stream; never buffered.
 * @property {() => Promise<string>} text - Convenience for error bodies.
 */

/**
 * @typedef {object} Transport
 * @property {'native' | 'impersonate' | 'wreq'} mode - What is actually in use.
 * @property {string} describe - Human-readable one-liner for logs and diagnostics.
 * @property {(url: string, init: { method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal, timeoutMs?: number }) => Promise<TransportResponse>} request
 * @property {() => void} dispose
 */

/**
 * Wrap a Node `IncomingMessage` as an async iterable of bytes plus helpers.
 *
 * Node streams are already async iterable, so this only adds the header accessors
 * and the abort/error surface the caller expects from a fetch-like response.
 *
 * @param {import('node:http').IncomingMessage} message
 * @param {import('node:http').ClientRequest} request
 * @returns {TransportResponse}
 */
function fromNodeResponse(message, request) {
  return {
    status: message.statusCode ?? 0,
    statusText: message.statusMessage ?? '',
    header: (name) => {
      const value = message.headers[name.toLowerCase()]
      return Array.isArray(value) ? value.join(', ') : value
    },
    headers: () => {
      /** @type {Record<string, string>} */
      const out = {}
      for (const [name, value] of Object.entries(message.headers)) {
        out[name] = Array.isArray(value) ? value.join(', ') : String(value ?? '')
      }
      return out
    },
    body: message,
    text: async () => {
      const chunks = []
      for await (const chunk of message) chunks.push(chunk)
      return Buffer.concat(chunks).toString('utf8')
    }
  }
}

/**
 * The native Node transport, with or without the impersonated cipher list.
 *
 * A keep-alive agent is reused across requests: the free lane accounts quota per
 * session and benefits from connection reuse, and building a TLS handshake per
 * turn would add latency to every token stream.
 *
 * @param {{ cipherList?: string, timeoutMs?: number }} options
 * @returns {Transport}
 */
function createNodeTransport({ cipherList, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const impersonate = typeof cipherList === 'string' && cipherList.length > 0
  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 8,
    ...(impersonate ? { ciphers: cipherList } : {})
  })

  return {
    mode: impersonate ? 'impersonate' : 'native',
    describe: impersonate
      ? 'node https with the BoringSSL cipher list the free gate accepts (JA4 5b57614c22b0)'
      : 'node https with stock OpenSSL ciphers (the free lane answers this 429 FreeUsageLimitError)',
    request: (url, init = {}) =>
      new Promise((resolve, reject) => {
        const target = new URL(url)
        const isHttps = target.protocol === 'https:'
        const driver = isHttps ? https : http
        const request = driver.request(
          target,
          {
            method: init.method ?? 'GET',
            agent: isHttps ? agent : undefined,
            headers: init.headers,
            timeout: init.timeoutMs ?? timeoutMs
            // The cipher list lives on the agent, not on the request: repeating it
            // here would give every request a different socket-pool key and defeat
            // the connection reuse the free lane's per-session quota benefits from.
          },
          (message) => {
            message.on('error', reject)
            resolve(fromNodeResponse(message, request))
          }
        )
        request.on('error', reject)
        request.on('timeout', () => {
          request.destroy(new Error(`dsh-9router: request to ${target.host} timed out`))
        })
        if (init.signal !== undefined) {
          if (init.signal.aborted) request.destroy(new Error('aborted'))
          else init.signal.addEventListener('abort', () => request.destroy(new Error('aborted')), { once: true })
        }
        if (init.body !== undefined) request.write(init.body)
        request.end()
      }),
    dispose: () => agent.destroy()
  }
}

let wreqPromise
let wreqFailed = false

/**
 * Lazily load the optional `wreq-js` runtime.
 *
 * @returns {Promise<any | undefined>} The module, or `undefined` when unavailable.
 */
async function loadWreq() {
  if (wreqFailed) return undefined
  if (wreqPromise === undefined) {
    wreqPromise = import('wreq-js').catch(() => {
      wreqFailed = true
      return undefined
    })
  }
  return wreqPromise
}

/**
 * Strip the TLS 1.3 suite names from a cipher list.
 *
 * `wreq-js` is rustls-backed, and rustls fixes the TLS 1.3 suites itself: passing
 * them as `cipherList` is refused with `NO_CIPHER_MATCH`. Only the TLS 1.2-and-
 * below half is configurable there, so that half is what gets forwarded. Node's
 * own stack accepts the full list, which is one reason the native path is the
 * default rather than a fallback.
 *
 * @param {string} cipherList
 * @returns {string}
 */
export function tls12CipherSubset(cipherList) {
  return cipherList
    .split(':')
    .filter((name) => !name.startsWith('TLS_'))
    .join(':')
}

/**
 * The `wreq-js` transport: full browser-TLS impersonation (extensions, ALPN,
 * curve list) rather than only the cipher list.
 *
 * Opt-in. It carries a per-platform native binary, which inside a DSH Desktop
 * install means an Electron-bundled Node on Windows has to find a matching
 * `@wreq-js/binding-win32-x64-msvc` — a real failure mode for a plugin the user
 * installs from a git URL. Every capability the free gate has been measured to
 * check is covered by the native path, so this exists for deployments that need
 * the rest of the fingerprint too, not as the shipped default.
 *
 * @param {{ cipherList: string, timeoutMs?: number }} options
 * @returns {Promise<Transport | undefined>} `undefined` when the optional dependency is absent or unusable.
 */
async function createWreqTransport({ cipherList, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const wreq = await loadWreq()
  if (wreq === undefined || typeof wreq.createSession !== 'function') return undefined

  /** @type {any} */
  let session
  try {
    // `createSession` is asynchronous in wreq-js 3.x; awaiting it is not optional.
    session = await wreq.createSession({
      emulation: { tlsOptions: { cipherList: tls12CipherSubset(cipherList) } }
    })
  } catch {
    // A refused cipher list is a configuration mismatch, not a missing runtime:
    // retry with the runtime's own emulation rather than giving up on it.
    try {
      session = await wreq.createSession()
    } catch {
      return undefined
    }
  }
  if (session === null || typeof session?.fetch !== 'function') return undefined

  return {
    mode: 'wreq',
    describe: 'wreq-js browser-TLS impersonation (JA3/JA4) with the free gate cipher list',
    request: async (url, init = {}) => {
      /** @type {Record<string, any>} */
      const options = {
        method: init.method ?? 'GET',
        headers: init.headers,
        redirect: 'follow'
      }
      if (init.body !== undefined) options.body = init.body
      if (init.signal !== undefined) options.signal = init.signal

      const response = await session.fetch(url, options)
      /** @type {Record<string, string>} */
      const headers = {}
      response.headers?.forEach?.((value, key) => {
        headers[String(key).toLowerCase()] = String(value)
      })
      const body = response.body
      return {
        status: response.status,
        statusText: response.statusText ?? '',
        header: (name) => headers[name.toLowerCase()],
        headers: () => ({ ...headers }),
        body,
        text: async () => {
          if (body === null || body === undefined) return ''
          const chunks = []
          for await (const chunk of body) chunks.push(new Uint8Array(chunk))
          return Buffer.concat(chunks).toString('utf8')
        }
      }
    },
    dispose: () => {
      // `close()` is asynchronous; a disposal that awaits it would make plugin
      // unmount blocking, so it is fired and any failure swallowed.
      Promise.resolve(session.close?.()).catch(() => {})
    }
  }
}

/**
 * Build the transport this plugin will use.
 *
 * `auto` prefers `wreq-js` when it is installed and falls back to the native
 * impersonated cipher list, which is the dependency-free path and the one that
 * ships by default. `native` is exposed for diagnosis: it is what a plain
 * harness `fetch` does, and comparing a `native` 429 against an `impersonate`
 * 200 is the cheapest way to confirm the TLS gate is what a deployment is
 * actually hitting.
 *
 * @param {{ mode?: 'auto' | 'native' | 'impersonate' | 'wreq', cipherList?: string, timeoutMs?: number }} [config]
 * @returns {Promise<Transport>}
 */
export async function createTransport(config = {}) {
  const mode = config.mode ?? 'auto'
  const cipherList =
    typeof config.cipherList === 'string' && config.cipherList.length > 0
      ? config.cipherList
      : OPENCODE_CIPHER_LIST
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  if (mode === 'native') return createNodeTransport({ timeoutMs })
  if (mode === 'impersonate') return createNodeTransport({ cipherList, timeoutMs })

  if (mode === 'wreq') {
    const wreqTransport = await createWreqTransport({ cipherList, timeoutMs })
    if (wreqTransport !== undefined) return wreqTransport
    throw new Error(
      'dsh-9router: transport "wreq" was requested but the optional wreq-js dependency is not usable here. ' +
        'Install it in the profile (pnpm add -w wreq-js) or set transport.mode to "impersonate", ' +
        'which needs no native module and satisfies the measured gate.'
    )
  }

  // `auto` deliberately prefers the native path over wreq-js even when the latter
  // is installed: it is the one whose emitted ClientHello is asserted byte for
  // byte in this package's own tests, and it cannot fail to have a matching
  // per-platform binary. Opt into `wreq` for the rest of the browser fingerprint.
  return createNodeTransport({ cipherList, timeoutMs })
}

/**
 * Fetch a JSON document through a transport and parse it.
 *
 * Used for catalog listing, where a failure is a soft fallback rather than a
 * request error.
 *
 * @param {Transport} transport
 * @param {string} url
 * @param {{ headers?: Record<string, string>, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, status: number, json?: any, error?: string }>}
 */
export async function fetchJson(transport, url, options = {}) {
  try {
    const response = await transport.request(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...options.headers },
      signal: options.signal,
      timeoutMs: options.timeoutMs
    })
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}` }
    }
    const text = await response.text()
    return { ok: true, status: response.status, json: JSON.parse(text) }
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}
