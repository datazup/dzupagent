/**
 * Circuit-breaker recording helpers extracted from DelegatingSupervisor.
 *
 * Provides:
 *  - `isTimeoutError(message)` — classify error messages as timeouts.
 *  - `markCircuitBreakerRecorded(error)` / `hasCircuitBreakerRecorded(error)` —
 *    tag errors with a non-enumerable symbol so callers higher up the stack
 *    do not double-record the same failure into the breaker.
 *  - `recordCircuitBreakerFailure(breaker, specialistId, error)` — convenience
 *    helper that maps an unknown error to the correct breaker call
 *    (`recordTimeout` vs `recordFailure`).
 *
 * This module depends ONLY on `@dzupagent/core` types via
 * `./circuit-breaker.js`. It does NOT pull in any sibling-package code.
 */

import type { AgentCircuitBreaker } from './circuit-breaker.js'

/** Symbol used to tag errors that have already been recorded into a breaker. */
export const CIRCUIT_BREAKER_RECORDED = Symbol('circuitBreakerRecorded')

/** Returns true when an error message looks like a timeout. */
export function isTimeoutError(message: string | undefined): boolean {
  return message?.toLowerCase().includes('timeout') ?? false
}

/**
 * Tag the supplied error with the {@link CIRCUIT_BREAKER_RECORDED} marker so
 * downstream handlers know not to record the same failure twice.
 *
 * Non-extensible / primitive throw values are silently ignored — they cannot
 * carry a marker, but callers should treat them as "fresh" failures anyway.
 */
export function markCircuitBreakerRecorded(error: unknown): void {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    try {
      Object.defineProperty(error, CIRCUIT_BREAKER_RECORDED, {
        value: true,
        configurable: true,
      })
    } catch {
      // Non-extensible thrown values still get recorded; they just cannot be tagged.
    }
  }
}

/** True when an error has previously been tagged via {@link markCircuitBreakerRecorded}. */
export function hasCircuitBreakerRecorded(error: unknown): boolean {
  return Boolean(
    error &&
      (typeof error === 'object' || typeof error === 'function') &&
      (error as { [CIRCUIT_BREAKER_RECORDED]?: boolean })[CIRCUIT_BREAKER_RECORDED],
  )
}

/**
 * Record a failure into the breaker (if any). Maps timeout-shaped errors to
 * `recordTimeout` and everything else to `recordFailure`.
 *
 * Returns `true` when a record was issued, `false` when no breaker was wired.
 */
export function recordCircuitBreakerFailure(
  breaker: AgentCircuitBreaker | undefined,
  specialistId: string,
  error: unknown,
): boolean {
  if (!breaker) return false

  const message = error instanceof Error ? error.message : String(error)
  if (isTimeoutError(message)) {
    breaker.recordTimeout(specialistId)
    return true
  }

  breaker.recordFailure(specialistId)
  return true
}
