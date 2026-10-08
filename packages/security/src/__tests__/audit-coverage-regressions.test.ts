import { expect, test } from 'vitest'
import { FixedWindowRateLimiter, KeyedTokenBucketRateLimiter } from '../rate-limit/local.js'

test('rate-limit cleanup preserves live tenants and releases expired or explicitly reset tenants', () => {
  let now = 0
  const window = new FixedWindowRateLimiter({ maxRequests: 2, windowMs: 10, now: () => now })
  expect(window.check('old')).toBe(true)
  now = 5
  window.check('live')
  now = 10
  window.evictExpired()
  expect(window.remaining('old')).toBe(2)
  expect(window.remaining('live')).toBe(1)
  window.reset('live')
  expect(window.remaining('live')).toBe(2)
  window.check('live'); window.reset()
  expect(window.remaining('live')).toBe(2)

  const bucket = new KeyedTokenBucketRateLimiter({ capacity: 2, refillPerMs: 0.1, now: () => now })
  expect(bucket.inspect('empty')).toEqual({ tokens: 2, capacity: 2 })
  expect(bucket.consume('old', 2).allowed).toBe(true)
  now += 5
  bucket.consume('live')
  bucket.evictIdle(1)
  expect(bucket.available('old')).toBe(2)
  expect(bucket.inspect('live').tokens).toBe(1)
  now += 5
  expect(bucket.available('live')).toBe(1.5)
  bucket.reset('live')
  expect(bucket.available('live')).toBe(2)
  bucket.consume('live'); bucket.reset()
  expect(bucket.available('live')).toBe(2)
})

test.each([0, -1, NaN, Infinity])('invalid limiter capacity %s fails before admission', capacity => {
  expect(() => new FixedWindowRateLimiter({ maxRequests: capacity })).toThrow(/must be/)
  expect(() => new KeyedTokenBucketRateLimiter({ capacity, refillPerMs: 1 })).toThrow(/must be/)
})
