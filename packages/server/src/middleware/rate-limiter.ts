/**
 * Token-bucket rate limiter middleware for ForgeAgent server.
 *
 * Limits requests per API key (or per IP if unauthenticated).
 * Uses a sliding-window token bucket algorithm.
 */
import type { MiddlewareHandler } from 'hono'

export interface RateLimiterConfig {
  /** Max requests per window (default: 100) */
  maxRequests: number
  /** Window duration in ms (default: 60_000 = 1 minute) */
  windowMs: number
  /** Header name for rate limit info (default: 'X-RateLimit') */
  headerPrefix: string
  /** Function to extract the rate limit key from a request (default: API key or IP) */
  keyExtractor?: (c: { req: { header: (name: string) => string | undefined }; env?: Record<string, unknown> }) => string
}

interface BucketEntry {
  tokens: number
  lastRefill: number
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxRequests: 100,
  windowMs: 60_000,
  headerPrefix: 'X-RateLimit',
}

export class TokenBucketLimiter {
  private buckets = new Map<string, BucketEntry>()
  private readonly config: RateLimiterConfig
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    // Periodic cleanup of expired buckets
    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.windowMs * 2)
  }

  /** Try to consume a token. Returns remaining tokens or -1 if rate limited. */
  consume(key: string): { allowed: boolean; remaining: number; resetMs: number } {
    const now = Date.now()
    let entry = this.buckets.get(key)

    if (!entry) {
      entry = { tokens: this.config.maxRequests, lastRefill: now }
      this.buckets.set(key, entry)
    }

    // Refill tokens based on elapsed time
    const elapsed = now - entry.lastRefill
    const refillRate = this.config.maxRequests / this.config.windowMs
    const refill = Math.floor(elapsed * refillRate)
    if (refill > 0) {
      entry.tokens = Math.min(this.config.maxRequests, entry.tokens + refill)
      entry.lastRefill = now
    }

    const resetMs = Math.ceil((1 / refillRate)) // ms until next token
    if (entry.tokens > 0) {
      entry.tokens--
      return { allowed: true, remaining: entry.tokens, resetMs }
    }

    return { allowed: false, remaining: 0, resetMs }
  }

  /** Clean up stale entries */
  private cleanup(): void {
    const cutoff = Date.now() - this.config.windowMs * 2
    for (const [key, entry] of this.buckets) {
      if (entry.lastRefill < cutoff) {
        this.buckets.delete(key)
      }
    }
  }

  /** Stop the cleanup timer */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }
}

/**
 * Create Hono rate limiting middleware.
 */
export function rateLimiterMiddleware(config?: Partial<RateLimiterConfig>): MiddlewareHandler {
  const limiter = new TokenBucketLimiter(config)
  const prefix = config?.headerPrefix ?? DEFAULT_CONFIG.headerPrefix
  const maxRequests = config?.maxRequests ?? DEFAULT_CONFIG.maxRequests

  return async (c, next) => {
    // Skip rate limiting for health endpoints
    if (c.req.path.startsWith('/api/health')) {
      return next()
    }

    const key = config?.keyExtractor?.(c)
      ?? c.req.header('Authorization')?.slice(7)  // API key
      ?? c.req.header('X-Forwarded-For')
      ?? 'anonymous'

    const result = limiter.consume(key)

    c.header(`${prefix}-Limit`, String(maxRequests))
    c.header(`${prefix}-Remaining`, String(result.remaining))

    if (!result.allowed) {
      c.header('Retry-After', String(Math.ceil(result.resetMs / 1000)))
      return c.json(
        { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please retry later.' } },
        429,
      )
    }

    return next()
  }
}
