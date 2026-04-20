/**
 * Unit tests for {@link MailRateLimiter}.
 *
 * Uses an injected clock so refill behaviour is deterministic and we do not
 * depend on `Date.now()` or `vi.useFakeTimers()`.
 */
import { describe, it, expect } from 'vitest'
import {
  MailRateLimiter,
  MailRateLimitError,
} from '../mail-rate-limiter.js'

describe('MailRateLimiter', () => {
  it('allows up to `capacity` consecutive consumes', () => {
    const limiter = new MailRateLimiter({
      capacity: 10,
      refillPerMinute: 10,
      now: () => 0,
    })
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryConsume('recipient')).toBe(true)
    }
    expect(limiter.tryConsume('recipient')).toBe(false)
  })

  it('isolates buckets per recipient', () => {
    const limiter = new MailRateLimiter({
      capacity: 2,
      refillPerMinute: 1,
      now: () => 0,
    })
    expect(limiter.tryConsume('a')).toBe(true)
    expect(limiter.tryConsume('a')).toBe(true)
    expect(limiter.tryConsume('a')).toBe(false)
    expect(limiter.tryConsume('b')).toBe(true)
    expect(limiter.tryConsume('b')).toBe(true)
    expect(limiter.tryConsume('b')).toBe(false)
  })

  it('refills tokens over time up to capacity', () => {
    let clock = 0
    const limiter = new MailRateLimiter({
      capacity: 10,
      refillPerMinute: 60, // 1 token per second
      now: () => clock,
    })
    // Drain entirely.
    for (let i = 0; i < 10; i++) expect(limiter.tryConsume('r')).toBe(true)
    expect(limiter.tryConsume('r')).toBe(false)

    // Wait 5 seconds: 5 tokens accrue.
    clock = 5_000
    for (let i = 0; i < 5; i++) expect(limiter.tryConsume('r')).toBe(true)
    expect(limiter.tryConsume('r')).toBe(false)
  })

  it('caps tokens at capacity regardless of elapsed time', () => {
    let clock = 0
    const limiter = new MailRateLimiter({
      capacity: 3,
      refillPerMinute: 60,
      now: () => clock,
    })
    // Pretend an hour passed with the bucket full.
    clock = 60 * 60 * 1000
    for (let i = 0; i < 3; i++) expect(limiter.tryConsume('r')).toBe(true)
    expect(limiter.tryConsume('r')).toBe(false)
  })

  it('consumeOrThrow throws MailRateLimitError when empty', () => {
    const limiter = new MailRateLimiter({
      capacity: 1,
      refillPerMinute: 1,
      now: () => 0,
    })
    limiter.consumeOrThrow('r')
    expect(() => limiter.consumeOrThrow('r')).toThrow(MailRateLimitError)
  })

  it('exposes retryAfterMs on the thrown error', () => {
    const limiter = new MailRateLimiter({
      capacity: 1,
      refillPerMinute: 10, // one token per 6s
      now: () => 0,
    })
    limiter.consumeOrThrow('r')
    try {
      limiter.consumeOrThrow('r')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(MailRateLimitError)
      const err = e as MailRateLimitError
      expect(err.retryAfterMs).toBe(6_000)
      expect(err.recipientId).toBe('r')
    }
  })

  it('rejects non-positive capacity', () => {
    expect(() => new MailRateLimiter({ capacity: 0 })).toThrow()
    expect(() => new MailRateLimiter({ capacity: -1 })).toThrow()
  })

  it('rejects non-positive refill rate', () => {
    expect(() => new MailRateLimiter({ refillPerMinute: 0 })).toThrow()
  })

  it('inspect() reports capacity for unseen recipients', () => {
    const limiter = new MailRateLimiter({ capacity: 7, refillPerMinute: 1 })
    expect(limiter.inspect('new').tokens).toBe(7)
    expect(limiter.inspect('new').capacity).toBe(7)
  })

  it('reset() clears all buckets', () => {
    const limiter = new MailRateLimiter({
      capacity: 1,
      refillPerMinute: 1,
      now: () => 0,
    })
    limiter.tryConsume('r')
    expect(limiter.tryConsume('r')).toBe(false)
    limiter.reset()
    expect(limiter.tryConsume('r')).toBe(true)
  })
})
