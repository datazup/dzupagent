/** Token usage statistics */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** Cache-read tokens (Anthropic: cached_input_tokens). Billed at ~10% of input price. */
  cachedInputTokens?: number | undefined
  /** Cache-write tokens (Anthropic: cache_creation_input_tokens). Billed at ~125% of input price. */
  cacheWriteTokens?: number | undefined
  costCents?: number | undefined
}
