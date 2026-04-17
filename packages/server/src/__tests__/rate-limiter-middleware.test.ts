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
