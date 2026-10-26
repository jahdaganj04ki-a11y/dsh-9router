/**
 * Type declarations for dsh-9router.
 *
 * The package ships plain ESM JavaScript — there is no build step, so a DSH
 * Desktop install from a git source needs no toolchain. These declarations exist
 * for editor support and for downstream TypeScript consumers; they are not
 * emitted by a compiler and must be kept in step by hand.
 *
 * The harness types come from `@deepseek-ai/dsh-llm`, which is an optional peer:
 * it is present inside a DSH profile and absent in a bare checkout, so every
 * reference to it is imported lazily through `Awaited`/`import()` rather than
 * through a top-level import that would fail to resolve.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Which wire protocol one model is served on. */
export type Lane = 'chat' | 'responses' | 'messages'

/** One catalog entry. */
export interface CatalogModel {
  /** The `model` field sent upstream. */
  readonly id: string
  /** Label for the model picker. */
  readonly name: string
  /** One line distinguishing it from similar models. */
  readonly description?: string
  /** Wire protocol this model is served on. */
  readonly lane: Lane
  /** Combined request + response capacity, in tokens. */
  readonly contextWindow: number
  /** Per-response output cap, in tokens. */
  readonly maxOutputTokens: number
  /** Accepted input types. */
  readonly inputModalities: readonly ('text' | 'image')[]
  /** Selectable reasoning levels, least to greatest, or `false` for a model that does not reason. */
  readonly reasoningEfforts: readonly string[] | false
  /** Level materialized when a caller omits one. Must be a member of `reasoningEfforts`. */
  readonly defaultEffort?: string
  /** Whether multi-turn history needs a non-empty `reasoning_content` echo. */
  readonly reasoningEchoRequired?: boolean
  /** Whether the lane only accepts `tool_choice: "auto"` for this model. */
  readonly forceAutoToolChoice?: boolean
}

/** The free-tier client fingerprint configuration. */
export interface FingerprintConfig {
  enabled?: boolean
  userAgent?: string
  client?: string
  project?: string
  tools?: boolean
  envMarker?: boolean
  /** Override the verbatim `read`/`shell` definitions when upstream rewords them. */
  definitions?: Record<string, { description: string, parameters: Record<string, unknown> }>
}

/** Transport selection. */
export interface TransportConfig {
  /**
   * `auto` and `impersonate` use Node's own TLS stack with the cipher list the
   * free gate accepts. `native` sends Node's defaults and is a diagnostic, not an
   * operating mode. `wreq` requires the optional `wreq-js` dependency.
   */
  mode?: 'auto' | 'native' | 'impersonate' | 'wreq'
  cipherList?: string
  timeoutMs?: number
}

/** Live catalog configuration. */
export interface CatalogConfig {
  enabled?: boolean
  modelsUrl?: string | string[]
  devUrl?: string
  ttlMs?: number
  timeoutMs?: number
  /** Absolute path, `~/…`, or `''` to disable the file cache. */
  cachePath?: string
}

/** Plugin configuration. Every field is optional; the empty config is the intended posture. */
export interface Config {
  provider?: string
  displayName?: string
  baseURL?: string
  /** Credential reference (an env var name). Empty string means "never look for a key". */
  apiKeyEnv?: string
  maxTokens?: number
  defaultContextWindow?: number
  defaultMaxTokens?: number
  /**
   * `auto` declares image input only where the catalog says the model accepts it.
   * `off` narrows every route to text, which makes the harness itself substitute
   * its placeholder — the safe path while the free lane intermittently 503s on
   * image input.
   */
  vision?: 'auto' | 'on' | 'off'
  /** Inject a placeholder `reasoning_content` into historical assistant turns. */
  reasoningEcho?: boolean
  catalog?: CatalogConfig
  fingerprint?: FingerprintConfig
  transport?: TransportConfig
  retryPolicy?: { mode?: 'normal' | 'always', maxRetries?: number }
  image?: { width?: number, height?: number, maxBytes?: number }
}

/** One transport, normalized across the native and wreq paths. */
export interface TransportResponse {
  readonly status: number
  readonly statusText: string
  header(name: string): string | undefined
  headers(): Record<string, string>
  /** Live stream; never buffered. */
  readonly body: AsyncIterable<Uint8Array>
  text(): Promise<string>
}

export interface Transport {
  readonly mode: 'native' | 'impersonate' | 'wreq'
  readonly describe: string
  request(
    url: string,
    init?: {
      method?: string
      headers?: Record<string, string>
      body?: string
      signal?: AbortSignal
      timeoutMs?: number
    }
  ): Promise<TransportResponse>
  dispose(): void
}

/** One stable, gate-valid session id per conversation. */
export declare class SessionStore {
  constructor(options?: { max?: number, ttlMs?: number })
  /** A genuine OpenCode id is relayed untouched; anything else is minted once and remembered. */
  resolve(key: unknown): string
  readonly size: number
  dispose(): void
}

/** Where the catalog came from. */
export interface CatalogResult {
  models: CatalogModel[]
  source: 'live' | 'cache' | 'snapshot'
  error?: string
  fetchedAt: number
}

export declare class Catalog {
  constructor(options: {
    transport: Transport
    modelsUrls: string[]
    devUrl?: string
    ttlMs?: number
    timeoutMs?: number
    cachePath?: string
    defaultContextWindow?: number
    defaultMaxTokens?: number
    enabled?: boolean
  })
  list(signal?: AbortSignal): Promise<CatalogResult>
  /** The memoized catalog without fetching, for the per-request hot path. */
  peek(): CatalogModel[]
  invalidate(): void
}

/** The `LlmAdapter` for OpenCode's free lane. */
export declare class OpenCodeFreeAdapter {
  constructor(options: {
    displayName?: string
    connection: () => {
      baseURL: string
      maxTokens?: number
      defaultContextWindow: number
      defaultMaxTokens: number
      fingerprint: boolean
      fingerprintOptions: {
        userAgent: string
        client: string
        project: string
        tools: boolean
        envMarker: boolean
      }
      vision: 'auto' | 'on' | 'off'
      reasoningEcho: boolean
    }
    resolveApiKey: () => Promise<string | undefined>
    catalog: Catalog
    transport: Transport
    resolveAttachments?: () => unknown
    imageTarget?: () => { width: number, height: number, maxBytes: number }
    retryPolicy?: unknown
    onDiagnostic?: (event: string, detail?: string) => void
  })
  disposeSessions(): void
}

// ---------------------------------------------------------------------------
// Cordis plugin surface
// ---------------------------------------------------------------------------

/** The loader entry name; must match the `name` in `cordis.patch.yml`. */
export declare const name: string

/** Wait for the LLM service — without it this plugin has nothing to register into. */
export declare const inject: string[]

/** Mount the provider route. */
export declare function apply(ctx: Context, config?: Config): void

// ---------------------------------------------------------------------------
// Named exports
// ---------------------------------------------------------------------------

export declare const DEFAULT_PROVIDER: string
export declare const DEFAULT_BASE_URL: string
export declare function resolveConfig(config?: Config): Required<Omit<Config, 'maxTokens' | 'retryPolicy'>> & {
  maxTokens?: number
  retryPolicy?: { mode: string, maxRetries: number }
}

export declare const OPENCODE_USER_AGENT: string
export declare const OPENCODE_CLIENT: string
export declare const FREE_TIER_KEY: string
export declare const OPENCODE_CIPHER_LIST: string
export declare const FINGERPRINT_TOOL_NAMES: string[]
export declare const FINGERPRINT_TOOL_DEFINITIONS: Record<string, { description: string, parameters: Record<string, unknown> }>
export declare const SNAPSHOT_MODELS: readonly CatalogModel[]
export declare const DEFAULT_FREE_EFFORTS: readonly string[]

export declare function mintSessionId(timestamp?: number): string
export declare function isGateSessionId(id: unknown): boolean
export declare function isV2UserAgent(ua: unknown): boolean
export declare function descendingTimeHex(timeMs: number, counterValue: number): string
export declare function fingerprintHeaders(input: {
  session: string
  stream?: boolean
  userAgent?: string
  client?: string
  project?: string
  apiKey?: string
  extra?: Record<string, string>
  anthropic?: boolean
}): Record<string, string>
export declare function applyFingerprintTools(
  body: Record<string, any>,
  flat: boolean,
  options?: { claude?: boolean, tools?: boolean, envMarker?: boolean, prompt?: string, definitions?: object }
): Map<string, string>
export declare function restoreToolNames(payload: any, map: Map<string, string> | null | undefined): any

export declare function createTransport(config?: TransportConfig): Promise<Transport>
export declare function tls12CipherSubset(cipherList: string): string
export declare function fetchJson(
  transport: Transport,
  url: string,
  options?: { headers?: Record<string, string>, signal?: AbortSignal, timeoutMs?: number }
): Promise<{ ok: boolean, status: number, json?: any, error?: string }>

export declare function endpointFor(baseURL: string, lane: Lane): string
export declare function baseModelId(id: string): string
export declare function isFreeModelId(id: string): boolean
export declare function laneForModel(id: string): Lane
export declare function resolveEffort(requested: string | undefined, supported: readonly string[] | false | undefined): string | undefined
export declare function resolveMaxTokens(candidates: (number | undefined)[]): number | undefined
export declare function parseModelsListing(json: any): { id: string, name?: string, contextWindow?: number, maxTokens?: number, inputModalities?: string[] }[]
