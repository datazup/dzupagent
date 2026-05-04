/**
 * Model-aware prompt cache injector (RF-13 / AG-12).
 *
 * Wraps `applyCacheBreakpoints` with:
 *   - Claude model detection (no-op for all other providers)
 *   - Minimum-token threshold guard (skip short prompts that won't benefit)
 */
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
  if (!modelId.startsWith('claude-')) return messages

  const minTokens = opts?.minTokensForCache ?? DEFAULT_MIN_TOKENS
  if (estimateMessageTokens(messages) < minTokens) return messages

  return applyCacheBreakpoints(messages)
}
