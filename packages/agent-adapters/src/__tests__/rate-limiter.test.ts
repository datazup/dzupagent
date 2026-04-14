import { describe, it, expect } from 'vitest'
import { SlidingWindowRateLimiter } from '../http/rate-limiter.js'

describe('SlidingWindowRateLimiter', () => {
  it('allows requests within limit', () => {
    const limiter = new SlidingWindowRateLimiter({ maxRequests: 3, windowMs: 60000 })
    expect(limiter.check('key1')).toBe(true)
    expect(limiter.check('key1')).toBe(true)
    expect(limiter.check('key1')).toBe(true)
  })

  it('blocks requests exceeding limit', () => {
    const limiter = new SlidingWindowRateLimiter({ maxRequests: 2, windowMs: 60000 })
    expect(limiter.check('key1')).toBe(true)
    expect(limiter.check('key1')).toBe(true)
    expect(limiter.check('key1')).toBe(false)
  })

  it('isolates keys', () => {
    const limiter = new SlidingWindowRateLimiter({ maxRequests: 1, windowMs: 60000 })
    expect(limiter.check('a')).toBe(true)
    expect(limiter.check('b')).toBe(true)
    expect(limiter.check('a')).toBe(false)
    expect(limiter.check('b')).toBe(false)
  })

  it('resets window after expiry', () => {
    const limiter = new SlidingWindowRateLimiter({ maxRequests: 1, windowMs: 100 })
    expect(limiter.check('key1')).toBe(true)
    expect(limiter.check('key1')).toBe(false)

    // Simulate time passing by manipulating the window
    // Use a small windowMs and actual delay
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(limiter.check('key1')).toBe(true)
        resolve()
      }, 150)
    })
  })

  it('remaining() returns correct count', () => {
    const limiter = new SlidingWindowRateLimiter({ maxRequests: 5, windowMs: 60000 })
    expect(limiter.remaining('key1')).toBe(5)
    limiter.check('key1')
    expect(limiter.remaining('key1')).toBe(4)
    limiter.check('key1')
    expect(limiter.remaining('key1')).toBe(3)
  })

  it('reset() clears all counters', () => {
    const limiter = new SlidingWindowRateLimiter({ maxRequests: 1, windowMs: 60000 })
    limiter.check('key1')
    expect(limiter.check('key1')).toBe(false)
    limiter.reset()
    expect(limiter.check('key1')).toBe(true)
  })

  it('evictExpired() removes stale windows', () => {
    const limiter = new SlidingWindowRateLimiter({ maxRequests: 1, windowMs: 50 })
    limiter.check('key1')
    return new Promise<void>(resolve => {
      setTimeout(() => {
        limiter.evictExpired()
        expect(limiter.remaining('key1')).toBe(1)
        resolve()
      }, 100)
    })
  })

  it('uses defaults when no config provided', () => {
    const limiter = new SlidingWindowRateLimiter()
    // Default: 100 requests per 60s
    for (let i = 0; i < 100; i++) {
      expect(limiter.check('key')).toBe(true)
    }
    expect(limiter.check('key')).toBe(false)
  })
})
