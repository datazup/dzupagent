/**
 * Shared in-process rate-limit primitives.
 *
 * These classes intentionally avoid framework-specific concerns such as HTTP
 * headers, Redis clients, or domain-specific errors. Package-local limiters
 * wrap them to preserve their public APIs while sharing the bucket/window math.
 */

export interface FixedWindowRateLimiterConfig {
  /** Maximum allowed consumes per window. Defaults to 100. */
  maxRequests?: number
  /** Window duration in milliseconds. Defaults to 60 seconds. */
  windowMs?: number
  /** Injected clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number
}

interface FixedWindowEntry {
  count: number
  windowStart: number
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, FixedWindowEntry>()
  private readonly maxRequests: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(config: FixedWindowRateLimiterConfig = {}) {
    this.maxRequests = config.maxRequests ?? 100
    this.windowMs = config.windowMs ?? 60_000
    this.now = config.now ?? (() => Date.now())

    assertPositiveFinite('FixedWindowRateLimiter maxRequests', this.maxRequests)
    assertPositiveFinite('FixedWindowRateLimiter windowMs', this.windowMs)
  }

  check(key: string): boolean {
    const now = this.now()
    const entry = this.windows.get(key)

    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.windows.set(key, { count: 1, windowStart: now })
      return true
    }

    if (entry.count >= this.maxRequests) return false
    entry.count += 1
    return true
  }

  remaining(key: string): number {
    const now = this.now()
    const entry = this.windows.get(key)
    if (!entry || now - entry.windowStart >= this.windowMs) {
      return this.maxRequests
    }
    return Math.max(0, this.maxRequests - entry.count)
  }

  reset(key?: string): void {
    if (key === undefined) {
      this.windows.clear()
      return
    }
    this.windows.delete(key)
  }

  evictExpired(): void {
    const now = this.now()
    for (const [key, entry] of this.windows) {
      if (now - entry.windowStart >= this.windowMs) {
        this.windows.delete(key)
      }
    }
  }
}

export interface KeyedTokenBucketConfig {
  /** Maximum tokens per bucket. */
  capacity: number
  /** Tokens added per millisecond. */
  refillPerMs: number
  /** Injected clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number
}

export interface TokenBucketConsumeResult {
  allowed: boolean
  /** Whole tokens available after the consume attempt. */
  remaining: number
  /** Milliseconds until enough tokens should exist for one identical consume. */
  retryAfterMs: number
}

interface TokenBucketEntry {
  tokens: number
  lastRefillMs: number
}

export class KeyedTokenBucketRateLimiter {
  private readonly buckets = new Map<string, TokenBucketEntry>()
  private readonly capacity: number
  private readonly refillPerMs: number
  private readonly now: () => number

  constructor(config: KeyedTokenBucketConfig) {
    this.capacity = config.capacity
    this.refillPerMs = config.refillPerMs
    this.now = config.now ?? (() => Date.now())

    assertPositiveFinite('KeyedTokenBucketRateLimiter capacity', this.capacity)
    assertPositiveFinite('KeyedTokenBucketRateLimiter refillPerMs', this.refillPerMs)
  }

  consume(key: string, tokens: number = 1): TokenBucketConsumeResult {
    assertPositiveFinite('KeyedTokenBucketRateLimiter consume tokens', tokens)

    const now = this.now()
    const bucket = this.getBucket(key, now)
    this.refill(bucket, now)

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens
      return {
        allowed: true,
        remaining: wholeTokens(bucket.tokens),
        retryAfterMs: this.msUntil(tokens, bucket.tokens),
      }
    }

    return {
      allowed: false,
      remaining: wholeTokens(bucket.tokens),
      retryAfterMs: this.msUntil(tokens, bucket.tokens),
    }
  }

  inspect(key: string): { tokens: number; capacity: number } {
    return { tokens: wholeTokens(this.available(key)), capacity: this.capacity }
  }

  available(key: string): number {
    const bucket = this.buckets.get(key)
    if (!bucket) return this.capacity
    this.refill(bucket, this.now())
    return bucket.tokens
  }

  reset(key?: string): void {
    if (key === undefined) {
      this.buckets.clear()
      return
    }
    this.buckets.delete(key)
  }

  evictIdle(maxIdleMs: number): void {
    const cutoff = this.now() - maxIdleMs
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefillMs < cutoff) {
        this.buckets.delete(key)
      }
    }
  }

  private getBucket(key: string, now: number): TokenBucketEntry {
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefillMs: now }
      this.buckets.set(key, bucket)
    }
    return bucket
  }

  private refill(bucket: TokenBucketEntry, now: number): void {
    const elapsedMs = now - bucket.lastRefillMs
    if (elapsedMs <= 0) return
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedMs * this.refillPerMs)
    bucket.lastRefillMs = now
  }

  private msUntil(tokens: number, available: number): number {
    const deficit = Math.max(0, tokens - available)
    if (deficit === 0) return 0
    return Math.ceil(deficit / this.refillPerMs)
  }
}

function wholeTokens(tokens: number): number {
  return Math.max(0, Math.floor(tokens))
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be > 0`)
  }
}
