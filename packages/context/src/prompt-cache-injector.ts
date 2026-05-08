/**
 * Model-aware prompt cache injector (RF-13 / AG-12 / REC-H-10).
 *
 * Wraps `applyCacheBreakpoints` with:
 *   - Claude model detection (no-op for all other providers)
 *   - Minimum-token threshold guard (skip short prompts that won't benefit)
 *
 * Two surfaces:
 *  - {@link injectPromptCacheMarkers} — caller already knows the model id.
 *  - {@link injectPromptCacheMarkersForModel} — caller has a `BaseChatModel`
 *    instance and lets the injector derive the id (covers the case where
 *    `DzupAgentConfig.model` is a `BaseChatModel` rather than a string).
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { applyCacheBreakpoints } from './prompt-cache.js'

const DEFAULT_MIN_TOKENS = 1024

function estimateMessageTokens(messages: BaseMessage[]): number {
  let chars = 0
  for (const m of messages) {
    const content = m.content
    if (typeof content === 'string') {
      chars += content.length
    } else {
      // MessageContentComplex[] — stringify to get a conservative estimate
      chars += JSON.stringify(content).length
    }
  }
  // ~4 chars per token
  return Math.ceil(chars / 4)
}

/**
 * Best-effort provider/model id extraction from a `BaseChatModel` instance.
 *
 * Order of preference:
 *  1. `model` field (LangChain convention on most chat models)
 *  2. `modelName` field (legacy LangChain naming)
 *  3. `name` field
 *  4. `_llmType()` lowercased — used as a coarse provider fallback so that
 *     a model whose id has not been populated still resolves to e.g.
 *     `'anthropic'` and is recognised as Claude by {@link isClaudeId}.
 *
 * Returns an empty string when no id can be derived; callers must treat
 * this as a non-Claude provider and skip cache injection.
 */
export function resolveModelId(model: unknown): string {
  if (!model || typeof model !== 'object') return ''

  const m = model as {
    model?: unknown
    modelName?: unknown
    name?: unknown
    _llmType?: () => string
  }

  if (typeof m.model === 'string' && m.model.length > 0) return m.model
  if (typeof m.modelName === 'string' && m.modelName.length > 0) return m.modelName
  if (typeof m.name === 'string' && m.name.length > 0) return m.name
  if (typeof m._llmType === 'function') {
    try {
      const t = m._llmType()
      if (typeof t === 'string' && t.length > 0) return t
    } catch {
      // _llmType implementations may throw on partially-initialised models;
      // a missing id falls through to the empty-string default.
    }
  }
  return ''
}

/**
 * True when the supplied id refers to a Claude / Anthropic model that
 * supports the `cache_control` prompt-caching contract.
 *
 * Handles both:
 *  - canonical model ids (e.g. `claude-sonnet-4-6`)
 *  - LangChain `_llmType()` outputs (`anthropic`)
 *  - vendor-prefixed ids (`anthropic/claude-3-5-sonnet`)
 */
export function isClaudeId(modelId: string): boolean {
  if (!modelId) return false
  const lower = modelId.toLowerCase()
  return (
    lower.startsWith('claude-')
    || lower.startsWith('anthropic')
    || lower.includes('/claude-')
  )
}

/**
 * Inject Anthropic `cache_control` breakpoints into the message list when
 * the model supports prompt caching and the prompt is large enough to benefit.
 *
 * - Non-Claude model IDs → returns `messages` unchanged.
 * - Total estimated tokens < `minTokensForCache` → returns `messages` unchanged.
 * - Otherwise delegates to `applyCacheBreakpoints` with the content-addressed strategy.
 *
 * @param messages        Full message array (system + conversation).
 * @param modelId         Provider model identifier string (e.g. `'claude-sonnet-4-6'`).
 * @param opts.minTokensForCache  Minimum estimated token count to activate caching (default: 1024).
 */
export function injectPromptCacheMarkers(
  messages: BaseMessage[],
  modelId: string,
  opts?: { minTokensForCache?: number },
): BaseMessage[] {
  if (!isClaudeId(modelId)) return messages

  const minTokens = opts?.minTokensForCache ?? DEFAULT_MIN_TOKENS
  if (estimateMessageTokens(messages) < minTokens) return messages

  return applyCacheBreakpoints(messages)
}

/**
 * Variant of {@link injectPromptCacheMarkers} that accepts a
 * `BaseChatModel` instance and derives the model id via
 * {@link resolveModelId}. Callers who hold the resolved chat model (rather
 * than a string identifier) should prefer this surface — it ensures
 * direct `ChatAnthropic` instances still receive cache markers when the
 * static `DzupAgentConfig.model` field is not a string.
 */
export function injectPromptCacheMarkersForModel(
  messages: BaseMessage[],
  model: BaseChatModel | undefined,
  opts?: { minTokensForCache?: number },
): BaseMessage[] {
  if (!model) return messages
  const id = resolveModelId(model)
  if (!id) return messages
  return injectPromptCacheMarkers(messages, id, opts)
}
