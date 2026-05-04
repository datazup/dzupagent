/**
 * RecoveryLoopRunner — shared retry / exponential-backoff scaffold for the
 * recovery copilot.
 *
 * Both `executeWithRecovery` and `executeWithRecoveryStream` walk a bounded
 * sequence of attempts that apply a backoff delay between iterations. The
 * delay logic, jitter, AbortSignal handling, and per-iteration counter were
 * previously duplicated; this class isolates them so the recovery copilot
 * can focus on strategy selection and failure handling.
 *
 * The runner is intentionally agnostic about the *contents* of an attempt —
 * it accepts a callback (for `run`) or an async generator (for `runStream`)
 * and forwards the iteration index plus an `AbortSignal` so the caller can
 * cooperatively cancel between attempts. The caller decides what counts as
 * success vs. failure by either returning normally, throwing, or yielding.
 *
 * @module recovery/recovery-loop-runner
 */

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

export interface AttemptContext {
  /** 1-based attempt number. */
  attempt: number
  /** Total number of permitted attempts (matches `RecoveryLoopConfig.maxAttempts`). */
  maxAttempts: number
  /** Optional cancellation signal forwarded from the caller. */
  signal?: AbortSignal | undefined
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
  const base = config.backoffMs ?? 1000
  const multiplier = config.backoffMultiplier ?? 2
  const max = config.maxBackoffMs ?? 30_000
  let delay = base * Math.pow(multiplier, attemptNumber - 1)
  delay = Math.min(delay, max)
  if (config.backoffJitter !== false) {
    delay += Math.random() * delay * 0.25
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

/**
 * Drives the bounded retry loop. The class is stateless across `run` /
 * `runStream` calls so a single instance can be shared.
 */
export class RecoveryLoopRunner {
  /**
   * Run `attemptFn` up to `maxAttempts` times with exponential backoff
   * between attempts. The callback is responsible for deciding whether a
   * given attempt is final (return) or recoverable (throw). The runner
   * does not catch errors itself — all retry/abort decisions live in the
   * caller; this method is just the loop body + delay.
   */
  async run<T>(
    attemptFn: (ctx: AttemptContext) => Promise<T>,
    config: RecoveryLoopConfig,
    signal?: AbortSignal,
  ): Promise<T> {
    if (config.maxAttempts < 1) {
      throw new Error(`RecoveryLoopRunner.run: maxAttempts must be >= 1 (got ${config.maxAttempts})`)
    }
    let lastError: unknown
    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      if (attempt > 1) {
        await delayWithSignal(computeBackoffDelay(attempt, config), signal)
      }
      try {
        return await attemptFn({ attempt, maxAttempts: config.maxAttempts, signal })
      } catch (err) {
        lastError = err
        if (attempt >= config.maxAttempts) throw err
      }
    }
    // Unreachable: the final attempt either returns or rethrows above.
    throw lastError
  }

  /**
   * Stream variant of `run`: iterate `attemptFn`'s generator output up to
   * `maxAttempts` times. Each attempt's events are forwarded as they are
   * yielded. If the generator throws, the runner waits for backoff and
   * starts the next attempt — until `maxAttempts` is reached, at which
   * point the original error is rethrown.
   */
  async *runStream<T>(
    attemptFn: (ctx: AttemptContext) => AsyncIterable<T>,
    config: RecoveryLoopConfig,
    signal?: AbortSignal,
  ): AsyncIterable<T> {
    if (config.maxAttempts < 1) {
      throw new Error(`RecoveryLoopRunner.runStream: maxAttempts must be >= 1 (got ${config.maxAttempts})`)
    }
    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      if (attempt > 1) {
        await delayWithSignal(computeBackoffDelay(attempt, config), signal)
      }
      try {
        for await (const item of attemptFn({ attempt, maxAttempts: config.maxAttempts, signal })) {
          yield item
        }
        return
      } catch (err) {
        if (attempt >= config.maxAttempts) throw err
      }
    }
  }
}
