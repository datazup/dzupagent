/**
 * Token-bucket rate limiter for client-side LLM call throttling.
 *
 * Implements the classic continuous-refill token bucket. Tokens accrue
 * at `refillPerSecond` up to `capacity`. Each guarded operation consumes
 * one or more tokens; when the bucket is empty, callers can either:
 *
 *   - call `consume()` for a non-blocking probe (returns false if empty)
 *   - call `waitUntilAvailable()` which sleeps (no busy-wait) until enough
 *     tokens have accrued, throwing `ForgeError(RATE_LIMIT_EXCEEDED)`
 *     if a 30 s safety cap is exceeded.
 *
 * Pure TypeScript — no external dependencies. Time math is done with
 * `Date.now()` so the bucket is monotonic-ish but fine for the calls/sec
 * granularity needed for LLM rate-limiting.
 */

import { ForgeError } from '../errors/forge-error.js'

/** Configuration for {@link TokenBucket}. */
export interface TokenBucketConfig {
  /** Max tokens in the bucket. */
  capacity: number
  /** Refill rate: tokens added per second. */
  refillPerSecond: number
  /**
   * Maximum time `waitUntilAvailable()` will sleep before throwing
   * `RATE_LIMIT_EXCEEDED`. Defaults to 30 000 ms.
   */
  maxWaitMs?: number
}

const DEFAULT_MAX_WAIT_MS = 30_000

/**
 * Continuous-refill token bucket. Safe for use in agent hot paths —
 * `waitUntilAvailable()` uses `setTimeout` based sleeping, never a busy
 * loop, so the event loop is free during throttling.
 */
export class TokenBucket {
  private readonly capacity: number
  private readonly refillPerSecond: number
  private readonly maxWaitMs: number
  private tokens: number
  private lastRefillAt: number

  constructor(config: TokenBucketConfig) {
    if (!Number.isFinite(config.capacity) || config.capacity <= 0) {
      throw new ForgeError({
        code: 'INVALID_CONFIG',
        message: `TokenBucket: capacity must be > 0, got ${config.capacity}`,
      })
    }
    if (!Number.isFinite(config.refillPerSecond) || config.refillPerSecond <= 0) {
      throw new ForgeError({
        code: 'INVALID_CONFIG',
        message: `TokenBucket: refillPerSecond must be > 0, got ${config.refillPerSecond}`,
      })
    }

    this.capacity = config.capacity
    this.refillPerSecond = config.refillPerSecond
    this.maxWaitMs = config.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
    this.tokens = config.capacity
    this.lastRefillAt = Date.now()
  }

  /** Currently available tokens (after refill). */
  get available(): number {
    this.refill()
    return this.tokens
  }

  /**
   * Attempt to consume `tokens` tokens. Returns `true` on success,
   * `false` when the bucket lacks enough tokens. Never blocks.
   */
  consume(tokens: number = 1): boolean {
    if (!Number.isFinite(tokens) || tokens <= 0) {
      throw new ForgeError({
        code: 'INVALID_CONFIG',
        message: `TokenBucket.consume: tokens must be > 0, got ${tokens}`,
      })
    }
    this.refill()
    if (this.tokens >= tokens) {
      this.tokens -= tokens
      return true
    }
    return false
  }

  /**
   * Sleep until `tokens` tokens are available, then consume them.
   *
   * Throws `ForgeError({ code: 'RATE_LIMIT_EXCEEDED' })` if the wait
   * would exceed `maxWaitMs` (configurable, default 30 s). Never
   * busy-waits — sleeps are scheduled via `setTimeout`.
   */
  async waitUntilAvailable(tokens: number = 1): Promise<void> {
    if (!Number.isFinite(tokens) || tokens <= 0) {
      throw new ForgeError({
        code: 'INVALID_CONFIG',
        message: `TokenBucket.waitUntilAvailable: tokens must be > 0, got ${tokens}`,
      })
    }
    if (tokens > this.capacity) {
      throw new ForgeError({
        code: 'RATE_LIMIT_EXCEEDED',
        message: `TokenBucket: requested ${tokens} tokens exceeds capacity ${this.capacity}`,
        suggestion: 'Increase TokenBucket capacity or request fewer tokens per call.',
      })
    }

    const startedAt = Date.now()

    // Single retry loop. Each iteration computes the wait needed for
    // the requested tokens, sleeps once, and re-checks. The loop
    // terminates either by consuming the tokens or by exceeding
    // maxWaitMs.
    while (true) {
      this.refill()
      if (this.tokens >= tokens) {
        this.tokens -= tokens
        return
      }

      const deficit = tokens - this.tokens
      // Time required for `deficit` tokens to accrue, in ms.
      const waitMs = Math.ceil((deficit / this.refillPerSecond) * 1000)
      const elapsed = Date.now() - startedAt

      if (elapsed + waitMs > this.maxWaitMs) {
        throw new ForgeError({
          code: 'RATE_LIMIT_EXCEEDED',
          message: `TokenBucket: would wait ${elapsed + waitMs}ms (max ${this.maxWaitMs}ms) for ${tokens} token(s)`,
          recoverable: true,
          suggestion: 'Increase rate-limit capacity, reduce concurrency, or raise maxWaitMs.',
          context: { tokens, capacity: this.capacity, refillPerSecond: this.refillPerSecond },
        })
      }

      await sleep(waitMs)
    }
  }

  /** Refill tokens based on time elapsed since the last refill. */
  private refill(): void {
    const now = Date.now()
    const elapsedMs = now - this.lastRefillAt
    if (elapsedMs <= 0) return
    const accrued = (elapsedMs / 1000) * this.refillPerSecond
    if (accrued <= 0) return
    this.tokens = Math.min(this.capacity, this.tokens + accrued)
    this.lastRefillAt = now
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}
