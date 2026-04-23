/**
 * Sliding-window rate limiter for per-sender AgentMail throttling.
 *
 * Each sender is allowed at most `maxMessages` successful `isAllowed()` calls
 * within any rolling `windowMs` interval. Timestamps older than the window are
 * evicted on the next check, giving the window an effective cursor that
 * advances with wall-clock time.
 */

/** Configuration for {@link RateLimiter}. */
export interface RateLimiterConfig {
  /** Maximum allowed messages per sender inside the window. */
  maxMessages: number
  /** Sliding-window size in milliseconds. */
  windowMs: number
  /** Optional clock override (useful for deterministic tests). */
  now?: () => number
}

/** Default rate-limit defaults: 10 messages per 1 000ms. */
export const DEFAULT_RATE_LIMIT: Pick<
  RateLimiterConfig,
  'maxMessages' | 'windowMs'
> = {
  maxMessages: 10,
  windowMs: 1000,
}

export class RateLimiter {
  private readonly maxMessages: number
  private readonly windowMs: number
  private readonly now: () => number
  private readonly timestamps = new Map<string, number[]>()

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.maxMessages = config.maxMessages ?? DEFAULT_RATE_LIMIT.maxMessages
    this.windowMs = config.windowMs ?? DEFAULT_RATE_LIMIT.windowMs
    this.now = config.now ?? Date.now

    if (this.maxMessages <= 0) {
      throw new Error('RateLimiter: maxMessages must be > 0')
    }
    if (this.windowMs <= 0) {
      throw new Error('RateLimiter: windowMs must be > 0')
    }
  }

  /**
   * Returns true and records the call if the sender is within budget.
   * Returns false and records nothing when the sender is over the limit.
   */
  isAllowed(senderId: string): boolean {
    const now = this.now()
    const cutoff = now - this.windowMs
    const bucket = this.timestamps.get(senderId)

    if (!bucket) {
      this.timestamps.set(senderId, [now])
      return true
    }

    // Evict expired timestamps in-place.
    let writeIdx = 0
    for (let readIdx = 0; readIdx < bucket.length; readIdx++) {
      const ts = bucket[readIdx]!
      if (ts > cutoff) {
        bucket[writeIdx++] = ts
      }
    }
    bucket.length = writeIdx

    if (bucket.length >= this.maxMessages) {
      return false
    }

    bucket.push(now)
    return true
  }

  /** Current number of in-window timestamps for a sender (for diagnostics). */
  currentCount(senderId: string): number {
    const bucket = this.timestamps.get(senderId)
    if (!bucket) return 0
    const cutoff = this.now() - this.windowMs
    return bucket.filter((ts) => ts > cutoff).length
  }

  /** Reset tracking for a single sender, or all senders when omitted. */
  reset(senderId?: string): void {
    if (senderId === undefined) {
      this.timestamps.clear()
    } else {
      this.timestamps.delete(senderId)
    }
  }
}

/** Thrown by AgentMail.send() when the sender is rate-limited. */
export class MailRateLimitedError extends Error {
  readonly senderId: string
  readonly maxMessages: number
  readonly windowMs: number

  constructor(senderId: string, maxMessages: number, windowMs: number) {
    super(
      `Mail send rate-limited for sender "${senderId}": ` +
        `exceeded ${maxMessages} messages per ${windowMs}ms window`,
    )
    this.name = 'MailRateLimitedError'
    this.senderId = senderId
    this.maxMessages = maxMessages
    this.windowMs = windowMs
  }
}
