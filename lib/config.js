/**
 * Plugin configuration: resolution, validation and defaults.
 *
 * Every field is optional and the empty config is the useful one — an anonymous
 * free lane with the fingerprint on, the live catalog on, and the verified TLS
 * cipher list. Values are validated here rather than mid-request, so a typo in
 * `cordis.patch.yml` fails plugin loading with a message naming the field
 * instead of surfacing as an opaque provider error three turns later.
 *
 * @module dsh-9router/config
 */

import os from 'node:os'
import path from 'node:path'
import { OPENCODE_CIPHER_LIST } from './transport.js'
import { OPENCODE_USER_AGENT } from './fingerprint.js'

/** Provider route this plugin owns by default. */
export const DEFAULT_PROVIDER = 'opencode-free'

/**
 * Endpoint root of the free lane.
 *
 * Deliberately the bare origin: `adapter.js` appends `/inference/v1/<lane>`, so
 * one value serves all three protocols. The historical `/zen/v1` root still
 * answers `/models` but 403s every free completion, which is why it is not the
 * default.
 */
export const DEFAULT_BASE_URL = 'https://opencode.ai'

/** Listing endpoints tried in order; the free lane moved once already. */
export const DEFAULT_MODELS_URLS = [
  'https://opencode.ai/inference/v1/models',
  'https://opencode.ai/zen/v1/models'
]

/** Where per-model cost and capacity metadata comes from. */
export const DEFAULT_DEV_URL = 'https://models.dev/api.json'

/**
 * Credential reference resolved per request.
 *
 * The same variable name OpenCode itself uses, so one exported key serves both.
 * An unset variable is *not* an error here — it selects the anonymous free lane.
 */
export const DEFAULT_API_KEY_ENV = 'OPENCODE_API_KEY'

const DEFAULT_CATALOG_TTL_MS = 60 * 60 * 1000
const DEFAULT_CATALOG_TIMEOUT_MS = 8_000
const DEFAULT_CONTEXT_WINDOW = 262_144
const DEFAULT_MAX_TOKENS = 32_768
const DEFAULT_TRANSPORT_TIMEOUT_MS = 120_000

/**
 * @typedef {object} ResolvedConfig
 * @property {string} provider
 * @property {string} displayName
 * @property {string} baseURL
 * @property {string} apiKeyEnv - Empty string means "never look for a key".
 * @property {number} defaultContextWindow
 * @property {number} defaultMaxTokens
 * @property {number | undefined} maxTokens
 * @property {'auto' | 'on' | 'off'} vision
 * @property {boolean} reasoningEcho
 * @property {{ enabled: boolean, modelsUrls: string[], devUrl: string, ttlMs: number, timeoutMs: number, cachePath: string }} catalog
 * @property {{ enabled: boolean, userAgent: string, client: string, project: string, tools: boolean, envMarker: boolean, definitions: object | undefined }} fingerprint
 * @property {{ mode: 'auto' | 'native' | 'impersonate' | 'wreq', cipherList: string, timeoutMs: number }} transport
 * @property {{ mode: string, maxRetries: number } | undefined} retryPolicy
 * @property {{ width: number, height: number, maxBytes: number }} image
 */

/**
 * Validate and complete a plugin config.
 *
 * @param {Record<string, any>} [config]
 * @returns {ResolvedConfig}
 * @throws {Error} Naming the field that cannot be served.
 */
export function resolveConfig(config = {}) {
  const provider = string(config.provider, DEFAULT_PROVIDER, 'provider')
  if (provider.length === 0) throw new Error('dsh-9router: provider must be a non-empty string')

  const baseURL = string(config.baseURL, DEFAULT_BASE_URL, 'baseURL').replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(baseURL)) {
    throw new Error(`dsh-9router: baseURL must be an http(s) URL, got ${JSON.stringify(baseURL)}`)
  }

  const catalog = config.catalog ?? {}
  const fingerprint = config.fingerprint ?? {}
  const transport = config.transport ?? {}
  const image = config.image ?? {}

  const vision = oneOf(config.vision, ['auto', 'on', 'off'], 'auto', 'vision')
  const mode = oneOf(
    transport.mode,
    ['auto', 'native', 'impersonate', 'wreq'],
    'auto',
    'transport.mode'
  )

  const cachePath = resolveCachePath(catalog.cachePath)

  return {
    provider,
    displayName: string(config.displayName, 'OpenCode Free', 'displayName'),
    baseURL,
    apiKeyEnv: string(config.apiKeyEnv, DEFAULT_API_KEY_ENV, 'apiKeyEnv'),
    defaultContextWindow: positiveInteger(
      config.defaultContextWindow,
      DEFAULT_CONTEXT_WINDOW,
      'defaultContextWindow'
    ),
    defaultMaxTokens: positiveInteger(config.defaultMaxTokens, DEFAULT_MAX_TOKENS, 'defaultMaxTokens'),
    ...(config.maxTokens === undefined || config.maxTokens === null
      ? { maxTokens: undefined }
      : { maxTokens: positiveInteger(config.maxTokens, undefined, 'maxTokens') }),
    vision,
    reasoningEcho: boolean(config.reasoningEcho, true, 'reasoningEcho'),
    catalog: {
      enabled: boolean(catalog.enabled, true, 'catalog.enabled'),
      modelsUrls: stringArray(catalog.modelsUrl ?? catalog.modelsUrls, DEFAULT_MODELS_URLS, 'catalog.modelsUrl').map(
        (url) => url.replace(/\/+$/, '')
      ),
      devUrl: string(catalog.devUrl, DEFAULT_DEV_URL, 'catalog.devUrl'),
      ttlMs: nonNegativeNumber(catalog.ttlMs, DEFAULT_CATALOG_TTL_MS, 'catalog.ttlMs'),
      timeoutMs: positiveNumber(catalog.timeoutMs, DEFAULT_CATALOG_TIMEOUT_MS, 'catalog.timeoutMs'),
      cachePath
    },
    fingerprint: {
      enabled: boolean(fingerprint.enabled, true, 'fingerprint.enabled'),
      userAgent: string(fingerprint.userAgent, OPENCODE_USER_AGENT, 'fingerprint.userAgent'),
      client: string(fingerprint.client, 'cli', 'fingerprint.client'),
      project: string(fingerprint.project, 'global', 'fingerprint.project'),
      tools: boolean(fingerprint.tools, true, 'fingerprint.tools'),
      envMarker: boolean(fingerprint.envMarker, true, 'fingerprint.envMarker'),
      ...(fingerprint.definitions === undefined || fingerprint.definitions === null
        ? { definitions: undefined }
        : { definitions: fingerprint.definitions })
    },
    transport: {
      mode,
      cipherList: string(transport.cipherList, OPENCODE_CIPHER_LIST, 'transport.cipherList'),
      timeoutMs: positiveNumber(
        transport.timeoutMs,
        DEFAULT_TRANSPORT_TIMEOUT_MS,
        'transport.timeoutMs'
      )
    },
    ...(config.retryPolicy === undefined || config.retryPolicy === null
      ? { retryPolicy: undefined }
      : {
          retryPolicy: {
            mode: oneOf(config.retryPolicy.mode, ['normal', 'always'], 'normal', 'retryPolicy.mode'),
            maxRetries: positiveInteger(config.retryPolicy.maxRetries, 5, 'retryPolicy.maxRetries')
          }
        }),
    image: {
      width: positiveInteger(image.width, 2048, 'image.width'),
      height: positiveInteger(image.height, 2048, 'image.height'),
      maxBytes: positiveInteger(image.maxBytes, 1_048_576, 'image.maxBytes')
    }
  }
}

/**
 * Where the catalog cache lives.
 *
 * An explicit empty string disables the file cache, which is the right choice on
 * a read-only or roaming profile. Otherwise it defaults to the harness home so
 * the picker still has a list on an offline start, and so a DSH Desktop install
 * keeps it beside the rest of its per-user state rather than in the install
 * directory.
 *
 * @param {unknown} configured
 * @returns {string}
 */
export function resolveCachePath(configured) {
  if (typeof configured === 'string') {
    if (configured.length === 0) return ''
    return expandHome(configured)
  }
  const home = process.env.DSH_HOME ?? process.env.DSH_PATH ?? path.join(homedir(), '.dsh')
  return path.join(home, 'cache', 'opencode-free-catalog.json')
}

function homedir() {
  return os.homedir?.() ?? process.env.USERPROFILE ?? process.env.HOME ?? '.'
}

function expandHome(value) {
  return value.startsWith('~/') || value === '~' ? path.join(homedir(), value.slice(1)) : value
}

function string(value, fallback, field) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new Error(`dsh-9router: ${field} must be a string`)
  return value
}

function boolean(value, fallback, field) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new Error(`dsh-9router: ${field} must be a boolean`)
  return value
}

function oneOf(value, allowed, fallback, field) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`dsh-9router: ${field} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`)
  }
  return /** @type {any} */ (value)
}

function positiveInteger(value, fallback, field) {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw new Error(`dsh-9router: ${field} is required`)
    return fallback
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`dsh-9router: ${field} must be a positive integer, got ${JSON.stringify(value)}`)
  }
  return value
}

function positiveNumber(value, fallback, field) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`dsh-9router: ${field} must be a positive number, got ${JSON.stringify(value)}`)
  }
  return value
}

function nonNegativeNumber(value, fallback, field) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`dsh-9router: ${field} must be a non-negative number, got ${JSON.stringify(value)}`)
  }
  return value
}

function stringArray(value, fallback, field) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string') return value.length > 0 ? [value] : fallback
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`dsh-9router: ${field} must be a string or an array of strings`)
  }
  return value.length > 0 ? [...value] : fallback
}
