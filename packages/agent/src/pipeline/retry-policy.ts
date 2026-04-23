/**
 * Retry policy utilities — standalone functions for calculating exponential
 * backoff with optional jitter, and determining whether an error is retryable.
 *
 * These utilities are used by the pipeline runtime but can also be consumed
 * directly by any code that needs retry logic.
 *
 * @module pipeline/retry-policy
 */

import { calculateBackoff as coreCalculateBackoff } from '@dzupagent/core'
import type { RetryPolicy } from './pipeline-runtime-types.js'

// ---------------------------------------------------------------------------
// Default retry policy
// ---------------------------------------------------------------------------

/**
 * Sensible default retry policy for transient failures.
 *
 * - 3 max retries (4 total attempts)
 * - 1s initial backoff, doubling each time
 * - 30s max backoff cap
 * - Jitter enabled (adds 0-50% random noise to avoid thundering herd)
 * - Retries common transient errors: rate limits (429), timeouts,
 *   connection resets, connection refused
 */
export const DEFAULT_RETRY_POLICY: Required<
  Pick<RetryPolicy, 'initialBackoffMs' | 'maxBackoffMs' | 'multiplier' | 'jitter'>
> & Pick<RetryPolicy, 'retryableErrors'> = {
  initialBackoffMs: 1000,
  maxBackoffMs: 30_000,
  multiplier: 2,
  jitter: true,
  retryableErrors: [
    /429/,
    /rate.?limit/i,
    /timeout/i,
    /timed?\s*out/i,
    /ECONNRESET/,
    /ECONNREFUSED/,
    /ETIMEDOUT/,
    /ENOTFOUND/,
    /socket hang up/i,
  ],
}

// ---------------------------------------------------------------------------
// Backoff calculation
// ---------------------------------------------------------------------------

/**
 * Calculate exponential backoff delay for a given retry attempt.
 *
 * Formula: `min(initialBackoffMs * multiplier^(attempt-1), maxBackoffMs)`
 *
 * When jitter is enabled, a random factor between 0% and 50% of the
 * calculated delay is added. This prevents thundering-herd problems
 * when many pipelines retry simultaneously.
 *
 * @param attempt - The retry attempt number (1-based: 1 = first retry)
 * @param policy  - Retry policy configuration (defaults applied for missing fields)
 * @returns Backoff delay in milliseconds
 */
export function calculateBackoff(attempt: number, policy?: RetryPolicy): number {
  const initialMs = policy?.initialBackoffMs ?? DEFAULT_RETRY_POLICY.initialBackoffMs
  const maxMs = policy?.maxBackoffMs ?? DEFAULT_RETRY_POLICY.maxBackoffMs
  const multiplier = policy?.multiplier ?? policy?.backoffMultiplier ?? DEFAULT_RETRY_POLICY.multiplier
  const jitter = policy?.jitter ?? false

  // Core helper uses 0-based attempt; callers here pass 1-based, so shift.
  const base = coreCalculateBackoff(Math.max(0, attempt - 1), {
    initialBackoffMs: initialMs,
    maxBackoffMs: maxMs,
    multiplier,
  })

  if (!jitter) {
    return base
  }

  // Preserve agent-specific additive jitter (0-50% above base). Core helper
  // applies multiplicative "equal jitter" (50%-100% band); agent callers
  // and tests depend on the additive shape so we keep it here.
  const jitterFactor = Math.random() * 0.5
  return Math.round(base + base * jitterFactor)
}

// ---------------------------------------------------------------------------
// Retryable error detection
// ---------------------------------------------------------------------------

/**
 * Determine whether an error message is retryable according to the given policy.
 *
 * - If `policy.retryableErrors` is empty or unset, ALL errors are retryable.
 * - String patterns match via `error.includes(pattern)`.
 * - RegExp patterns match via `pattern.test(error)`.
 *
 * @param error  - The error message to check
 * @param policy - Retry policy with optional retryableErrors list
 * @returns `true` if the error should trigger a retry
 */
export function isRetryable(error: string, policy?: RetryPolicy): boolean {
  const patterns = policy?.retryableErrors
  if (!patterns || patterns.length === 0) return true
  return patterns.some((p) =>
    typeof p === 'string' ? error.includes(p) : p.test(error),
  )
}

// ---------------------------------------------------------------------------
// Resolve per-node policy
// ---------------------------------------------------------------------------

/**
 * Resolve the effective retry policy for a node by merging the node-level
 * policy with the global pipeline-level policy. Node-level values take
 * precedence over global values.
 *
 * @param nodePolicy   - Per-node retry policy override (may be undefined)
 * @param globalPolicy - Pipeline-level default retry policy (may be undefined)
 * @returns Merged retry policy (may be undefined if both inputs are undefined)
 */
export function resolveRetryPolicy(
  nodePolicy: RetryPolicy | undefined,
  globalPolicy: RetryPolicy | undefined,
): RetryPolicy | undefined {
  if (!nodePolicy && !globalPolicy) return undefined
  if (!nodePolicy) return globalPolicy
  if (!globalPolicy) return nodePolicy

  return {
    initialBackoffMs: nodePolicy.initialBackoffMs ?? globalPolicy.initialBackoffMs,
    maxBackoffMs: nodePolicy.maxBackoffMs ?? globalPolicy.maxBackoffMs,
    multiplier: nodePolicy.multiplier ?? globalPolicy.multiplier,
    backoffMultiplier: nodePolicy.backoffMultiplier ?? globalPolicy.backoffMultiplier,
    jitter: nodePolicy.jitter ?? globalPolicy.jitter,
    retryableErrors: nodePolicy.retryableErrors ?? globalPolicy.retryableErrors,
  }
}
