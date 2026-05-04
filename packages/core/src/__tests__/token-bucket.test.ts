import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TokenBucket } from '../rate-limit/token-bucket.js'
import { ForgeError } from '../errors/forge-error.js'

describe('TokenBucket', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts full at capacity', () => {
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1 })
    expect(bucket.available).toBe(5)
  })

  it('consume() returns true when tokens are available', () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 })
    expect(bucket.consume(1)).toBe(true)
    expect(bucket.consume(2)).toBe(true)
    expect(bucket.available).toBeLessThan(1)
  })

  it('consume() returns false when bucket is empty', () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1 })
    expect(bucket.consume(2)).toBe(true)
    expect(bucket.consume(1)).toBe(false)
  })

  it('refills tokens over time at refillPerSecond rate', () => {
    const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 5 })
    expect(bucket.consume(10)).toBe(true)
    expect(bucket.consume(1)).toBe(false)

    // After 1 second, 5 tokens should have refilled
    vi.advanceTimersByTime(1000)
    expect(bucket.consume(5)).toBe(true)
    expect(bucket.consume(1)).toBe(false)
  })

  it('caps refill at capacity', () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 100 })
    expect(bucket.consume(3)).toBe(true)
    // Wait long enough that refill would overflow
    vi.advanceTimersByTime(10_000)
    expect(bucket.available).toBeLessThanOrEqual(3)
  })

  it('waitUntilAvailable() resolves immediately when tokens are present', async () => {
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1 })
    await expect(bucket.waitUntilAvailable(1)).resolves.toBeUndefined()
    expect(bucket.available).toBeLessThan(5)
  })

  it('waitUntilAvailable() sleeps until refill provides enough tokens', async () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 2 })
    expect(bucket.consume(2)).toBe(true)

    const promise = bucket.waitUntilAvailable(1)
    // Advance time to allow refill (2 tokens/sec → 0.5 s for 1 token)
    await vi.advanceTimersByTimeAsync(600)
    await expect(promise).resolves.toBeUndefined()
  })

  it('waitUntilAvailable() throws RATE_LIMIT_EXCEEDED past maxWaitMs', async () => {
    const bucket = new TokenBucket({
      capacity: 1,
      refillPerSecond: 0.01,
      maxWaitMs: 100,
    })
    expect(bucket.consume(1)).toBe(true)

    const promise = bucket.waitUntilAvailable(1).catch((err) => err)
    await vi.advanceTimersByTimeAsync(200)
    const result = await promise
    expect(result).toBeInstanceOf(ForgeError)
    expect((result as ForgeError).code).toBe('RATE_LIMIT_EXCEEDED')
    expect((result as ForgeError).recoverable).toBe(true)
  })

  it('waitUntilAvailable() rejects requests larger than capacity', async () => {
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1 })
    await expect(bucket.waitUntilAvailable(6)).rejects.toMatchObject({
      code: 'RATE_LIMIT_EXCEEDED',
    })
  })

  it('rejects invalid configuration', () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow(ForgeError)
    expect(() => new TokenBucket({ capacity: 5, refillPerSecond: 0 })).toThrow(ForgeError)
    expect(() => new TokenBucket({ capacity: -1, refillPerSecond: 1 })).toThrow(ForgeError)
  })

  it('rejects invalid consume() arguments', () => {
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1 })
    expect(() => bucket.consume(0)).toThrow(ForgeError)
    expect(() => bucket.consume(-1)).toThrow(ForgeError)
  })

  it('does not busy-wait when sleeping', async () => {
    // Sanity: setTimeout is the only scheduling primitive used.
    // Run a real-timer microbenchmark to ensure waitUntilAvailable
    // actually awaits a setTimeout (not a tight loop).
    vi.useRealTimers()
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 50 })
    expect(bucket.consume(1)).toBe(true)
    const start = Date.now()
    await bucket.waitUntilAvailable(1)
    const elapsed = Date.now() - start
    // 1 token at 50/sec = 20 ms; allow generous slack for CI jitter.
    expect(elapsed).toBeGreaterThanOrEqual(15)
    expect(elapsed).toBeLessThan(500)
  })
})
