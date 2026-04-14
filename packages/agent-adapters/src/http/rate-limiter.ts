/**
 * Sliding window rate limiter for HTTP endpoints.
 * Tracks request counts per key within configurable time windows.
 */

export interface RateLimitConfig {
  /** Max requests per window. Default: 100 */
  maxRequests: number
  /** Window duration in ms. Default: 60_000 (1 minute) */
  windowMs: number
}

interface WindowEntry {
  count: number
  windowStart: number
}

export class SlidingWindowRateLimiter {
  private readonly windows = new Map<string, WindowEntry>()
  private readonly maxRequests: number
  private readonly windowMs: number

  constructor(config?: Partial<RateLimitConfig>) {
    this.maxRequests = config?.maxRequests ?? 100
    this.windowMs = config?.windowMs ?? 60_000
  }

  /**
   * Check if a request is allowed for the given key.
   * Returns true if allowed, false if rate limited.
   */
  check(key: string): boolean {
    const now = Date.now()
    const entry = this.windows.get(key)

    if (!entry || now - entry.windowStart >= this.windowMs) {
      // New window
      this.windows.set(key, { count: 1, windowStart: now })
      return true
    }

    if (entry.count >= this.maxRequests) {
      return false
    }

    entry.count++
    return true
  }

  /** Returns remaining requests in current window for a key */
  remaining(key: string): number {
    const now = Date.now()
    const entry = this.windows.get(key)
    if (!entry || now - entry.windowStart >= this.windowMs) {
      return this.maxRequests
    }
    return Math.max(0, this.maxRequests - entry.count)
  }

  /** Reset all rate limit counters */
  reset(): void {
    this.windows.clear()
  }

  /** Evict expired windows to prevent memory growth */
  evictExpired(): void {
    const now = Date.now()
    for (const [key, entry] of this.windows) {
      if (now - entry.windowStart >= this.windowMs) {
        this.windows.delete(key)
      }
    }
  }
}
