/**
 * Harness request → free-lane wire body, for all three protocols.
 *
 * One lane is not enough: the same `baseURL` serves OpenAI Chat Completions,
 * OpenAI Responses and Anthropic Messages, and which one a model speaks is a
 * property of the model rather than of the deployment. Posting a Responses model
 * to `/chat/completions` does not degrade — it fails.
 *
 * Two harness facts shape this file:
 *
 * - **Files never arrive.** The runtime projects every durable `FileBlock` into
 *   deterministic handle text before an adapter sees it, so there is no file
 *   branch here.
 * - **Images arrive only on a route that declared image input.** When the model's
 *   `inputModalities` say text-only, the runtime itself substitutes its
 *   placeholder text and this file receives an ordinary text block. That is why
 *   the default posture is a text-only declaration: the free lane has returned
 *   503 for image input, and letting the harness do the projection means a
 *   vision-incapable turn still works instead of failing upstream.
 *
 * @module dsh-9router/request
 */

/**
 * Concatenate the text of a content array.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  /** @type {string[]} */
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/** The reasoning text of a content array, for lanes that echo thinking. */
export function reasoningOf(content) {
  if (!Array.isArray(content)) return ''
  /** @type {string[]} */
  const parts = []
  for (const block of content) {
    if (block?.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/** The image blocks of a content array, in order. */
export function imagesOf(content) {
  if (!Array.isArray(content)) return []
  return content.filter((block) => block?.type === 'image')
}

/** The tool-call blocks of a content array, in order. */
export function toolCallsOf(content) {
  if (!Array.isArray(content)) return []
  return content.filter((block) => block?.type === 'tool-call')
}

/**
 * Encode one durable image reference for the wire.
 *
 * Returns `undefined` when the attachment store cannot produce bytes, so the
 * caller can fall back to a text placeholder rather than sending a request the
 * upstream will refuse.
 *
 * @param {any} attachments - `ctx.attachments`, when mounted.
 * @param {{ attachment: any, offloaded?: true }} block
 * @param {{ width: number, height: number, maxBytes: number }} target
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ mediaType: string, dataUrl: string, base64: string } | undefined>}
 */
export async function encodeImage(attachments, block, target, signal) {
  if (block?.offloaded === true) return undefined
  const ref = block?.attachment
  if (attachments === undefined || ref === undefined) return undefined
  try {
    const version = await attachments.readImageRequest(ref, target, signal)
    if (version?.data === undefined) return undefined
    const mediaType = String(version.mediaType ?? ref.mediaType ?? 'image/png')
    const base64 = Buffer.from(version.data).toString('base64')
    return { mediaType, base64, dataUrl: `data:${mediaType};base64,${base64}` }
  } catch {
    return undefined
  }
}

/** Placeholder used when an image cannot be encoded for this lane. */
export function imageFallbackText(block) {
  const id = String(block?.attachment?.attachmentId ?? '')
  const short = id.length > 8 ? id.slice(7, 15) : id
  return `[image omitted: this model route could not encode it; attachment sha256:${short}]`
}

// ---------------------------------------------------------------------------
// Chat Completions lane
// ---------------------------------------------------------------------------

/**
 * Build the `messages` array for `/inference/v1/chat/completions`.
 *
 * Two rewrites matter here and both come from live probes of the free lane:
 *
 * - `role: "developer"` is refused with `[1214] Incorrect role information`, so
 *   developer messages are folded into `system`. The harness emits them for tool
 *   updates, which means this is reached in ordinary agent turns, not only in
 *   exotic ones.
 * - An assistant turn whose reasoning is empty is refused by reasoning models
 *   with `400 missing_required_parameter` on the *next* request, because the
 *   backend expects the thinking it produced to be echoed back. `reasoningEcho`
 *   adds a non-empty placeholder where the harness has none to send.
 *
 * @param {readonly any[]} messages - Harness `RequestMessage[]`.
 * @param {object} options
 * @param {boolean} [options.reasoningEcho]
 * @param {(block: any) => Promise<{ mediaType: string, dataUrl: string } | undefined>} [options.encodeImage]
 * @param {boolean} [options.images]
 * @returns {Promise<any[]>}
 */
export async function toChatMessages(messages, options = {}) {
  /** @type {any[]} */
  const out = []
  const encoder = options.encodeImage
  const wantsImages = options.images === true && typeof encoder === 'function'

  for (const message of messages ?? []) {
    const role = message?.role
    const content = message?.content

    if (role === 'system' || role === 'developer') {
      const text = textOf(content)
      if (text.length > 0) out.push({ role: 'system', content: text })
      continue
    }

    if (role === 'user') {
      const text = textOf(content)
      const present = imagesOf(content)
      // An image the route will not carry still has to become *something* the
      // model can see: dropping the block silently would leave a turn that reads
      // as though the user sent no attachment at all. The harness normally
      // substitutes its own placeholder before an adapter is reached (that is what
      // declaring a text-only route buys), so this branch is the guard for the case
      // where the runtime and the adapter disagree about the route's modalities.
      const images = wantsImages ? present : []
      if (images.length === 0) {
        const dropped = present.length > 0 ? present.map(imageFallbackText).join('\n') : ''
        const merged = [text, dropped].filter((part) => part.length > 0).join('\n')
        out.push({ role: 'user', content: merged })
        continue
      }
      /** @type {any[]} */
      const parts = []
      if (text.length > 0) parts.push({ type: 'text', text })
      for (const block of images) {
        const encoded = await encoder(block)
        parts.push(
          encoded !== undefined
            ? { type: 'image_url', image_url: { url: encoded.dataUrl } }
            : { type: 'text', text: imageFallbackText(block) }
        )
      }
      out.push({ role: 'user', content: parts })
      continue
    }

    if (role === 'assistant') {
      const text = textOf(content)
      const calls = toolCallsOf(content)
      /** @type {any} */
      const entry = { role: 'assistant' }
      // An assistant message that only called tools carries no text; OpenAI
      // wants `content: null` there rather than an empty string.
      entry.content = text.length > 0 ? text : null
      if (options.reasoningEcho === true) {
        const reasoning = reasoningOf(content)
        entry.reasoning_content = reasoning.length > 0 ? reasoning : ' '
      } else {
        const reasoning = reasoningOf(content)
        if (reasoning.length > 0) entry.reasoning_content = reasoning
      }
      if (calls.length > 0) {
        entry.tool_calls = calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments }
        }))
      }
      out.push(entry)
      continue
    }

    if (role === 'tool') {
      const text = textOf(content)
      out.push({
        role: 'tool',
        tool_call_id: message?.toolCallId,
        // Some backends reject an empty tool result; a space keeps the turn
        // valid without inventing content the model would read as an answer.
        content: text.length > 0 ? text : ' '
      })
      continue
    }
    // Unknown roles are dropped rather than guessed at: sending a role the
    // backend does not know fails the whole request.
  }
  return out
}

/**
 * Build the chat-lane `tools` array from harness tool schemas.
 *
 * @param {readonly any[] | undefined} tools
 * @returns {any[] | undefined}
 */
export function toChatTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      parameters: tool.parameters ?? { type: 'object', properties: {} }
    }
  }))
}

// ---------------------------------------------------------------------------
// Responses lane
// ---------------------------------------------------------------------------

/**
 * Build the Responses-lane `input` array and `instructions` string.
 *
 * The Responses wire models a conversation as a flat item list rather than role
 * messages, and tool round-trips are `function_call` / `function_call_output`
 * items keyed by `call_id`.
 *
 * Prior-turn `reasoning` items are deliberately dropped: the free lane routes
 * through a pooled upstream account, and a Responses backend refuses reasoning
 * `encrypted_content` it did not issue to this caller. Under stateless mode
 * (`store: false`) omitting it makes the referenced item "not found", so the
 * whole item goes rather than half of it.
 *
 * @param {readonly any[]} messages
 * @param {{ system?: string }} [options]
 * @returns {{ instructions: string | undefined, input: any[] }}
 */
export function toResponsesInput(messages, options = {}) {
  /** @type {any[]} */
  const input = []
  /** @type {string[]} */
  const systemParts = []
  if (typeof options?.system === 'string' && options.system.length > 0) {
    systemParts.push(options.system)
  }

  for (const message of messages ?? []) {
    const role = message?.role
    const content = message?.content

    if (role === 'system' || role === 'developer') {
      const text = textOf(content)
      if (text.length > 0) systemParts.push(text)
      continue
    }
    if (role === 'user') {
      const text = textOf(content)
      input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }]
      })
      continue
    }
    if (role === 'assistant') {
      const text = textOf(content)
      if (text.length > 0) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }]
        })
      }
      for (const call of toolCallsOf(content)) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments
        })
      }
      continue
    }
    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message?.toolCallId,
        output: textOf(content) || ' '
      })
    }
  }

  if (input.length === 0) {
    // A Responses request with an empty input is refused; the caller always has
    // something to say, so this is a guard rather than a path.
    input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] })
  }
  return {
    instructions: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    input
  }
}

/**
 * Build the Responses-lane `tools` array (flat `{name}` shape).
 *
 * @param {readonly any[] | undefined} tools
 * @returns {any[] | undefined}
 */
export function toResponsesTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
    parameters: tool.parameters ?? { type: 'object', properties: {} },
    strict: false
  }))
}

// ---------------------------------------------------------------------------
// Anthropic Messages lane
// ---------------------------------------------------------------------------

/**
 * Build the Messages-lane `system` and `messages`.
 *
 * @param {readonly any[]} messages
 * @param {object} [options]
 * @param {string} [options.system]
 * @param {(block: any) => Promise<{ mediaType: string, base64: string } | undefined>} [options.encodeImage]
 * @param {boolean} [options.images]
 * @returns {Promise<{ system: string | undefined, messages: any[] }>}
 */
export async function toAnthropicMessages(messages, options = {}) {
  /** @type {any[]} */
  const out = []
  /** @type {string[]} */
  const systemParts = []
  if (typeof options?.system === 'string' && options.system.length > 0) {
    systemParts.push(options.system)
  }
  const encoder = options.encodeImage
  const wantsImages = options.images === true && typeof encoder === 'function'

  for (const message of messages ?? []) {
    const role = message?.role
    const content = message?.content

    if (role === 'system' || role === 'developer') {
      const text = textOf(content)
      if (text.length > 0) systemParts.push(text)
      continue
    }

    if (role === 'user') {
      /** @type {any[]} */
      const parts = []
      const text = textOf(content)
      if (text.length > 0) parts.push({ type: 'text', text })
      const present = imagesOf(content)
      if (!wantsImages) {
        // See the chat lane: a dropped image must still leave a trace.
        for (const block of present) parts.push({ type: 'text', text: imageFallbackText(block) })
      }
      if (wantsImages) {
        for (const block of present) {
          const encoded = await encoder(block)
          parts.push(
            encoded !== undefined
              ? {
                  type: 'image',
                  source: { type: 'base64', media_type: encoded.mediaType, data: encoded.base64 }
                }
              : { type: 'text', text: imageFallbackText(block) }
          )
        }
      }
      if (parts.length === 0) parts.push({ type: 'text', text: '' })
      out.push({ role: 'user', content: parts })
      continue
    }

    if (role === 'assistant') {
      /** @type {any[]} */
      const parts = []
      const reasoning = reasoningOf(content)
      if (reasoning.length > 0) parts.push({ type: 'text', text: reasoning })
      const text = textOf(content)
      if (text.length > 0) parts.push({ type: 'text', text })
      for (const call of toolCallsOf(content)) {
        let parsed = {}
        try {
          parsed = call.arguments.length > 0 ? JSON.parse(call.arguments) : {}
        } catch {
          // A malformed argument string is the model's output, not ours to fix;
          // send it as raw text so the turn stays representable.
          parsed = { _raw: call.arguments }
        }
        parts.push({ type: 'tool_use', id: call.id, name: call.name, input: parsed })
      }
      if (parts.length === 0) parts.push({ type: 'text', text: '' })
      out.push({ role: 'assistant', content: parts })
      continue
    }

    if (role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message?.toolCallId,
            content: textOf(content) || ' ',
            ...(message?.isError === true ? { is_error: true } : {})
          }
        ]
      })
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: out
  }
}

/**
 * Build the Messages-lane `tools` array.
 *
 * @param {readonly any[] | undefined} tools
 * @returns {any[] | undefined}
 */
export function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool) => ({
    name: tool.name,
    ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
    input_schema: tool.parameters ?? { type: 'object', properties: {} }
  }))
}

/**
 * Drop prior-turn reasoning items from a Responses `input`.
 *
 * @param {any[]} input
 * @returns {any[]}
 */
export function sanitizeResponsesItems(input) {
  if (!Array.isArray(input)) return input
  return input.filter((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return true
    if (item.type === 'reasoning') return false
    delete item.encrypted_content
    delete item.reasoning_encrypted_content
    return true
  })
}
