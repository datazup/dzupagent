import { describe, it, expect, afterEach } from 'vitest'
import { Hono } from 'hono'
import {
  rateLimiterMiddleware,
  TokenBucketLimiter,
  extractDefaultRateLimitKey,
} from '../middleware/rate-limiter.js'

describe('TokenBucketLimiter', () => {
  let limiter: TokenBucketLimiter

  afterEach(() => {
    limiter?.destroy()
  })

  it('allows requests within the limit', () => {
    limiter = new TokenBucketLimiter({ maxRequests: 3, windowMs: 60_000 })
    const r1 = limiter.consume('key-1')
    expect(r1.allowed).toBe(true)
    expect(r1.remaining).toBe(2)
  })

  it('blocks requests exceeding the limit', () => {
    limiter = new TokenBucketLimiter({ maxRequests: 2, windowMs: 60_000 })
    limiter.consume('key-1')
    limiter.consume('key-1')
    const r3 = limiter.consume('key-1')
    expect(r3.allowed).toBe(false)
    expect(r3.remaining).toBe(0)
  })

  it('tracks different keys independently', () => {
    limiter = new TokenBucketLimiter({ maxRequests: 1, windowMs: 60_000 })
    const r1 = limiter.consume('key-a')
    const r2 = limiter.consume('key-b')
    expect(r1.allowed).toBe(true)
    expect(r2.allowed).toBe(true)

    const r3 = limiter.consume('key-a')
    expect(r3.allowed).toBe(false)
  })

  it('provides resetMs in the result', () => {
    limiter = new TokenBucketLimiter({ maxRequests: 10, windowMs: 10_000 })
    const result = limiter.consume('key-1')
    expect(result.resetMs).toBeGreaterThan(0)
  })

  it('destroy stops the cleanup timer', () => {
    limiter = new TokenBucketLimiter({ maxRequests: 10, windowMs: 1000 })
    limiter.destroy()
    // Should not throw when destroyed twice
    limiter.destroy()
  })
})

describe('extractDefaultRateLimitKey', () => {
  it('returns bearer token when Authorization header has Bearer prefix', () => {
    const key = extractDefaultRateLimitKey({
      req: { header: (name: string) => (name === 'Authorization' ? 'Bearer my-token' : undefined) },
    })
    expect(key).toBe('my-token')
  })

  it('returns "anonymous" when no Authorization header', () => {
    const key = extractDefaultRateLimitKey({
      req: { header: () => undefined },
    })
    expect(key).toBe('anonymous')
  })

  it('returns X-Forwarded-For IP when trustForwardedFor is true and no auth', () => {
    const key = extractDefaultRateLimitKey(
      {
        req: {
          header: (name: string) =>
            name === 'X-Forwarded-For' ? '10.0.0.1, 10.0.0.2' : undefined,
        },
      },
      { trustForwardedFor: true },
    )
    expect(key).toBe('10.0.0.1')
  })

  it('returns "anonymous" when trustForwardedFor is true but no forwarded header', () => {
    const key = extractDefaultRateLimitKey(
      { req: { header: () => undefined } },
      { trustForwardedFor: true },
    )
    expect(key).toBe('anonymous')
  })

  it('prefers bearer token over X-Forwarded-For', () => {
    const key = extractDefaultRateLimitKey(
      {
        req: {
          header: (name: string) => {
            if (name === 'Authorization') return 'Bearer token-123'
            if (name === 'X-Forwarded-For') return '10.0.0.1'
            return undefined
          },
        },
      },
      { trustForwardedFor: true },
    )
    expect(key).toBe('token-123')
  })
})

describe('rateLimiterMiddleware (Hono integration)', () => {
  it('adds rate limit headers to responses', async () => {
    const app = new Hono()
    app.use('/api/*', rateLimiterMiddleware({ maxRequests: 10, windowMs: 60_000 }))
    app.get('/api/test', (c) => c.json({ ok: true }))

    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer test-key' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('X-RateLimit-Limit')).toBe('10')
    expect(res.headers.get('X-RateLimit-Remaining')).toBeTruthy()
  })

  it('returns 429 when rate limit exceeded', async () => {
    const app = new Hono()
    app.use('/api/*', rateLimiterMiddleware({ maxRequests: 1, windowMs: 60_000 }))
    app.get('/api/test', (c) => c.json({ ok: true }))

    // First request consumes the single token
    await app.request('/api/test', {
      headers: { Authorization: 'Bearer limited-key' },
    })

    // Second request should be rate limited
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer limited-key' },
    })
    expect(res.status).toBe(429)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('RATE_LIMITED')
    expect(res.headers.get('Retry-After')).toBeTruthy()
  })

  it('skips rate limiting for health endpoints', async () => {
    const app = new Hono()
    app.use('/api/*', rateLimiterMiddleware({ maxRequests: 1, windowMs: 60_000 }))
    app.get('/api/health', (c) => c.json({ ok: true }))
    app.get('/api/health/ready', (c) => c.json({ ok: true }))

    // Multiple health requests should always pass
    const res1 = await app.request('/api/health')
    const res2 = await app.request('/api/health')
    const res3 = await app.request('/api/health/ready')
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    expect(res3.status).toBe(200)
  })

  it('uses custom headerPrefix', async () => {
    const app = new Hono()
    app.use('/api/*', rateLimiterMiddleware({ maxRequests: 5, windowMs: 60_000, headerPrefix: 'X-Custom' }))
    app.get('/api/test', (c) => c.json({ ok: true }))

    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer k' },
    })
    expect(res.headers.get('X-Custom-Limit')).toBe('5')
  })

  it('uses custom keyExtractor', async () => {
    const app = new Hono()
    app.use('/api/*', rateLimiterMiddleware({
      maxRequests: 1,
      windowMs: 60_000,
      keyExtractor: () => 'custom-key',
    }))
    app.get('/api/test', (c) => c.json({ ok: true }))

    await app.request('/api/test')
    const res = await app.request('/api/test')
    expect(res.status).toBe(429)
  })
})

describe('rateLimiterMiddleware tier enforcement', () => {
  /**
   * Build a minimal Hono app that simulates the auth middleware by setting
   * `c.get('apiKey')` from a test-only header `X-Test-Tier`. This mirrors
   * what the real auth middleware does after validating an API key, without
   * needing to spin up the full createForgeApp pipeline.
   */
  function buildTierApp(cfg: Parameters<typeof rateLimiterMiddleware>[0]) {
    const app = new Hono()
    app.use('/api/*', async (c, next) => {
      const tier = c.req.header('X-Test-Tier')
      if (tier) {
        c.set('apiKey' as never, { rateLimitTier: tier, ownerId: 'u1' } as never)
      }
      return next()
    })
    app.use('/api/*', rateLimiterMiddleware(cfg))
    app.get('/api/test', (c) => c.json({ ok: true }))
    return app
  }

  it('falls back to global defaults when no tier config is provided', async () => {
    const app = buildTierApp({ maxRequests: 2, windowMs: 60_000 })
    const r1 = await app.request('/api/test', {
      headers: { Authorization: 'Bearer k-none-1' },
    })
    const r2 = await app.request('/api/test', {
      headers: { Authorization: 'Bearer k-none-1' },
    })
    const r3 = await app.request('/api/test', {
      headers: { Authorization: 'Bearer k-none-1' },
    })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(r3.status).toBe(429)
    // Limit header reflects the global default, not a tier
    expect(r1.headers.get('X-RateLimit-Limit')).toBe('2')
  })

  it('applies standard tier limits when apiKey.rateLimitTier is "standard"', async () => {
    const app = buildTierApp({
      maxRequests: 2,
      windowMs: 60_000,
      tiers: {
        standard: { maxRequests: 5, windowMs: 60_000 },
        premium: { maxRequests: 100, windowMs: 60_000 },
      },
    })

    // Each unique bearer token gets its own bucket — standard tier allows 5
    const results: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await app.request('/api/test', {
        headers: {
          Authorization: 'Bearer k-std-1',
          'X-Test-Tier': 'standard',
        },
      })
      results.push(res.status)
      if (i === 0) {
        expect(res.headers.get('X-RateLimit-Limit')).toBe('5')
      }
    }
    // First 5 allowed, 6th rate limited
    expect(results.slice(0, 5)).toEqual([200, 200, 200, 200, 200])
    expect(results[5]).toBe(429)
  })

  it('applies premium tier with much higher limit than global default', async () => {
    const app = buildTierApp({
      maxRequests: 1, // global is very restrictive
      windowMs: 60_000,
      tiers: {
        premium: { maxRequests: 50, windowMs: 60_000 },
      },
    })

    // Fire 10 requests — global would block after 1, premium allows 50
    let allowedCount = 0
    for (let i = 0; i < 10; i++) {
      const res = await app.request('/api/test', {
        headers: {
          Authorization: 'Bearer k-prem-1',
          'X-Test-Tier': 'premium',
        },
      })
      if (res.status === 200) allowedCount++
    }
    expect(allowedCount).toBe(10)
  })

  it('falls back to global defaults for an unknown tier name', async () => {
    const app = buildTierApp({
      maxRequests: 2,
      windowMs: 60_000,
      tiers: {
        premium: { maxRequests: 100, windowMs: 60_000 },
      },
    })

    // Unknown tier "platinum" — should use global (max 2)
    const r1 = await app.request('/api/test', {
      headers: { Authorization: 'Bearer k-unk-1', 'X-Test-Tier': 'platinum' },
    })
    const r2 = await app.request('/api/test', {
      headers: { Authorization: 'Bearer k-unk-1', 'X-Test-Tier': 'platinum' },
    })
    const r3 = await app.request('/api/test', {
      headers: { Authorization: 'Bearer k-unk-1', 'X-Test-Tier': 'platinum' },
    })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(r3.status).toBe(429)
    expect(r1.headers.get('X-RateLimit-Limit')).toBe('2')
  })

  it('admin tier with very high limit accommodates burst traffic', async () => {
    const app = buildTierApp({
      maxRequests: 1,
      windowMs: 60_000,
      tiers: {
        admin: { maxRequests: 10_000, windowMs: 60_000 },
      },
    })

    let allowedCount = 0
    for (let i = 0; i < 100; i++) {
      const res = await app.request('/api/test', {
        headers: {
          Authorization: 'Bearer k-admin-1',
          'X-Test-Tier': 'admin',
        },
      })
      if (res.status === 200) allowedCount++
    }
    expect(allowedCount).toBe(100)
  })

  it('different tiers maintain separate bucket pools for the same identity', async () => {
    // Same bearer token but different tiers should not share buckets,
    // because each tier has its own limiter instance.
    const app = buildTierApp({
      maxRequests: 1,
      windowMs: 60_000,
      tiers: {
        standard: { maxRequests: 2, windowMs: 60_000 },
        premium: { maxRequests: 3, windowMs: 60_000 },
      },
    })

    // Exhaust the standard-tier bucket
    const s1 = await app.request('/api/test', {
      headers: { Authorization: 'Bearer shared-key', 'X-Test-Tier': 'standard' },
    })
    const s2 = await app.request('/api/test', {
      headers: { Authorization: 'Bearer shared-key', 'X-Test-Tier': 'standard' },
    })
    const s3 = await app.request('/api/test', {
      headers: { Authorization: 'Bearer shared-key', 'X-Test-Tier': 'standard' },
    })
    expect(s1.status).toBe(200)
    expect(s2.status).toBe(200)
    expect(s3.status).toBe(429)

    // Switching the same key to premium should have a fresh bucket
    const p1 = await app.request('/api/test', {
      headers: { Authorization: 'Bearer shared-key', 'X-Test-Tier': 'premium' },
    })
    expect(p1.status).toBe(200)
    expect(p1.headers.get('X-RateLimit-Limit')).toBe('3')
  })
})
