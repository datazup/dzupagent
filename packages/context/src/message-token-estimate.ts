/**
 * Token-counter selection and estimation for the message manager.
 *
 * Split out of `message-manager.ts` (a line-budget debt file) so the default
 * counter policy lives in one small module.
 */
import type { TokenCounter } from './token-lifecycle.js'
import { CharEstimateCounter } from './char-estimate-counter.js'
import { TiktokenCounter } from './tiktoken-counter.js'

/** Shared defaults, constructed once to avoid a per-call allocation. */
export const DEFAULT_TOKEN_COUNTER: TokenCounter = new CharEstimateCounter()
const MODEL_TOKEN_COUNTER: TokenCounter = new TiktokenCounter()

/**
 * Resolve the effective token counter. An injected `tokenCounter` wins. With
 * none, a known model id selects the tokenizer-backed {@link TiktokenCounter}
 * (which degrades to chars/4 itself when the optional tokenizer is absent)
 * unless the caller overrides `charsPerToken`, which keeps the historical
 * chars/N path.
 */
export function resolveTokenCounter(
  config: { tokenCounter?: TokenCounter; charsPerToken?: number } | undefined,
  modelId?: string,
): TokenCounter {
  if (config?.tokenCounter) return config.tokenCounter
  const knownModel = modelId !== undefined && modelId !== '' && modelId !== 'unknown'
  return knownModel && config?.charsPerToken === undefined ? MODEL_TOKEN_COUNTER : DEFAULT_TOKEN_COUNTER
}

/**
 * Token estimate for one text. A wired or model-selected counter is used
 * (passing `model` when available); the default falls back to the legacy
 * `length / charsPerToken` shape so callers tuning only `charsPerToken` keep
 * working unchanged.
 */
export function estimateTokens(
  text: string,
  charsPerToken: number,
  counter?: TokenCounter,
  model?: string,
): number {
  if (counter && counter !== DEFAULT_TOKEN_COUNTER) {
    return counter.count(text, model)
  }
  return Math.ceil(text.length / charsPerToken)
}
