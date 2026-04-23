/**
 * Transient error detection and retry configuration for LLM calls.
 *
 * Re-exports the canonical `RetryPolicy` from `@dzupagent/agent-types` and
 * keeps the legacy `RetryConfig` shape (with its `backoffMs` alias) for
 * backward compatibility.
 */

export type { RetryPolicy } from '@dzupagent/agent-types'

/**
 * Legacy LLM retry shape. Uses `backoffMs` instead of `initialBackoffMs`.
 *
 * @deprecated Use `RetryPolicy` from `@dzupagent/agent-types` for new code.
 */
export interface RetryConfig {
  maxAttempts: number
  /** Initial backoff in milliseconds (doubles each attempt) */
  backoffMs?: number
  /** Maximum backoff in milliseconds */
  maxBackoffMs?: number
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  backoffMs: 1000,
  maxBackoffMs: 8000,
}

/**
 * Determines if an error is transient and should be retried.
 * Covers: rate limiting, server overload, temporary outages.
 */
export function isTransientError(error: Error): boolean {
  const msg = error.message.toLowerCase()
  return (
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('529') ||
    msg.includes('rate_limit') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('overloaded') ||
    msg.includes('capacity') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed')
  )
}

/**
 * Determines if an error indicates the prompt exceeded the model's
 * context window. These errors are **not** retryable — a bigger prompt
 * will fail identically. Callers should surface a dedicated error so
 * upstream logic (compression, model swap) can react appropriately.
 */
export function isContextLengthError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase()
  return (
    msg.includes('context_length_exceeded') ||
    msg.includes('maximum context') ||
    msg.includes('prompt is too long')
  )
}
