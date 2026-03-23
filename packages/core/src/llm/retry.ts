/**
 * Transient error detection and retry configuration for LLM calls.
 */

/** Retry configuration for LLM invocations */
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
    msg.includes('503') ||
    msg.includes('529') ||
    msg.includes('rate_limit') ||
    msg.includes('rate limit') ||
    msg.includes('overloaded') ||
    msg.includes('capacity') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed')
  )
}
