/**
 * Per-recipient token-bucket rate limiter for agent mail delivery.
 *
 * Each recipient owns an independent bucket with a fixed capacity and a
 * constant refill rate expressed in tokens-per-minute. Buckets are lazily
 * created on first use and stored in-process in a `Map` — there is no
 * external state (no Redis, no DB). This is intentional: the limiter is a
 * soft guard against mail storms within a single server process. For
 * multi-node deployments, overflow lands in the DLQ and is retried, so the
 * DLQ acts as the cross-process backstop.
 *
 * Refill is computed lazily on each {@link MailRateLimiter.tryConsume} call
 * using wall-clock time, so idle buckets do not accumulate scheduler work.
 */
import { KeyedTokenBucketRateLimiter } from '@dzupagent/security'

/** Default bucket capacity (10 messages). */
export const DEFAULT_CAPACITY = 10

/** Default refill rate (10 tokens per minute). */
export const DEFAULT_REFILL_PER_MINUTE = 10

/** Configuration for {@link MailRateLimiter}. */
export interface MailRateLimiterConfig {
  /** Maximum tokens per bucket. Defaults to {@link DEFAULT_CAPACITY}. */
  capacity?: number
  /** Tokens added per minute. Defaults to {@link DEFAULT_REFILL_PER_MINUTE}. */
  refillPerMinute?: number
  /** Injected clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Error thrown when a recipient's bucket is empty.
 *
 * Callers should catch this, enqueue to the DLQ with `failReason="rate_limit"`,
 * and surface a 429 to the API consumer.
 */
export class MailRateLimitError extends Error {
  constructor(
    public readonly recipientId: string,
    public readonly retryAfterMs: number,
  ) {
    super(`Mail rate limit exceeded for recipient ${recipientId}`)
    this.name = 'MailRateLimitError'
  }
}

/**
 * In-process token-bucket rate limiter keyed by recipient id.
 *
 * Thread-safety note: Node.js single-threaded event loop makes the Map
 * mutations race-free within a process.
 */
export class MailRateLimiter {
  private readonly buckets: KeyedTokenBucketRateLimiter
  private readonly capacity: number
  private readonly refillPerMinute: number

  constructor(config: MailRateLimiterConfig = {}) {
    this.capacity = config.capacity ?? DEFAULT_CAPACITY
    this.refillPerMinute = config.refillPerMinute ?? DEFAULT_REFILL_PER_MINUTE

    if (this.capacity <= 0) {
      throw new Error('MailRateLimiter capacity must be > 0')
    }
    if (this.refillPerMinute <= 0) {
      throw new Error('MailRateLimiter refillPerMinute must be > 0')
    }

    this.buckets = new KeyedTokenBucketRateLimiter({
      capacity: this.capacity,
      refillPerMs: this.refillPerMinute / 60_000,
      ...(config.now ? { now: config.now } : {}),
    })
  }

  /**
   * Attempt to consume one token for the given recipient.
   *
   * @returns `true` if a token was consumed, `false` if the bucket is empty.
   */
  tryConsume(recipientId: string): boolean {
    return this.buckets.consume(recipientId).allowed
  }

  /**
   * Consume a token or throw {@link MailRateLimitError}.
   *
   * Convenience wrapper over {@link tryConsume} for callers that prefer
   * exception-based control flow (e.g. `DrizzleMailboxStore.save()`).
   */
  consumeOrThrow(recipientId: string): void {
    if (!this.tryConsume(recipientId)) {
      const retryAfterMs = Math.ceil(60_000 / this.refillPerMinute)
      throw new MailRateLimitError(recipientId, retryAfterMs)
    }
  }

  /**
   * Test-only inspection: current token count for a recipient.
   * Returns the full capacity if no bucket has been created yet.
   */
  inspect(recipientId: string): { tokens: number; capacity: number } {
    return this.buckets.inspect(recipientId)
  }

  /** Reset all buckets. Intended for tests. */
  reset(): void {
    this.buckets.reset()
  }
}
