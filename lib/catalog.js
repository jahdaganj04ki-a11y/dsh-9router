/**
 * The free-model catalog: per-model endpoint lane, capacity, modalities and
 * reasoning levels.
 *
 * The free roster rotates — OpenCode states these models are offered "for a
 * limited time" while a vendor collects feedback — so this snapshot is a
 * *fallback*, not the source of truth. `discovery.js` fetches the live list and
 * intersects it with a pricing catalog to decide which models are actually free
 * right now. This file's job is the part a bare `/models` listing cannot answer:
 * how big each model is, whether it sees images, which wire protocol it speaks,
 * and which reasoning levels it accepts.
 *
 * Capacities and modalities below are taken from the published per-model metadata
 * (models.dev) and cross-checked against live probes of the free lane; see
 * docs/gate.md. Where a value is an assumption rather than a measurement it says
 * so in its comment.
 *
 * @module dsh-9router/catalog
 */

/**
 * Which wire protocol one model speaks on the free lane.
 *
 * The lane is not uniform: the same `baseURL` serves three protocols, and
 * posting a model to the wrong one fails rather than degrading. Routing is
 * therefore per model, with a family fallback for ids this snapshot predates.
 *
 * - `chat`      → `POST {base}/inference/v1/chat/completions` (OpenAI-compatible)
 * - `responses` → `POST {base}/inference/v1/responses`        (OpenAI Responses)
 * - `messages`  → `POST {base}/inference/v1/messages`         (Anthropic Messages)
 *
 * @typedef {'chat' | 'responses' | 'messages'} Lane
 */

/**
 * One catalog entry.
 *
 * @typedef {object} CatalogModel
 * @property {string} id - The `model` field sent upstream.
 * @property {string} name - Label for the model picker.
 * @property {string} [description] - One line distinguishing it from similar models.
 * @property {Lane} lane - Wire protocol this model is served on.
 * @property {number} contextWindow - Combined request + response capacity, in tokens.
 * @property {number} maxOutputTokens - Per-response output cap, in tokens.
 * @property {readonly ('text' | 'image')[]} inputModalities - Accepted input types.
 * @property {readonly string[] | false} reasoningEfforts - Selectable levels, least
 *   to greatest, or `false` for a model that does not reason.
 * @property {string} [defaultEffort] - Level materialized when a caller omits one.
 * @property {boolean} [reasoningEchoRequired] - Whether multi-turn history needs a
 *   non-empty `reasoning_content` on assistant messages.
 * @property {boolean} [forceAutoToolChoice] - Whether the lane only accepts `auto`.
 */

/**
 * Reasoning levels the free lane's chat endpoint validates against.
 *
 * The backend checks `reasoning_effort` against the plain OpenAI enum and
 * answers `400 Invalid option` for anything else — including `auto`, which is
 * what adaptive-thinking clients arrive as. Omitting the field lets upstream pick
 * its own default, which is what "adaptive" means, so `auto` is dropped rather
 * than mapped.
 */
export const OPENAI_EFFORT_ENUM = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The safest default level set for a free model this snapshot does not describe.
 *
 * `low`/`high`/`max` is the intersection every probe confirmed: the free lane
 * accepts exactly these three on its reasoning models, several of which cannot
 * disable thinking at all, so advertising `none` or `minimal` for an unknown
 * model would offer a level its backend rejects.
 */
export const DEFAULT_FREE_EFFORTS = ['low', 'high', 'max']

/**
 * Bundled snapshot of the free roster.
 *
 * Ordered by context window descending, which is how the picker reads best: the
 * models worth reaching for on a whole repository come first.
 *
 * @type {readonly CatalogModel[]}
 */
export const SNAPSHOT_MODELS = [
  {
    id: 'muse-spark-1.3-contributor-free',
    name: 'Muse Spark 1.3 Contributor (free)',
    description: '1M context, vision, Responses lane — the strongest free reasoner',
    lane: 'responses',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
    forceAutoToolChoice: true
  },
  {
    id: 'muse-spark-1.2-contributor-free',
    name: 'Muse Spark 1.2 Contributor (free)',
    description: '1M context, vision, Responses lane',
    lane: 'responses',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
    forceAutoToolChoice: true
  },
  {
    id: 'space-bunny-free',
    name: 'Space Bunny (free)',
    description: '1M context, vision, very large output cap; zero-retention upstream',
    lane: 'chat',
    contextWindow: 1_048_576,
    maxOutputTokens: 524_288,
    inputModalities: ['text', 'image'],
    reasoningEfforts: DEFAULT_FREE_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'x-preview-f-free',
    name: 'OX Alpha Preview F (free)',
    description: '1M context, vision, reasoning; thinking cannot be disabled',
    lane: 'chat',
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    inputModalities: ['text', 'image'],
    reasoningEfforts: DEFAULT_FREE_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'longcat-2.5-preview-free',
    name: 'LongCat 2.5 Preview (free)',
    description: '1M context with vision',
    lane: 'chat',
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    inputModalities: ['text', 'image'],
    reasoningEfforts: DEFAULT_FREE_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'longcat-2.0-free',
    name: 'LongCat 2.0 (free)',
    description: '1M context, text only',
    lane: 'chat',
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    inputModalities: ['text'],
    reasoningEfforts: DEFAULT_FREE_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'nemotron-3-ultra-free',
    name: 'Nemotron 3 Ultra (free)',
    description: '1M context — the pick for reading a whole repository',
    lane: 'chat',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputModalities: ['text'],
    reasoningEfforts: DEFAULT_FREE_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'exo-free',
    name: 'Exo (free)',
    description: '1M context, vision',
    lane: 'chat',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    inputModalities: ['text', 'image'],
    reasoningEfforts: DEFAULT_FREE_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'fledge-alpha-free',
    name: 'Fledge Alpha (free)',
    description: '1M context, vision',
    lane: 'chat',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    inputModalities: ['text', 'image'],
    reasoningEfforts: DEFAULT_FREE_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'nemotron-3.5-lightning-free',
    name: 'Nemotron 3.5 Lightning (free)',
    description: 'Output cap as large as the context — suits long-form generation',
    lane: 'chat',
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    inputModalities: ['text'],
    reasoningEfforts: DEFAULT_FREE_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'cat-jam-free',
    name: 'Cat Jam (free)',
    description: '256K context stealth model',
    lane: 'chat',
    contextWindow: 262_144,
    maxOutputTokens: 131_072,
    inputModalities: ['text'],
    reasoningEfforts: DEFAULT_FREE_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'ling-3.0-flash-fin-free',
    name: 'Ling 3.0 Flash Fin (free)',
    description: '256K context, finance-tuned; no selectable reasoning',
    lane: 'chat',
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    inputModalities: ['text'],
    reasoningEfforts: false
  },
  {
    id: 'union-alpha',
    name: 'Union Alpha (free)',
    description: '256K context, vision, served on the Anthropic Messages lane',
    lane: 'messages',
    contextWindow: 262_144,
    maxOutputTokens: 131_072,
    inputModalities: ['text', 'image'],
    reasoningEfforts: false
  },
  {
    id: 'ring-2.6-1t-free',
    name: 'Ring 2.6 1T (free)',
    description: '262K context',
    lane: 'chat',
    contextWindow: 262_000,
    maxOutputTokens: 66_000,
    inputModalities: ['text'],
    reasoningEfforts: DEFAULT_FREE_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'north-mini-code-free',
    name: 'North Mini Code (free)',
    description: '256K context, code-tuned',
    lane: 'chat',
    contextWindow: 256_000,
    maxOutputTokens: 64_000,
    inputModalities: ['text'],
    reasoningEfforts: DEFAULT_FREE_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'laguna-s-2.1-free',
    name: 'Laguna S 2.1 (free)',
    description: 'A 256K-context generalist',
    lane: 'chat',
    contextWindow: 256_000,
    maxOutputTokens: 32_000,
    inputModalities: ['text'],
    reasoningEfforts: DEFAULT_FREE_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'big-pickle',
    name: 'Big Pickle (free)',
    description: "OpenCode's own anonymous evaluation model; always thinks",
    lane: 'chat',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    inputModalities: ['text'],
    // Probed: this model rejects an effort outside low/high/max and cannot
    // disable thinking, so `none`/`minimal`/`medium` are not offered.
    reasoningEfforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    reasoningEchoRequired: true
  },
  {
    id: 'mimo-v2.5-free',
    name: 'MiMo v2.5 (free)',
    description: 'A lightweight 200K-context model; frequently rate-limited',
    lane: 'chat',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    inputModalities: ['text'],
    reasoningEfforts: DEFAULT_FREE_EFFORTS,
    defaultEffort: 'high',
    reasoningEchoRequired: true
  },
  {
    id: 'mimo-v2.6-flash-free',
    name: 'MiMo v2.6 Flash (free)',
    description: 'Newer MiMo; the free lane forwards the full effort range',
    lane: 'chat',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    inputModalities: ['text'],
    reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
    reasoningEchoRequired: true
  },
  {
    id: 'deepseek-v4.1-flash-free',
    name: 'DeepSeek V4.1 Flash (free)',
    description: 'DeepSeek lineage; the free lane forwards the level verbatim',
    lane: 'chat',
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
    inputModalities: ['text'],
    // Published set for this exact free id. The generic deepseek-v4 range also
    // advertises medium/xhigh, which this model does not serve.
    reasoningEfforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    reasoningEchoRequired: true
  }
]

/**
 * Ids that are on the free lane but are not text-generation chat models, so the
 * harness must not offer them: a structured-decision endpoint answers a picker
 * selection, not an agent turn.
 */
export const EXCLUDED_IDS = new Set(['jev-1.13-free'])

/**
 * Endpoint families for a model id this snapshot does not describe.
 *
 * The free lane's own routing follows the same families, so an id added upstream
 * after this snapshot still lands on the right protocol instead of being posted
 * to `/chat/completions` and failing. Order matters: first match wins.
 *
 * @type {readonly { match: RegExp, lane: Lane }[]}
 */
const FAMILY_LANES = [
  { match: /^muse[-_]?spark/i, lane: 'responses' },
  { match: /^(grok|gpt)[-_.]/i, lane: 'responses' },
  { match: /^(claude|union)[-_.]/i, lane: 'messages' },
  { match: /^(minimax|qwen)[-_.]/i, lane: 'chat' }
]

/**
 * Strip a `model(level)` thinking suffix and any provider prefix.
 *
 * @param {string} id
 * @returns {string} The bare upstream model id.
 */
export function baseModelId(id) {
  const clean = String(id ?? '')
    .replace(/\([^()]+\)\s*$/, '')
    .trim()
  return clean.includes('/') ? clean.split('/').pop() : clean
}

/**
 * Whether an id is on the free lane.
 *
 * Free-tier ids carry the `-free` suffix, with a handful of promotional stealth
 * models that do not (`big-pickle`). Upstream gates these behind the attested
 * free-tier identity even on the keyed lane, so this predicate — not a hardcoded
 * model list — decides whether the fingerprint applies.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isFreeModelId(id) {
  const base = baseModelId(id)
  if (EXCLUDED_IDS.has(base)) return false
  return /-free$/i.test(base) || base === 'big-pickle'
}

/**
 * Resolve the wire lane for a model id: snapshot entry first, family fallback
 * second, chat lane last.
 *
 * @param {string} id
 * @returns {Lane}
 */
export function laneForModel(id) {
  const base = baseModelId(id)
  const known = SNAPSHOT_MODELS.find((model) => model.id === base)
  if (known !== undefined) return known.lane
  const family = FAMILY_LANES.find((entry) => entry.match.test(base))
  return family?.lane ?? 'chat'
}

/**
 * Find a snapshot entry by id.
 *
 * @param {readonly CatalogModel[]} models
 * @param {string} id
 * @returns {CatalogModel | undefined}
 */
export function findModel(models, id) {
  const base = baseModelId(id)
  return models.find((model) => model.id === base || model.id === id)
}

/**
 * Merge a live listing's bare facts into the snapshot's rich metadata.
 *
 * The live endpoint says which models exist; the snapshot says how large they
 * are and what they accept. A live entry wins on identity and on any capacity it
 * actually discloses, and the snapshot fills everything else — so a model whose
 * upstream listing starts reporting a context window is picked up without losing
 * its vision or reasoning declaration.
 *
 * @param {CatalogModel} base - Snapshot entry, or a synthesized default.
 * @param {{ contextWindow?: number, maxTokens?: number, inputModalities?: readonly string[], name?: string }} live
 * @returns {CatalogModel}
 */
export function mergeLiveInto(base, live) {
  return {
    ...base,
    name: live.name ?? base.name,
    contextWindow: positiveInteger(live.contextWindow) ?? base.contextWindow,
    maxOutputTokens: positiveInteger(live.maxTokens) ?? base.maxOutputTokens,
    inputModalities: normalizeModalities(live.inputModalities) ?? base.inputModalities
  }
}

/**
 * Synthesize an entry for a live model the snapshot has never seen.
 *
 * @param {string} id
 * @param {{ contextWindow?: number, maxTokens?: number, inputModalities?: readonly string[], name?: string }} live
 * @param {{ defaultContextWindow: number, defaultMaxTokens: number }} fallbacks
 * @returns {CatalogModel}
 */
export function synthesizeModel(id, live, fallbacks) {
  const lane = laneForModel(id)
  const modalities = normalizeModalities(live.inputModalities) ?? ['text']
  return {
    id: baseModelId(id),
    name: live.name ?? baseModelId(id),
    lane,
    contextWindow: positiveInteger(live.contextWindow) ?? fallbacks.defaultContextWindow,
    maxOutputTokens: positiveInteger(live.maxTokens) ?? fallbacks.defaultMaxTokens,
    inputModalities: modalities,
    // An undescribed model gets the safe level set only when its family is known
    // to reason; otherwise reasoning is left off rather than advertised, because
    // offering a level a backend rejects fails the turn.
    reasoningEfforts: /muse|deepseek|mimo|nemotron|longcat|big-pickle/i.test(baseModelId(id))
      ? DEFAULT_FREE_EFFORTS
      : false
  }
}

/** @returns {number | undefined} */
function positiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** @returns {readonly ('text' | 'image')[] | undefined} */
function normalizeModalities(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined
  /** @type {('text' | 'image')[]} */
  const out = []
  for (const entry of value) {
    const name = String(entry).toLowerCase()
    if (name === 'text' && !out.includes('text')) out.push('text')
    else if ((name === 'image' || name === 'vision') && !out.includes('image')) out.push('image')
  }
  return out.length > 0 ? out : undefined
}

// ---------------------------------------------------------------------------
// Reasoning levels
// ---------------------------------------------------------------------------

/**
 * Order used to find the nearest supported level. Index is effort, ascending.
 * `none` sorts below `low` so "off" is reachable on a model that offers it.
 */
const EFFORT_ORDER = ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

function effortRank(effort) {
  const index = EFFORT_ORDER.indexOf(String(effort).toLowerCase())
  return index < 0 ? EFFORT_ORDER.length : index
}

/**
 * Converge a requested level onto the set a model actually declares.
 *
 * The free lane answers an unsupported `reasoning_effort` with `400 Invalid
 * option` rather than clamping it, so an out-of-set level must never reach the
 * wire. `ultra` is accepted as an alias for `max` because that is how some
 * clients spell the top level, and `auto` returns `undefined` — omitting the
 * field is what adaptive means, and the enum rejects the literal.
 *
 * @param {string | undefined} requested
 * @param {readonly string[] | false | undefined} supported
 * @returns {string | undefined} The level to send, or `undefined` to omit the field.
 */
export function resolveEffort(requested, supported) {
  if (requested === undefined || requested === null) return undefined
  const raw = String(requested).toLowerCase().trim()
  if (raw === '' || raw === 'auto' || raw === 'adaptive') return undefined
  if (supported === false || supported === undefined) {
    // A model that declares no reasoning must not receive an effort field:
    // several free models answer one with 400 even when the value is valid
    // elsewhere on the lane.
    return undefined
  }
  const levels = supported.map((level) => level.toLowerCase())
  const alias = raw === 'ultra' ? 'max' : raw === 'off' ? 'none' : raw
  if (levels.includes(alias)) return alias

  // Nearest declared level, so a harness preset asking for `medium` on a
  // low/high/max model still gets a valid request instead of a failure. On a tie
  // the lower level wins: the picker only ever offers declared levels, so an
  // undeclared one comes from a preset or a hand edit, and on a rate-limited free
  // lane converging down is the cheaper and more predictable choice.
  const rank = effortRank(alias)
  let best = levels[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const level of levels) {
    const distance = Math.abs(effortRank(level) - rank)
    if (distance < bestDistance) {
      best = level
      bestDistance = distance
    }
  }
  return best
}

/**
 * The output cap to send for one request.
 *
 * The minimum of what the caller asked for, what the deployment configured, and
 * what the model itself accepts. Sending a cap above the model's own is refused
 * by some upstreams and silently truncated by others, neither of which is a
 * useful outcome; the smallest declared number is always safe.
 *
 * @param {(number | undefined)[]} candidates
 * @returns {number | undefined}
 */
export function resolveMaxTokens(candidates) {
  const valid = candidates.filter(
    (value) => typeof value === 'number' && Number.isFinite(value) && value > 0
  )
  return valid.length === 0 ? undefined : Math.min(...valid)
}
