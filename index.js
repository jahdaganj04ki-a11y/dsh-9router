/**
 * dsh-9router — OpenCode's free models as a DeepSeek Harness provider route.
 *
 * Mounts one `LlmAdapter` that speaks OpenCode's free lane the way the official
 * client does, so the free models become selectable in DSH Desktop's model picker
 * and usable in a full agent loop instead of failing with
 * `FreeTierError: "OpenCode's free tier can only be used from within OpenCode"`.
 *
 * Zero configuration is the intended posture: the defaults already describe the
 * anonymous free lane, its endpoint, its client fingerprint, its TLS cipher list
 * and a live model catalog. Install the plugin, restart DSH Desktop once, and the
 * models appear.
 *
 * @module dsh-9router
 */

import { resolveConfig } from './lib/config.js'
import { OpenCodeFreeAdapter, endpointFor } from './lib/adapter.js'
import { Catalog } from './lib/discovery.js'
import { createTransport, fetchJson, OPENCODE_CIPHER_LIST } from './lib/transport.js'
import {
  FINGERPRINT_TOOL_NAMES,
  SessionStore,
  fingerprintHeaders,
  isGateSessionId,
  mintSessionId
} from './lib/fingerprint.js'
import { SNAPSHOT_MODELS, isFreeModelId, laneForModel, resolveEffort } from './lib/catalog.js'

export { OpenCodeFreeAdapter, endpointFor, describeFailure } from './lib/adapter.js'
export { Catalog, parseModelsListing } from './lib/discovery.js'
export { createTransport, OPENCODE_CIPHER_LIST, fetchJson } from './lib/transport.js'
export {
  FINGERPRINT_TOOL_DEFINITIONS,
  FINGERPRINT_TOOL_NAMES,
  OPENCODE_USER_AGENT,
  SessionStore,
  applyFingerprintTools,
  fingerprintHeaders,
  isGateSessionId,
  isV2UserAgent,
  mintSessionId
} from './lib/fingerprint.js'
export { SNAPSHOT_MODELS, isFreeModelId, laneForModel, resolveEffort } from './lib/catalog.js'
export { resolveConfig, DEFAULT_PROVIDER, DEFAULT_BASE_URL } from './lib/config.js'

/** The loader entry name; must match the `name` in `cordis.patch.yml`. */
export const name = 'dsh-9router'

/** Wait for the LLM service — without it this plugin has nothing to register into. */
export const inject = ['llm']

/**
 * Mount the provider route.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, any>} [config]
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)

  // The settings namespace is the loader entry id inside a real profile, exactly
  // as `llm-pi-ai` derives its own. Outside one — a bare context, a test, a host
  // that mounts the package directly — there is no entry id, and a constant
  // fallback would collapse every mount into one namespace: two routes would
  // share a directory row and a discovery offer, and disposing one could withdraw
  // the other's. The provider route is the right fallback because
  // `registerAdapter` already refuses to register the same route twice, so it is
  // unique by construction. With the shipped defaults the two agree anyway: the
  // entry id in `cordis.patch.yml` and the provider are both `opencode-free`.
  const settingsNs = ctx.fiber?.entry?.options?.id ?? resolved.provider

  // The transport is created lazily because building it can be asynchronous
  // (the optional wreq-js path) while a Cordis `apply` is not. Nothing here
  // awaits: the first request resolves it and every later one reuses it.
  const transport = createLazyTransport(resolved.transport, (message) =>
    ctx.logger?.warn?.('dsh-9router: %s', message)
  )

  const catalog = new Catalog({
    transport,
    modelsUrls: resolved.catalog.modelsUrls,
    devUrl: resolved.catalog.devUrl,
    ttlMs: resolved.catalog.ttlMs,
    timeoutMs: resolved.catalog.timeoutMs,
    cachePath: resolved.catalog.cachePath,
    defaultContextWindow: resolved.defaultContextWindow,
    defaultMaxTokens: resolved.defaultMaxTokens,
    enabled: resolved.catalog.enabled
  })

  /**
   * Resolve the credential for one request.
   *
   * Returning `undefined` is the interesting case, not an error: it selects the
   * anonymous free lane, which is what makes this plugin work with nothing
   * configured. The lookup order matches the harness's own — the credential store
   * first (that is where the web Models page writes a key), then the launch
   * environment, then the process environment.
   */
  const resolveApiKey = async () => {
    const ref = resolved.apiKeyEnv
    if (ref.length === 0) return undefined

    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(ref)
        if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
      } catch {
        // An unreadable credential store must not take the free lane down.
      }
    }

    const launchEnvironment = ctx.get('launchEnvironment')
    const fromLaunch = launchEnvironment?.get?.(ref)?.value
    if (typeof fromLaunch === 'string' && fromLaunch.length > 0) return fromLaunch

    const ambient = process.env[ref]
    return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
  }

  const adapter = new OpenCodeFreeAdapter({
    displayName: resolved.displayName,
    connection: () => ({
      baseURL: resolved.baseURL,
      ...(resolved.maxTokens === undefined ? {} : { maxTokens: resolved.maxTokens }),
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
    resolveApiKey,
    catalog,
    transport,
    resolveAttachments: () => ctx.get('attachments'),
    imageTarget: () => resolved.image,
    // Captured with the route registration, so it is answerable synchronously
    // from the adapter rather than resolved per request. The code list is the
    // harness's own default retryable set, which is what this lane needs: a 429,
    // a 5xx, a dropped stream and a degenerate empty completion are all worth
    // repeating, while an AUTH or INVALID_REQUEST failure is not.
    ...(resolved.retryPolicy === undefined
      ? {}
      : {
          retryPolicy: {
            mode: resolved.retryPolicy.mode,
            initialDelayMs: 500,
            maxDelayMs: 10_000,
            jitterRatio: 0.1,
            ...(resolved.retryPolicy.mode === 'normal'
              ? {
                  maxRetries: resolved.retryPolicy.maxRetries,
                  retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']
                }
              : {})
          }
        }),
    onDiagnostic: (event, detail) => {
      if (event === 'request-failed') ctx.logger?.warn?.('dsh-9router: %s', detail)
    }
  })

  ctx.effect(() => ctx.llm.registerAdapter([resolved.provider], adapter), `dsh-9router: ${resolved.provider}`)

  // Register the route in the configurable-provider directory so Settings →
  // Models shows it as a real provider row with its endpoint and credential
  // hints, rather than only appearing as a group in the composer's picker.
  // Guarded: the directory is a presentation convenience, and a refusal here must
  // never stop the adapter that actually serves requests from loading.
  try {
    ctx.effect(
      () =>
        ctx.llm.registerConfigurableProviders([
          {
            provider: resolved.provider,
            displayName: resolved.displayName,
            settingsNs,
            settingsPath: [],
            declared: false,
            defaultBaseURL: endpointFor(resolved.baseURL, 'chat'),
            nativeAuth: {
              env: resolved.apiKeyEnv.length > 0 ? [resolved.apiKeyEnv] : [],
              oauth: false
            }
          }
        ]),
      'dsh-9router: provider directory'
    )
  } catch (error) {
    ctx.logger?.warn?.(
      'dsh-9router: the models settings row could not be registered (%s); the provider route itself is unaffected',
      error instanceof Error ? error.message : String(error)
    )
  }

  // Answer "which models can this endpoint serve?" for the settings page's
  // Fetch-available-models flow, from the live listing rather than a guess.
  try {
    // Registered inside an effect like the other two: `registerModelDiscovery`
    // returns a disposer, and letting it go uncaptured would leave the offer
    // standing after the fiber is disposed — which is what Safe Mode, a plugin
    // removal and an HMR reload all do to this plugin.
    ctx.effect(
      () =>
        ctx.llm.registerModelDiscovery(
          settingsNs,
          async (_request, signal) => {
            const { models } = await catalog.list(signal)
            return models.map((model) => ({
              id: model.id,
              name: model.name,
              contextWindow: model.contextWindow,
              maxTokens: model.maxOutputTokens,
              inputModalities: [...model.inputModalities]
            }))
          }
        ),
      'dsh-9router: model discovery'
    )
  } catch (error) {
    ctx.logger?.warn?.(
      'dsh-9router: model discovery could not be registered (%s); the catalog still serves the picker',
      error instanceof Error ? error.message : String(error)
    )
  }

  // The session store holds a sweep timer and the transport holds a keep-alive
  // agent and possibly a wreq session. All three outlive a request, so all three
  // belong to the fiber rather than to the process: a disposed plugin must not
  // leave a socket pool or a timer behind in a profile that is being torn down.
  ctx.effect(() => {
    adapter.disposeSessions()
    transport.dispose()
  }, 'dsh-9router: transport and session cache')

  ctx.logger?.info?.(
    '[dsh-9router] provider "%s" on %s — fingerprint %s, transport %s, catalog %s, credential %s',
    resolved.provider,
    endpointFor(resolved.baseURL, 'chat'),
    resolved.fingerprint.enabled ? `on (${resolved.fingerprint.userAgent})` : 'off',
    resolved.transport.mode,
    resolved.catalog.enabled ? `live (${resolved.catalog.modelsUrls[0]})` : 'snapshot only',
    resolved.apiKeyEnv.length > 0 ? `${resolved.apiKeyEnv} or anonymous` : 'anonymous'
  )
}

/**
 * A transport whose real implementation is built on first use.
 *
 * Cordis `apply` is synchronous and `createTransport` may await the optional
 * wreq-js import, so the adapter holds this proxy and every call forwards to
 * whatever it resolved. A build failure is reported once, then the native
 * impersonated path takes over rather than leaving the route permanently broken.
 *
 * @param {ResolvedTransportConfig} config
 * @param {(message: string) => void} warn
 * @returns {import('./lib/transport.js').Transport}
 */
function createLazyTransport(config, warn) {
  /** @type {Promise<import('./lib/transport.js').Transport> | undefined} */
  let pending
  /** @type {import('./lib/transport.js').Transport | undefined} */
  let inner

  const resolve = async () => {
    if (inner !== undefined) return inner
    if (pending === undefined) {
      pending = createTransport(config).catch((error) => {
        pending = undefined
        warn(
          `transport "${config.mode}" unavailable (${error instanceof Error ? error.message : String(error)}); falling back to the native impersonated cipher list`
        )
        return createTransport({ ...config, mode: 'impersonate' })
      })
    }
    inner = await pending
    return inner
  }

  return {
    get mode() {
      return inner?.mode ?? (config.mode === 'native' ? 'native' : 'impersonate')
    },
    get describe() {
      return inner?.describe ?? 'resolving transport'
    },
    request: async (url, init) => (await resolve()).request(url, init),
    dispose: () => {
      inner?.dispose()
      inner = undefined
      pending = undefined
    }
  }
}

/**
 * @typedef {object} ResolvedTransportConfig
 * @property {'auto' | 'native' | 'impersonate' | 'wreq'} mode
 * @property {string} cipherList
 * @property {number} timeoutMs
 */

// Re-exported for `scripts/probe.mjs`, so the diagnostic tool exercises exactly
// the code paths the plugin uses rather than a parallel copy of them.
export const __internals = {
  createLazyTransport,
  fetchJson,
  mintSessionId,
  isGateSessionId,
  fingerprintHeaders,
  resolveEffort,
  laneForModel,
  isFreeModelId,
  OPENCODE_CIPHER_LIST,
  SNAPSHOT_MODELS,
  FINGERPRINT_TOOL_NAMES,
  SessionStore
}
