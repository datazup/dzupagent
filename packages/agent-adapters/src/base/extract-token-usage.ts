/**
 * Shared token-usage extraction utility for adapters that receive raw
 * provider usage payloads.
 *
 * Provider SDKs report usage with snake_case keys
 * (`input_tokens`, `output_tokens`, `cached_input_tokens`,
 * `cache_creation_input_tokens`, `cost_cents`); this helper normalizes them to
 * the {@link TokenUsage} contract used across the framework.
 */

import type { TokenUsage } from '../types.js'

/**
 * Extract a normalized {@link TokenUsage} from a provider's raw usage object.
 *
 * Returns `undefined` when the input is `null`/`undefined` so callers can
 * forward it directly to optional usage fields.
 *
 * Supported source keys:
 * - `input_tokens` (number) → `inputTokens` (defaults to 0)
 * - `output_tokens` (number) → `outputTokens` (defaults to 0)
 * - `cached_input_tokens` (number) → `cachedInputTokens` (cache read tokens)
 * - `cache_creation_input_tokens` (number) → `cacheWriteTokens` (cache write tokens)
 * - `cost_cents` (number) → `costCents` (omitted if absent)
 *
 * Unknown keys are ignored. Non-numeric values fall back to 0 / are skipped.
 */
export function extractTokenUsage(usage: unknown): TokenUsage | undefined {
  if (usage === null || usage === undefined) return undefined
  if (typeof usage !== 'object') return undefined

  const record = usage as Record<string, unknown>

  const inputTokens = typeof record['input_tokens'] === 'number' ? record['input_tokens'] : 0
  const outputTokens = typeof record['output_tokens'] === 'number' ? record['output_tokens'] : 0

  const result: TokenUsage = { inputTokens, outputTokens }

  const cachedRead =
    typeof record['cached_input_tokens'] === 'number' ? record['cached_input_tokens'] : undefined
  const cachedWrite =
    typeof record['cache_creation_input_tokens'] === 'number'
      ? record['cache_creation_input_tokens']
      : undefined

  if (cachedRead !== undefined) {
    result.cachedInputTokens = cachedRead
  }
  if (cachedWrite !== undefined) {
    result.cacheWriteTokens = cachedWrite
  }

  if (typeof record['cost_cents'] === 'number') {
    result.costCents = record['cost_cents']
  }

  return result
}
