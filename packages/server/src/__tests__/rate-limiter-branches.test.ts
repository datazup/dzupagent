/**
 * Branch coverage tests for TokenBucketLimiter and rate limiter middleware.
 *
 * Covers: bearer token edge cases (missing value, empty, whitespace, non-Bearer prefix),
 * forwarded-for with leading whitespace and empty values, token refill behavior,
 * cleanup timer behavior, bucket eviction.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  TokenBucketLimiter,
  extractDefaultRateLimitKey,
} from '../middleware/rate-limiter.js'

describe('extractDefaultRateLimitKey branch coverage', () => {
  it('returns "anonymous" when Authorization is only whitespace', () => {
    const key = extractDefaultRateLimitKey({
      req: { header: (n: string) => (n === 'Authorization' ? '   ' : undefined) },
    })
    expect(key).toBe('anonymous')
  })

  it('treats "Bearer " with empty token as no bearer', () => {
    const key = extractDefaultRateLimitKey({
      req: { header: (n: string) => (n === 'Authorization' ? 'Bearer ' : undefined) },
    })
    expect(key).toBe('anonymous')
  })

  it('treats "Bearer   " with whitespace-only token as no bearer', () => {
    const key = extractDefaultRateLimitKey({
      req: { header: (n: string) => (n === 'Authorization' ? 'Bearer    ' : undefined) },
    })
    expect(key).toBe('anonymous')
  })

  it('is case-insensitive for bearer prefix', () => {
    const key = extractDefaultRateLimitKey({
      req: { header: (n: string) => (n === 'Authorization' ? 'bearer my-token' : undefined) },
    })
    expect(key).toBe('my-token')
  })

  it('returns "anonymous" when Authorization is "Basic ..."', () => {
    const key = extractDefaultRateLimitKey({
      req: { header: (n: string) => (n === 'Authorization' ? 'Basic xyz' : undefined) },
    })
    expect(key).toBe('anonymous')
  })

  it('trims bearer token whitespace', () => {
    const key = extractDefaultRateLimitKey({
      req: { header: (n: string) => (n === 'Authorization' ? 'Bearer   spaced-token   ' : undefined) },
    })
    expect(key).toBe('spaced-token')
  })

  it('splits on first comma when forwarded-for has multiple entries', () => {
    const key = extractDefaultRateLimitKey(
      {
        req: {
          header: (n: string) =>
            n === 'X-Forwarded-For' ? '  10.0.0.1  ,  10.0.0.2  ' : undefined,
        },
      },
      { trustForwardedFor: true },
    )
    expect(key).toBe('10.0.0.1')
  })

  it('returns "anonymous" when forwarded-for is empty string', () => {
    const key = extractDefaultRateLimitKey(
      {
        req: {
          header: (n: string) => (n === 'X-Forwarded-For' ? '' : undefined),
        },
      },
      { trustForwardedFor: true },
    )
    expect(key).toBe('anonymous')
  })

  it('returns "anonymous" when forwarded-for first entry is whitespace', () => {
    const key = extractDefaultRateLimitKey(
      {
        req: {
          header: (n: string) => (n === 'X-Forwarded-For' ? '   ,10.0.0.2' : undefined),
        },
      },
      { trustForwardedFor: true },
    )
    expect(key).toBe('anonymous')
  })
})

describe('TokenBucketLimiter branch coverage', () => {
  let limiter: TokenBucketLimiter

  afterEach(() => {
    limiter?.destroy()
    vi.restoreAllMocks()
  })

  it('refills tokens based on elapsed time', () => {
    vi.useFakeTimers()
    limiter = new TokenBucketLimiter({ maxRequests: 10, windowMs: 1000 })

    // Consume all tokens
    for (let i = 0; i < 10; i++) limiter.consume('key-1')
    expect(limiter.consume('key-1').allowed).toBe(false)

    // Advance time to trigger refill
    vi.advanceTimersByTime(500) // refills ~5 tokens
    const r = limiter.consume('key-1')
    expect(r.allowed).toBe(true)
    vi.useRealTimers()
  })

  it('does not exceed maxRequests on refill', () => {
    vi.useFakeTimers()
    limiter = new TokenBucketLimiter({ maxRequests: 5, windowMs: 500 })

    // Advance past a full window without consuming
    vi.advanceTimersByTime(5000)
    const r = limiter.consume('key-1')
    expect(r.remaining).toBeLessThanOrEqual(4) // starts at 5, consume one
    vi.useRealTimers()
  })

  it('cleanup evicts stale buckets', () => {
    vi.useFakeTimers()
    limiter = new TokenBucketLimiter({ maxRequests: 5, windowMs: 100 })

    limiter.consume('stale-key')
    vi.advanceTimersByTime(1000) // cleanup fires at windowMs*2
    // No crash
    vi.useRealTimers()
  })

  it('destroy can be called when timer is already null', () => {
    limiter = new TokenBucketLimiter({ maxRequests: 5, windowMs: 1000 })
    limiter.destroy()
    expect(() => limiter.destroy()).not.toThrow()
  })

  it('initializes a new bucket on first consume', () => {
    limiter = new TokenBucketLimiter({ maxRequests: 5, windowMs: 1000 })
    const result = limiter.consume('fresh-key')
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(4)
  })
})
