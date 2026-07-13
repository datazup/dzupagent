/**
 * Transient error detection and retry configuration for LLM calls.
 *
 * Re-exports the canonical `RetryPolicy` from `@dzupagent/agent-types` and
 * keeps the legacy `RetryConfig` shape (with its `backoffMs` alias) for
 * backward compatibility.
 */

import {
  isRecoverableProviderError,
  isContextLengthProviderError,
} from '../errors/classify-provider-error.js'

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
 *
 * Delegates to the typed classifier ({@link isRecoverableProviderError}),
 * which maps the error to a `PROVIDER_*` code and reads
 * {@link ForgeError.recoverable} — the substring heuristics now live in a
 * single place (`classify-provider-error.ts`) rather than being duplicated
 * at every retry / fallback / breaker decision site.
 */
export function isTransientError(error: Error): boolean {
  return isRecoverableProviderError(error)
}

/**
 * Determines if an error indicates the prompt exceeded the model's
 * context window. These errors are **not** retryable — a bigger prompt
 * will fail identically. Callers should surface a dedicated error so
 * upstream logic (compression, model swap) can react appropriately.
 *
 * Delegates to the typed classifier — a context-length error resolves to the
 * `CONTEXT_LENGTH_EXCEEDED` code.
 */
export function isContextLengthError(err: unknown): boolean {
  return isContextLengthProviderError(err)
}
