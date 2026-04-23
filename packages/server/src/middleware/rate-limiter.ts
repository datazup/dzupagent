/**
 * Token-bucket rate limiter middleware for DzupAgent server.
 *
 * Limits requests per API key (or per IP if unauthenticated).
 * Uses a sliding-window token bucket algorithm.
 *
 * Supports per-tier rate limits driven by `ApiKeyRecord.rateLimitTier`.
 * When auth middleware has populated `c.get('apiKey')` with a record
 * containing a `rateLimitTier` field that matches a key in `config.tiers`,
 * the tier-specific limits are applied instead of the global defaults.
 */
import type { MiddlewareHandler } from 'hono'

export interface RateLimiterTierConfig {
  /** Max requests per window for this tier */
  maxRequests: number
  /** Window duration in ms for this tier */
  windowMs: number
}

export interface RateLimiterConfig {
  /** Max requests per window (default: 100) */
  maxRequests: number
  /** Window duration in ms (default: 60_000 = 1 minute) */
  windowMs: number
  /** Header name for rate limit info (default: 'X-RateLimit') */
  headerPrefix: string
  /**
   * Function to extract the rate limit key from a request.
   *
   * If omitted, the middleware uses the built-in extractor, which keys on the
   * bearer token when present and otherwise falls back to anonymous unless
   * `trustForwardedFor` is explicitly enabled.
   */
  keyExtractor?: (c: { req: { header: (name: string) => string | undefined }; env?: Record<string, unknown> }) => string
  /**
   * Trust the left-most X-Forwarded-For entry when no bearer token is present.
   *
   * Disabled by default because raw forwarded headers are trivially spoofed.
   */
  trustForwardedFor?: boolean
  /**
   * Per-tier rate limit overrides. Keys match `ApiKeyRecord.rateLimitTier`
   * values (e.g. "standard", "premium", "admin"). When the authenticated
   * request's tier matches a key here, that tier's `maxRequests`/`windowMs`
   * are used instead of the top-level defaults.
   */
  tiers?: Record<string, RateLimiterTierConfig>
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

function extractBearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(trimmed)
  if (!match) return undefined
  const token = match[1]?.trim()
  return token && token.length > 0 ? token : undefined
}

function extractClientIp(forwardedFor: string | undefined): string | undefined {
  if (!forwardedFor) return undefined
  const first = forwardedFor.split(',', 1)[0]?.trim()
  return first && first.length > 0 ? first : undefined
}

export function extractDefaultRateLimitKey(
  c: { req: { header: (name: string) => string | undefined } },
  options?: Pick<RateLimiterConfig, 'trustForwardedFor'>,
): string {
  const bearerToken = extractBearerToken(c.req.header('Authorization'))
  if (bearerToken) return bearerToken

  if (options?.trustForwardedFor) {
    return extractClientIp(c.req.header('X-Forwarded-For')) ?? 'anonymous'
  }

  return 'anonymous'
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
  const globalMaxRequests = config?.maxRequests ?? DEFAULT_CONFIG.maxRequests
  const globalWindowMs = config?.windowMs ?? DEFAULT_CONFIG.windowMs
  const prefix = config?.headerPrefix ?? DEFAULT_CONFIG.headerPrefix
  const trustForwardedFor = config?.trustForwardedFor ?? false
  const tiers = config?.tiers

  // One limiter per tier so bucket sizes and refill rates match the tier's
  // configured window. Unknown tiers (and unauthenticated requests) fall
  // through to the default limiter.
  const defaultLimiter = new TokenBucketLimiter({
    maxRequests: globalMaxRequests,
    windowMs: globalWindowMs,
  })
  const tierLimiters = new Map<string, TokenBucketLimiter>()
  if (tiers) {
    for (const [name, cfg] of Object.entries(tiers)) {
      tierLimiters.set(
        name,
        new TokenBucketLimiter({
          maxRequests: cfg.maxRequests,
          windowMs: cfg.windowMs,
        }),
      )
    }
  }

  return async (c, next) => {
    // Skip rate limiting for health endpoints
    if (c.req.path.startsWith('/api/health')) {
      return next()
    }

    const key = config?.keyExtractor?.(c)
      ?? extractDefaultRateLimitKey(c, { trustForwardedFor })

    // Resolve tier from auth-populated API key metadata, if any.
    const apiKeyMeta = c.get('apiKey' as never) as
      | { rateLimitTier?: string }
      | undefined
    const tier = apiKeyMeta?.rateLimitTier
    const tierLimiter = tier ? tierLimiters.get(tier) : undefined
    const effectiveLimiter = tierLimiter ?? defaultLimiter
    const tierCfg = tier && tiers ? tiers[tier] : undefined
    const effectiveMax = tierCfg?.maxRequests ?? globalMaxRequests

    const result = effectiveLimiter.consume(key)

    c.header(`${prefix}-Limit`, String(effectiveMax))
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
