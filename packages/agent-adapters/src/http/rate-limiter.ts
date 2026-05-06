/**
 * Sliding window rate limiter for HTTP endpoints.
 * Tracks request counts per key within configurable time windows.
 */
import { FixedWindowRateLimiter } from '@dzupagent/security'

export interface RateLimitConfig {
  /** Max requests per window. Default: 100 */
  maxRequests: number
  /** Window duration in ms. Default: 60_000 (1 minute) */
  windowMs: number
}

export class SlidingWindowRateLimiter {
  private readonly limiter: FixedWindowRateLimiter

  constructor(config?: Partial<RateLimitConfig>) {
    this.limiter = new FixedWindowRateLimiter(config)
  }

  /**
   * Check if a request is allowed for the given key.
   * Returns true if allowed, false if rate limited.
   */
  check(key: string): boolean {
    return this.limiter.check(key)
  }

  /** Returns remaining requests in current window for a key */
  remaining(key: string): number {
    return this.limiter.remaining(key)
  }

  /** Reset all rate limit counters */
  reset(): void {
    this.limiter.reset()
  }

  /** Evict expired windows to prevent memory growth */
  evictExpired(): void {
    this.limiter.evictExpired()
  }
}
