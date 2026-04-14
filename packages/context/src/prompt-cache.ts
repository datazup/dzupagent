/**
 * Anthropic prompt caching utilities.
 *
 * Applies cache_control breakpoints to messages for Anthropic's prompt
 * caching feature. Anthropic allows up to 4 cache breakpoints per request;
 * this module uses the "system_and_3" strategy:
 *
 * - 1 breakpoint on the system prompt
 * - 3 breakpoints on the last 3 non-system messages (rolling window)
 *
 * This reduces input token costs by ~75% on multi-turn conversations
 * because the cached prefix is reused across turns.
 *
 * Inspired by Hermes Agent's prompt_caching.py.
 */
import type { BaseMessage } from '@langchain/core/messages'

/** Cache control marker for Anthropic API */
interface CacheControl {
  type: 'ephemeral'
}

/** Content block with optional cache_control */
interface ContentBlockWithCache {
  type: string
  text?: string
  cache_control?: CacheControl
  [key: string]: unknown
}

/** Message format expected by Anthropic's API */
interface AnthropicMessage {
  role: string
  content: string | ContentBlockWithCache[]
  [key: string]: unknown
}

const MAX_BREAKPOINTS = 4
const CACHE_MARKER: CacheControl = { type: 'ephemeral' }

/**
 * Apply cache breakpoints to a system prompt string.
 * Returns content blocks with cache_control on the last block.
 */
function markSystemPrompt(
  system: string | ContentBlockWithCache[],
): ContentBlockWithCache[] {
  if (typeof system === 'string') {
    return [{ type: 'text', text: system, cache_control: CACHE_MARKER }]
  }

  // Array of content blocks — mark the last one
  if (system.length === 0) return system
  const blocks: ContentBlockWithCache[] = system.map(b => ({ ...b }))
  const last = blocks[blocks.length - 1]
  if (last) {
    blocks[blocks.length - 1] = { ...last, cache_control: CACHE_MARKER }
  }
  return blocks
}

/**
 * Apply cache_control to a single message's content.
 * If content is a string, wraps it in a content block array.
 * If content is already an array, marks the last block.
 */
function markMessage(msg: AnthropicMessage): AnthropicMessage {
  const content = msg.content

  if (typeof content === 'string') {
    return {
      ...msg,
      content: [{ type: 'text', text: content, cache_control: CACHE_MARKER }],
    }
  }

  if (Array.isArray(content) && content.length > 0) {
    const blocks: ContentBlockWithCache[] = content.map(b => ({ ...b }))
    const last = blocks[blocks.length - 1]
    if (last) {
      blocks[blocks.length - 1] = { ...last, cache_control: CACHE_MARKER }
    }
    return { ...msg, content: blocks }
  }

  return msg
}

/**
 * Apply Anthropic cache breakpoints to a set of messages.
 *
 * Strategy: "system_and_3"
 * - System prompt gets 1 breakpoint
 * - Last 3 non-system messages get 1 breakpoint each
 *
 * Messages are deep-copied to avoid mutating the originals.
 *
 * @param system   The system prompt (string or content blocks)
 * @param messages Non-system messages in conversation order
 * @returns Object with cached system prompt and cached messages
 */
export function applyAnthropicCacheControl(
  system: string | ContentBlockWithCache[],
  messages: AnthropicMessage[],
): {
  system: ContentBlockWithCache[]
  messages: AnthropicMessage[]
} {
  // 1 breakpoint for system prompt
  const cachedSystem = markSystemPrompt(system)

  // Up to 3 breakpoints for the last 3 messages
  const remaining = MAX_BREAKPOINTS - 1
  const msgCopies = messages.map(m => ({ ...m }))

  // Find last N non-system messages to mark
  const markCount = Math.min(remaining, msgCopies.length)
  const startIdx = msgCopies.length - markCount

  for (let i = startIdx; i < msgCopies.length; i++) {
    const msg = msgCopies[i]
    if (msg) {
      msgCopies[i] = markMessage(msg)
    }
  }

  return { system: cachedSystem, messages: msgCopies }
}

/**
 * Apply cache breakpoints to LangChain BaseMessage[] format.
 *
 * This is a convenience wrapper that works with the LangChain message types
 * used throughout dzupagent-core. It modifies the `additional_kwargs`
 * on each marked message to include Anthropic's cache_control metadata.
 *
 * Note: This only has effect when using ChatAnthropic — other providers
 * ignore the additional_kwargs.cache_control field.
 *
 * @param messages Full message array (system + conversation)
 * @returns New array with cache breakpoints applied (originals not mutated)
 */
export function applyCacheBreakpoints(messages: BaseMessage[]): BaseMessage[] {
  if (messages.length === 0) return messages

  const result: BaseMessage[] = []

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!m) continue

    const type = m._getType()
    const copy = _cloneMessage(m)

    // Mark system messages (breakpoint 1)
    if (type === 'system') {
      _setCacheControl(copy)
      result.push(copy)
      continue
    }

    result.push(copy)
  }

  // Mark last 3 non-system messages (breakpoints 2-4)
  const nonSystemIndices: number[] = []
  for (let i = 0; i < result.length; i++) {
    const msg = result[i]
    if (msg && msg._getType() !== 'system') {
      nonSystemIndices.push(i)
    }
  }

  const markCount = Math.min(MAX_BREAKPOINTS - 1, nonSystemIndices.length)
  const startMark = nonSystemIndices.length - markCount

  for (let j = startMark; j < nonSystemIndices.length; j++) {
    const idx = nonSystemIndices[j]
    const target = idx !== undefined ? result[idx] : undefined
    if (target) {
      _setCacheControl(target)
    }
  }

  return result
}

/** Clone a BaseMessage by spreading its fields */
function _cloneMessage(m: BaseMessage): BaseMessage {
  // BaseMessage subclasses store data in .content, .additional_kwargs, .response_metadata, etc.
  // We shallow-clone and deep-clone additional_kwargs to avoid mutating originals.
  const cloned = Object.create(Object.getPrototypeOf(m) as object) as BaseMessage
  Object.assign(cloned, m)
  cloned.additional_kwargs = { ...m.additional_kwargs }
  return cloned
}

/** Set Anthropic cache_control in additional_kwargs */
function _setCacheControl(m: BaseMessage): void {
  m.additional_kwargs = {
    ...m.additional_kwargs,
    cache_control: CACHE_MARKER,
  }
}
