/**
 * The TLS gate: Node must emit the cipher list the free lane accepts.
 *
 * The free lane keys on the TLS ClientHello, not only on HTTP. Measured on one
 * process and one egress IP, the same body and headers that pass from the
 * official CLI come back `429 FreeUsageLimitError` on Node's stock OpenSSL
 * fingerprint and pass again once the cipher list matches Bun's BoringSSL one.
 * JA4 identifies the list by its cipher hash, so the emitted `cipher_suites`
 * field is the thing that must match — and this test parses a real ClientHello
 * off a real socket to prove that it does, in order, with no GREASE inserted.
 *
 * That matters for a DSH Desktop plugin specifically: it means the impersonation
 * needs no native module, so there is nothing to fail on a Windows install into
 * an Electron-bundled Node.
 */

import assert from 'node:assert/strict'
import net from 'node:net'
import tls from 'node:tls'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { OPENCODE_CIPHER_LIST, createTransport } from '../lib/transport.js'

const TARGET = OPENCODE_CIPHER_LIST.split(':')

/** IANA code points for the suites in the target list, plus GREASE values. */
const CODE_POINTS = {
  0x1301: 'TLS_AES_128_GCM_SHA256',
  0x1302: 'TLS_AES_256_GCM_SHA384',
  0x1303: 'TLS_CHACHA20_POLY1305_SHA256',
  0xc02b: 'ECDHE-ECDSA-AES128-GCM-SHA256',
  0xc02f: 'ECDHE-RSA-AES128-GCM-SHA256',
  0xc02c: 'ECDHE-ECDSA-AES256-GCM-SHA384',
  0xc030: 'ECDHE-RSA-AES256-GCM-SHA384',
  0xcca9: 'ECDHE-ECDSA-CHACHA20-POLY1305',
  0xcca8: 'ECDHE-RSA-CHACHA20-POLY1305',
  0xc009: 'ECDHE-ECDSA-AES128-SHA',
  0xc013: 'ECDHE-RSA-AES128-SHA',
  0xc00a: 'ECDHE-ECDSA-AES256-SHA',
  0xc014: 'ECDHE-RSA-AES256-SHA',
  0x009c: 'AES128-GCM-SHA256',
  0x009d: 'AES256-GCM-SHA384',
  0x002f: 'AES128-SHA',
  0x0035: 'AES256-SHA'
}

const isGrease = (value) =>
  value >= 0x0a0a && value <= 0xfafa && (value & 0x0f0f) === 0x0a0a

/**
 * Parse the `cipher_suites` field out of a raw ClientHello record.
 *
 * @param {Buffer} buffer - The first bytes the client sent.
 * @returns {{ codes: number[], names: string[] } | undefined}
 */
function parseClientHello(buffer) {
  if (buffer.length < 6 || buffer[0] !== 0x16) return undefined // not a handshake record
  let offset = 5 // record header: type, version, length
  if (buffer[offset] !== 0x01) return undefined // not a ClientHello
  offset += 4 // handshake type + 3-byte length
  offset += 2 // client version
  offset += 32 // random
  const sessionIdLength = buffer[offset]
  offset += 1 + sessionIdLength
  const cipherLength = buffer.readUInt16BE(offset)
  offset += 2
  /** @type {number[]} */
  const codes = []
  for (let i = 0; i < cipherLength; i += 2) codes.push(buffer.readUInt16BE(offset + i))
  return { codes, names: codes.map((code) => (isGrease(code) ? 'GREASE' : CODE_POINTS[code] ?? `0x${code.toString(16)}`)) }
}

function selfSignedCertificate() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-9router-tls-'))
  const keyPath = path.join(dir, 'key.pem')
  const certPath = path.join(dir, 'cert.pem')
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes', '-subj', '/CN=localhost'],
    { stdio: 'ignore' }
  )
  return { key: readFileSync(keyPath), cert: readFileSync(certPath), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * Capture the ClientHello a `tls.connect` actually sends.
 *
 * Uses a bare TCP server rather than a TLS one, so the bytes are read before any
 * stack interprets them.
 *
 * @param {object} connectOptions
 * @returns {Promise<{ codes: number[], names: string[] } | undefined>}
 */
async function captureClientHello(connectOptions) {
  const { key, cert, cleanup } = selfSignedCertificate()
  void cert // The server never completes a handshake; it only reads the hello.
  void key
  try {
    return await new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.once('data', (data) => {
          socket.destroy()
          server.close()
          resolve(parseClientHello(data))
        })
        socket.on('error', () => {})
      })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const socket = tls.connect(
          { host: '127.0.0.1', port: server.address().port, rejectUnauthorized: false, ...connectOptions },
          () => socket.destroy()
        )
        socket.on('error', () => {
          // Expected: the server never answers the hello.
        })
      })
    })
  } finally {
    cleanup()
  }
}

test('the impersonated cipher list is emitted verbatim, in order, with no GREASE', async () => {
  const hello = await captureClientHello({ ciphers: OPENCODE_CIPHER_LIST, servername: 'localhost' })
  assert.ok(hello !== undefined, 'no ClientHello was captured')

  const grease = hello.names.filter((name) => name === 'GREASE')
  assert.equal(grease.length, 0, `GREASE was inserted into the cipher list: ${JSON.stringify(hello.names)}`)

  assert.deepEqual(
    hello.names,
    TARGET,
    'Node must emit exactly the suites the free lane accepts, in the order Bun sends them'
  )
  assert.equal(hello.codes.length, TARGET.length)
})

test('stock Node ciphers differ from the target list, which is why the gate sees them', async () => {
  const hello = await captureClientHello({ servername: 'localhost' })
  assert.ok(hello !== undefined)
  // Node's default list carries GREASE and a different suite order; either alone
  // changes the JA4 cipher hash and therefore the gate's verdict.
  const differs =
    hello.names.length !== TARGET.length ||
    hello.names.some((name, index) => name !== TARGET[index]) ||
    hello.names.includes('GREASE')
  assert.ok(differs, 'the default list unexpectedly matched the target; the test no longer proves anything')
})

test('createTransport honours the requested mode and stays dependency-free by default', async () => {
  const impersonate = await createTransport({ mode: 'impersonate' })
  assert.equal(impersonate.mode, 'impersonate')
  assert.match(impersonate.describe, /cipher list/)
  impersonate.dispose()

  const native = await createTransport({ mode: 'native' })
  assert.equal(native.mode, 'native')
  assert.match(native.describe, /stock OpenSSL/)
  native.dispose()

  // `auto` prefers the native path even when wreq-js is installed: it is the one
  // whose emitted ClientHello this file asserts byte for byte, and it cannot fail
  // to have a matching per-platform binary inside an Electron-bundled Node.
  const auto = await createTransport({ mode: 'auto' })
  assert.equal(auto.mode, 'impersonate')
  auto.dispose()
})

test('an explicit wreq transport is awaited correctly or refused loudly', async () => {
  // `createSession` returns a Promise in wreq-js 3.x; using it un-awaited yields
  // an object with no `fetch`, which is exactly the silent failure this guards.
  const wreqAvailable = await import('wreq-js').then(
    (module) => typeof module.createSession === 'function',
    () => false
  )
  if (wreqAvailable) {
    const transport = await createTransport({ mode: 'wreq' })
    assert.equal(transport.mode, 'wreq')
    transport.dispose()
  } else {
    await assert.rejects(
      async () => createTransport({ mode: 'wreq' }),
      /wreq-js/,
      'an explicitly requested wreq transport must fail loudly when the dependency is missing'
    )
  }
})

test('the wreq cipher subset drops the TLS 1.3 names rustls refuses', async () => {
  const { tls12CipherSubset } = await import('../lib/transport.js')
  const subset = tls12CipherSubset(OPENCODE_CIPHER_LIST)
  assert.ok(!subset.includes('TLS_AES_128_GCM_SHA256'), 'rustls fixes the TLS 1.3 suites itself')
  assert.ok(subset.includes('ECDHE-RSA-AES128-GCM-SHA256'))
  assert.equal(subset.split(':').length, OPENCODE_CIPHER_LIST.split(':').length - 3)
})

test('the native impersonated path needs no dependency at all', async () => {
  // The shipped default must work on a machine where the optional native module
  // could not be installed — which on Windows, inside an Electron-bundled Node,
  // is the most likely failure mode for a plugin carrying a binary dependency.
  const transport = await createTransport({ mode: 'impersonate' })
  assert.equal(transport.mode, 'impersonate')
  const http = await import('node:http')
  const server = http.createServer((_req, res) => res.end('ok'))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await transport.request(`http://127.0.0.1:${server.address().port}/`, {})
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'ok')
  } finally {
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) })
    transport.dispose()
  }
})

test('the transport performs a real request and streams the body', async (t) => {
  const http = await import('node:http')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"a":1}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }))

  const transport = await createTransport({ mode: 'native' })
  t.after(() => transport.dispose())

  const response = await transport.request(`http://127.0.0.1:${server.address().port}/x`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })
  assert.equal(response.status, 200)
  assert.equal(response.header('content-type'), 'text/event-stream')

  let text = ''
  for await (const chunk of response.body) text += Buffer.from(chunk).toString('utf8')
  assert.match(text, /"a":1/)
  assert.match(text, /\[DONE\]/)
})
