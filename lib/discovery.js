/**
 * Live catalog discovery: which models the free lane serves *right now*, and how
 * large they are.
 *
 * Two upstream sources answer two different questions, and neither answers both:
 *
 * - OpenCode's own `/models` listing says which ids exist. It discloses an id and
 *   usually nothing else — no capacity, no modalities, no price.
 * - `models.dev` publishes per-model metadata including cost. A zero cost is the
 *   only machine-readable statement that a model is on the free offer, which
 *   OpenCode's listing does not make.
 *
 * The catalog is their intersection: an id both sources know, with a zero cost.
 * That keeps a retired model out of the picker and keeps a paid model from being
 * advertised as free. The bundled snapshot in `catalog.js` then supplies the
 * capacity, modality and reasoning metadata the listing omits, and the file cache
 * keeps the picker populated when the machine is offline.
 *
 * Everything here is a soft enhancement: a network failure falls back to the
 * cache, then to the snapshot, and never fails a model request.
 *
 * @module dsh-9router/discovery
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fetchJson } from './transport.js'
import {
  EXCLUDED_IDS,
  SNAPSHOT_MODELS,
  baseModelId,
  findModel,
  isFreeModelId,
  mergeLiveInto,
  synthesizeModel
} from './catalog.js'

const DEFAULT_TTL_MS = 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 8_000

/**
 * @typedef {object} CatalogResult
 * @property {import('./catalog.js').CatalogModel[]} models
 * @property {'live' | 'cache' | 'snapshot'} source - Where this list came from.
 * @property {string} [error] - Why the live fetch was not used, when it was not.
 * @property {number} fetchedAt - Epoch ms of the underlying data.
 */

/**
 * The free-model catalog, fetched live with a TTL, a file cache and a snapshot
 * fallback.
 */
export class Catalog {
  #transport
  #modelsUrls
  #devUrl
  #ttlMs
  #timeoutMs
  #cachePath
  #defaultContextWindow
  #defaultMaxTokens
  #enabled

  /** @type {CatalogResult | undefined} */
  #memo
  #inflight

  /**
   * @param {object} options
   * @param {import('./transport.js').Transport} options.transport
   * @param {string[]} options.modelsUrls - Listing endpoints, tried in order.
   * @param {string} [options.devUrl] - `models.dev` metadata endpoint.
   * @param {number} [options.ttlMs]
   * @param {number} [options.timeoutMs]
   * @param {string} [options.cachePath] - Empty string disables the file cache.
   * @param {number} [options.defaultContextWindow]
   * @param {number} [options.defaultMaxTokens]
   * @param {boolean} [options.enabled]
   */
  constructor({
    transport,
    modelsUrls,
    devUrl = 'https://models.dev/api.json',
    ttlMs = DEFAULT_TTL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cachePath = '',
    defaultContextWindow = 262_144,
    defaultMaxTokens = 32_768,
    enabled = true
  }) {
    this.#transport = transport
    this.#modelsUrls = modelsUrls
    this.#devUrl = devUrl
    this.#ttlMs = ttlMs
    this.#timeoutMs = timeoutMs
    this.#cachePath = cachePath
    this.#defaultContextWindow = defaultContextWindow
    this.#defaultMaxTokens = defaultMaxTokens
    this.#enabled = enabled
  }

  /**
   * The current catalog, refreshing when the memo is older than the TTL.
   *
   * Concurrent callers share one fetch, so opening the model picker while a
   * request resolves does not double the upstream load.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<CatalogResult>}
   */
  async list(signal) {
    if (!this.#enabled) return this.#snapshot('snapshot')
    if (this.#memo !== undefined && Date.now() - this.#memo.fetchedAt < this.#ttlMs) return this.#memo
    if (this.#inflight !== undefined) return this.#inflight

    this.#inflight = this.#refresh(signal)
      .then((result) => {
        this.#memo = result
        return result
      })
      .catch((error) => {
        // A failed refresh must not poison the memo: fall back instead.
        return this.#fallback(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        this.#inflight = undefined
      })
    return this.#inflight
  }

  /**
   * The memoized catalog without fetching, for the hot path.
   *
   * A per-turn model lookup only needs the output cap; spending a network round
   * trip on it would add latency to every request, so `stream()` peeks instead
   * and falls back to defaults when nothing is memoized yet.
   *
   * @returns {import('./catalog.js').CatalogModel[]}
   */
  peek() {
    return this.#memo?.models ?? [...SNAPSHOT_MODELS]
  }

  /** Drop the memo so the next `list()` refetches. */
  invalidate() {
    this.#memo = undefined
  }

  async #refresh(signal) {
    const listing = await this.#fetchListing(signal)
    if (listing === undefined) throw new Error('no reachable /models endpoint')

    const dev = await this.#fetchDevMetadata(signal)
    const models = this.#compose(listing, dev)
    if (models.length === 0) throw new Error('the live listing produced no free models')

    const result = { models, source: /** @type {const} */ ('live'), fetchedAt: Date.now() }
    // Persist in the background: a slow or read-only filesystem must not delay
    // the picker that is waiting on this list.
    void this.#writeCache(result)
    return result
  }

  /** Try each listing endpoint in order; the free lane moved once already. */
  async #fetchListing(signal) {
    for (const url of this.#modelsUrls) {
      const response = await fetchJson(this.#transport, url, {
        signal,
        timeoutMs: this.#timeoutMs,
        headers: { 'user-agent': 'opencode/latest/2.0.26/cli' }
      })
      if (!response.ok) continue
      const ids = parseModelsListing(response.json)
      if (ids.length > 0) return { url, entries: ids }
    }
    return undefined
  }

  /**
   * `models.dev` metadata, used for the free/paid verdict and for capacities the
   * listing omits. Absent metadata degrades to the snapshot rather than failing.
   */
  async #fetchDevMetadata(signal) {
    if (this.#devUrl.length === 0) return undefined
    const response = await fetchJson(this.#transport, this.#devUrl, {
      signal,
      timeoutMs: this.#timeoutMs
    })
    if (!response.ok) return undefined
    return extractOpencodeMetadata(response.json)
  }

  /**
   * Intersect the live listing with the zero-cost verdict, then enrich.
   *
   * @param {{ url: string, entries: { id: string, name?: string, contextWindow?: number, maxTokens?: number, inputModalities?: string[] }[] }} listing
   * @param {Map<string, any> | undefined} dev
   */
  #compose(listing, dev) {
    /** @type {import('./catalog.js').CatalogModel[]} */
    const out = []
    const seen = new Set()

    for (const entry of listing.entries) {
      const id = baseModelId(entry.id)
      if (id.length === 0 || seen.has(id) || EXCLUDED_IDS.has(id)) continue

      const meta = dev?.get(id)
      // With metadata available, a zero cost is the free verdict — that is the
      // only machine-readable statement of the offer, and OpenCode's own listing
      // does not make it. Without metadata the id suffix is the fallback signal.
      // Neither source alone is sufficient, which is why both are fetched; but a
      // paid id must never be advertised as free, so the suffix test is not
      // widened to "everything on the zen listing".
      const free = meta !== undefined ? metadataIsFree(meta) : isFreeModelId(id)
      if (!free) continue

      seen.add(id)
      const known = findModel(SNAPSHOT_MODELS, id)
      const live = {
        name: entry.name ?? meta?.name,
        contextWindow: entry.contextWindow ?? metadataContext(meta),
        maxTokens: entry.maxTokens ?? metadataOutput(meta),
        inputModalities: entry.inputModalities ?? metadataModalities(meta)
      }
      out.push(
        known !== undefined
          ? mergeLiveInto(known, live)
          : synthesizeModel(id, live, {
              defaultContextWindow: this.#defaultContextWindow,
              defaultMaxTokens: this.#defaultMaxTokens
            })
      )
    }

    out.sort((a, b) => b.contextWindow - a.contextWindow)
    return out
  }

  async #fallback(reason) {
    const cached = await this.#readCache()
    if (cached !== undefined && cached.models.length > 0) {
      return { ...cached, source: /** @type {const} */ ('cache'), error: reason }
    }
    return this.#snapshot('snapshot', reason)
  }

  #snapshot(source, error) {
    return { models: [...SNAPSHOT_MODELS], source, ...(error === undefined ? {} : { error }), fetchedAt: 0 }
  }

  async #readCache() {
    if (this.#cachePath.length === 0) return undefined
    try {
      const raw = await readFile(this.#cachePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed?.models)) return undefined
      return { models: parsed.models, fetchedAt: Number(parsed.fetchedAt) || 0 }
    } catch {
      return undefined
    }
  }

  async #writeCache(result) {
    if (this.#cachePath.length === 0) return
    try {
      await mkdir(path.dirname(this.#cachePath), { recursive: true })
      await writeFile(
        this.#cachePath,
        JSON.stringify({ fetchedAt: result.fetchedAt, models: result.models }),
        'utf8'
      )
    } catch {
      // A read-only or missing home directory must not break the catalog.
    }
  }
}

/**
 * Parse an OpenAI-shaped `/models` reply, accepting either the standard `data`
 * array or an enriched `models` map — gateways publish both spellings.
 *
 * @param {any} json
 * @returns {{ id: string, name?: string, contextWindow?: number, maxTokens?: number, inputModalities?: string[] }[]}
 */
export function parseModelsListing(json) {
  /** @type {{ id: string, name?: string, contextWindow?: number, maxTokens?: number, inputModalities?: string[] }[]} */
  const out = []
  const push = (id, entry) => {
    if (typeof id !== 'string' || id.length === 0) return
    const contextWindow = pickNumber(entry, ['context_window', 'context_length', 'contextWindow', 'context'])
    const maxTokens = pickNumber(entry, ['max_output_tokens', 'max_tokens', 'maxOutputTokens', 'max_completion_tokens'])
    const modalities = pickModalities(entry)
    out.push({
      id,
      ...(typeof entry?.name === 'string' ? { name: entry.name } : {}),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(modalities === undefined ? {} : { inputModalities: modalities })
    })
  }

  if (Array.isArray(json?.data)) {
    for (const entry of json.data) push(entry?.id, entry)
    return out
  }
  if (Array.isArray(json?.models)) {
    for (const entry of json.models) push(entry?.id, entry)
    return out
  }
  const map = json?.models ?? json?.data
  if (map !== null && typeof map === 'object') {
    for (const [key, value] of Object.entries(map)) {
      // A map key stays the request id even when its entry names a different
      // canonical id; primitive-valued properties are ignored.
      push(key, value !== null && typeof value === 'object' ? value : undefined)
    }
  }
  return out
}

/**
 * Pull the `opencode` provider's model metadata out of a `models.dev` document.
 *
 * @param {any} json
 * @returns {Map<string, any> | undefined}
 */
export function extractOpencodeMetadata(json) {
  const providers = json?.opencode ?? json?.providers?.opencode
  const models = providers?.models
  if (models === null || typeof models !== 'object') return undefined
  const out = new Map()
  for (const [id, meta] of Object.entries(models)) {
    if (meta !== null && typeof meta === 'object') out.set(baseModelId(id), meta)
  }
  return out.size > 0 ? out : undefined
}

/** Whether a metadata entry states a zero-cost offer. */
export function metadataIsFree(meta) {
  const cost = meta?.cost
  if (cost === null || typeof cost !== 'object') return false
  const values = Object.values(cost).filter((value) => typeof value === 'number')
  if (values.length === 0) return false
  return values.every((value) => value === 0)
}

function metadataContext(meta) {
  return pickNumber(meta?.limit ?? meta, ['context', 'context_window', 'contextWindow'])
}

function metadataOutput(meta) {
  return pickNumber(meta?.limit ?? meta, ['output', 'max_output_tokens', 'maxTokens'])
}

function metadataModalities(meta) {
  const input = meta?.modalities?.input ?? meta?.input
  return Array.isArray(input) ? input.map((entry) => String(entry)) : undefined
}

function pickNumber(source, keys) {
  if (source === null || typeof source !== 'object') return undefined
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  }
  return undefined
}

function pickModalities(entry) {
  const input = entry?.modalities?.input ?? entry?.input ?? entry?.input_modalities
  return Array.isArray(input) && input.length > 0 ? input.map((value) => String(value)) : undefined
}
