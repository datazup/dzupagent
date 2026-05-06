import { describe, expect, it } from 'vitest'
import {
  FixedWindowRateLimiter,
  KeyedTokenBucketRateLimiter,
} from '../rate-limit/index.js'

describe('FixedWindowRateLimiter', () => {
  it('limits independently per key and reports remaining capacity', () => {
    const limiter = new FixedWindowRateLimiter({ maxRequests: 2, windowMs: 60_000, now: () => 0 })

    expect(limiter.check('a')).toBe(true)
    expect(limiter.remaining('a')).toBe(1)
    expect(limiter.check('a')).toBe(true)
    expect(limiter.check('a')).toBe(false)
    expect(limiter.check('b')).toBe(true)
  })

  it('resets after the configured window elapses', () => {
    let clock = 0
    const limiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 100, now: () => clock })

    expect(limiter.check('key')).toBe(true)
    expect(limiter.check('key')).toBe(false)
    clock = 100
    expect(limiter.check('key')).toBe(true)
  })
})

describe('KeyedTokenBucketRateLimiter', () => {
  it('consumes capacity and refills by elapsed time', () => {
    let clock = 0
    const limiter = new KeyedTokenBucketRateLimiter({
      capacity: 3,
      refillPerMs: 1 / 1000,
      now: () => clock,
    })

    expect(limiter.consume('recipient').allowed).toBe(true)
    expect(limiter.consume('recipient').allowed).toBe(true)
    expect(limiter.consume('recipient').allowed).toBe(true)
    expect(limiter.consume('recipient')).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 1000,
    })

    clock = 2_000
    expect(limiter.consume('recipient')).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
    })
  })

  it('resets all buckets', () => {
    const limiter = new KeyedTokenBucketRateLimiter({ capacity: 1, refillPerMs: 1, now: () => 0 })

    expect(limiter.consume('key').allowed).toBe(true)
    expect(limiter.consume('key').allowed).toBe(false)
    limiter.reset()
    expect(limiter.consume('key').allowed).toBe(true)
  })
})
