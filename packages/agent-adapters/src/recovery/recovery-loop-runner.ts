/**
 * Recovery backoff helpers — shared exponential-backoff delay and
 * AbortSignal-aware sleep for the recovery copilot.
 *
 * `executeWithRecovery` and `executeWithRecoveryStream` (adapter-recovery.ts)
 * own their attempt loops and call these helpers between iterations. The
 * former `RecoveryLoopRunner` class that wrapped such a loop had no callers
 * and was removed (DZUPAGENT-CODE-H-04).
 *
 * @module recovery/recovery-loop-runner
 */

import { calculateBackoff } from '@dzupagent/core/utils'

export interface RecoveryLoopConfig {
  /** Total number of attempts (including the first). Must be >= 1. */
  maxAttempts: number
  /** Base backoff delay in ms. Default: 1000. */
  backoffMs?: number | undefined
  /** Exponential multiplier between attempts. Default: 2. */
  backoffMultiplier?: number | undefined
  /** Maximum delay cap in ms. Default: 30_000. */
  maxBackoffMs?: number | undefined
  /** Whether to add ±25% jitter to each delay. Default: true. */
  backoffJitter?: boolean | undefined
}

/**
 * Compute the backoff delay (in ms) before attempt `attemptNumber`. The
 * first attempt (`attemptNumber === 1`) returns 0; each subsequent attempt
 * uses `base * multiplier^(n-1)` capped at `maxBackoffMs`, with optional
 * ±25% jitter.
 */
export function computeBackoffDelay(
  attemptNumber: number,
  config: RecoveryLoopConfig,
): number {
  if (attemptNumber <= 1) return 0
  // Reuse the canonical exponent+cap math from @dzupagent/core (attempt is
  // 0-based there; our attemptNumber is 1-based with attempt 1 = no delay).
  // Jitter stays local: the recovery loop uses a +0–25% shape, distinct from
  // core's equal-jitter model, so we apply it after the capped base delay.
  const delay = calculateBackoff(attemptNumber - 1, {
    initialBackoffMs: config.backoffMs ?? 1000,
    maxBackoffMs: config.maxBackoffMs ?? 30_000,
    multiplier: config.backoffMultiplier ?? 2,
  })
  if (config.backoffJitter !== false) {
    return delay + Math.random() * delay * 0.25
  }
  return delay
}

/**
 * Sleep for `delayMs` while honouring an optional `AbortSignal`. Resolves
 * when the timer fires; rejects with `Error('Aborted during backoff')` if
 * the signal aborts first. Uses `unref()` so the timer never holds the
 * event loop open.
 */
export function delayWithSignal(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs)
    if (typeof timer.unref === 'function') timer.unref()
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('Aborted during backoff'))
      },
      { once: true },
    )
  })
}
