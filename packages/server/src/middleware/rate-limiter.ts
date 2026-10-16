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
 *
 * The principal and its tier only exist after auth, so the composed app uses
 * {@link createRateLimitMiddlewares}: an address-keyed flood guard ahead of
 * auth and the principal/tier limiter behind it (DZUPAGENT-SEC-H-23).
 */
import type { MiddlewareHandler } from 'hono'
import { KeyedTokenBucketRateLimiter } from '@dzupagent/security'
import { createHash } from 'node:crypto'

import type { ApiKeyContext, AppEnv } from '../types.js'

type RateLimitKeyContext = {
  req: { header: (name: string) => string | undefined }
  env?: unknown
  get?: (key: 'apiKey') => ApiKeyContext | undefined
}

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
   * If omitted, the middleware uses the resolved API-key principal when one is
   * available. Pre-auth requests use a hashed client-IP bucket and never use
   * attacker-supplied bearer-token material.
   */
  keyExtractor?: (c: RateLimitKeyContext) => string
  /**
   * Trust the left-most X-Forwarded-For entry for the client-IP bucket.
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

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxRequests: 100,
  windowMs: 60_000,
  headerPrefix: 'X-RateLimit',
}

function extractClientIp(forwardedFor: string | undefined): string | undefined {
  if (!forwardedFor) return undefined
  const first = forwardedFor.split(',', 1)[0]?.trim()
  return first && first.length > 0 ? first : undefined
}

function extractPrincipalId(apiKey: ApiKeyContext | undefined): string | undefined {
  if (!apiKey) return undefined
  for (const candidate of [apiKey.id, apiKey.globalUserId, apiKey.ownerId]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

function hashClientIp(clientIp: string): string {
  return createHash('sha256').update(clientIp).digest('hex')
}

/**
 * Remote address of the connection, as exposed by `@hono/node-server`
 * (`c.env.incoming.socket.remoteAddress`). Undefined on runtimes or test
 * harnesses that do not provide a socket.
 */
function extractConnectionAddress(env: unknown): string | undefined {
  if (!env || typeof env !== 'object') return undefined
  const incoming = (env as { incoming?: { socket?: { remoteAddress?: unknown } } }).incoming
  const address = incoming?.socket?.remoteAddress
  return typeof address === 'string' && address.length > 0 ? address : undefined
}

/**
 * Hashed client-address bucket: the trusted forwarded entry when enabled,
 * otherwise the connection address. Only a request with neither falls back to
 * the shared `anonymous` bucket.
 */
export function extractClientAddressKey(
  c: RateLimitKeyContext,
  options?: Pick<RateLimiterConfig, 'trustForwardedFor'>,
): string {
  const forwarded = options?.trustForwardedFor
    ? extractClientIp(c.req.header('X-Forwarded-For'))
    : undefined
  const clientIp = forwarded ?? extractConnectionAddress(c.env) ?? 'anonymous'
  return `ip:${hashClientIp(clientIp)}`
}

export function extractDefaultRateLimitKey(
  c: RateLimitKeyContext,
  options?: Pick<RateLimiterConfig, 'trustForwardedFor'>,
): string {
  const principalId = extractPrincipalId(c.get?.('apiKey'))
  if (principalId) return `principal:${principalId}`
  return extractClientAddressKey(c, options)
}

export class TokenBucketLimiter {
  private readonly buckets: KeyedTokenBucketRateLimiter
  private readonly config: RateLimiterConfig
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.buckets = new KeyedTokenBucketRateLimiter({
      capacity: this.config.maxRequests,
      refillPerMs: this.config.maxRequests / this.config.windowMs,
    })
    // Periodic cleanup of expired buckets
    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.windowMs * 2)
  }

  /** Try to consume a token. Returns remaining tokens or -1 if rate limited. */
  consume(key: string): { allowed: boolean; remaining: number; resetMs: number } {
    const result = this.buckets.consume(key)
    const perTokenResetMs = Math.ceil(this.config.windowMs / this.config.maxRequests)
    return {
      allowed: result.allowed,
      remaining: result.remaining,
      resetMs: result.retryAfterMs > 0 ? result.retryAfterMs : perTokenResetMs,
    }
  }

  /**
   * Check whether `key` has a token left without consuming it. `resetMs` is
   * the wait until one token is available when it has none.
   */
  peek(key: string): { allowed: boolean; resetMs: number } {
    const tokens = this.buckets.available(key)
    if (tokens >= 1) return { allowed: true, resetMs: 0 }
    const refillPerMs = this.config.maxRequests / this.config.windowMs
    return { allowed: false, resetMs: Math.ceil((1 - tokens) / refillPerMs) }
  }

  /** Clean up stale entries */
  private cleanup(): void {
    this.buckets.evictIdle(this.config.windowMs * 2)
  }

  /** Stop the cleanup timer */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }
}

function isHealthPath(path: string): boolean {
  return path === '/api/health' || path.startsWith('/api/health/')
}

function rateLimitedResponse(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  resetMs: number,
): Response {
  c.header('Retry-After', String(Math.ceil(resetMs / 1000)))
  return c.json(
    { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please retry later.' } },
    429,
  )
}

/**
 * Pre-auth flood guard keyed only on the client address. It charges a token
 * only for requests that end without an authenticated principal (failed auth,
 * public routes), and rejects once the address has none left — before another
 * auth lookup. Authenticated traffic is limited per principal after auth and
 * never drains the address bucket, so tenants sharing an egress address do
 * not throttle each other.
 */
function preAuthRateLimiterMiddleware(config?: Partial<RateLimiterConfig>): MiddlewareHandler<AppEnv> {
  const trustForwardedFor = config?.trustForwardedFor ?? false
  const limiter = new TokenBucketLimiter({
    maxRequests: config?.maxRequests ?? DEFAULT_CONFIG.maxRequests,
    windowMs: config?.windowMs ?? DEFAULT_CONFIG.windowMs,
  })

  return async (c, next) => {
    if (isHealthPath(c.req.path)) return next()
    const key = extractClientAddressKey(c, { trustForwardedFor })
    const state = limiter.peek(key)
    if (!state.allowed) return rateLimitedResponse(c, state.resetMs)
    await next()
    if (!extractPrincipalId(c.get('apiKey'))) limiter.consume(key)
  }
}

/**
 * The two halves of `/api/*` limiting: `preAuth` must be mounted before the
 * auth middleware and `postAuth` after it, so the post-auth limiter sees the
 * resolved principal and its `rateLimitTier`.
 */
export function createRateLimitMiddlewares(config?: Partial<RateLimiterConfig>): {
  preAuth: MiddlewareHandler<AppEnv>
  postAuth: MiddlewareHandler<AppEnv>
} {
  return {
    preAuth: preAuthRateLimiterMiddleware(config),
    postAuth: rateLimiterMiddleware(config),
  }
}

/**
 * Create Hono rate limiting middleware keyed on the resolved principal (or the
 * client address). Mount it after auth; see {@link createRateLimitMiddlewares}.
 */
export function rateLimiterMiddleware(config?: Partial<RateLimiterConfig>): MiddlewareHandler<AppEnv> {
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
    if (isHealthPath(c.req.path)) {
      return next()
    }

    const key = config?.keyExtractor?.(c)
      ?? extractDefaultRateLimitKey(c, { trustForwardedFor })

    // Resolve tier from auth-populated API key metadata, if any.
    const apiKeyMeta = c.get('apiKey')
    const tier = apiKeyMeta?.rateLimitTier
    const tierLimiter = tier ? tierLimiters.get(tier) : undefined
    const effectiveLimiter = tierLimiter ?? defaultLimiter
    const tierCfg = tier && tiers ? tiers[tier] : undefined
    const effectiveMax = tierCfg?.maxRequests ?? globalMaxRequests

    const result = effectiveLimiter.consume(key)

    c.header(`${prefix}-Limit`, String(effectiveMax))
    c.header(`${prefix}-Remaining`, String(result.remaining))

    if (!result.allowed) return rateLimitedResponse(c, result.resetMs)

    return next()
  }
}
