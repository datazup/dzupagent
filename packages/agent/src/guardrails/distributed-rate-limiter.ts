/**
 * Distributed rate limiter (MC-07).
 *
 * Backs a per-tenant / per-agent rate limit on a shared store (typically
 * Redis) so a fleet of agent processes share one fixed-window budget
 * instead of multiplying the limit by the number of replicas.
 *
 * Design notes:
 *
 *  - The store interface is intentionally minimal so callers can inject
 *    `ioredis`, `node-redis`, or a test mock without dragging a Redis
 *    client into this package's dependencies.
 *  - No Lua scripts. The implementation uses `INCR` + `EXPIRE`, which
 *    races slightly on the very first request after a TTL boundary but
 *    is sufficient for client-side throttling and simple to reason
 *    about. A small over-shoot is acceptable; a hard ceiling is not the
 *    goal of this layer.
 *  - Graceful degradation is mandatory: when the store throws, we fall
 *    back to an in-process limiter when one is supplied, otherwise we
 *    fail open (allow the request). Failing closed on a transient
 *    Redis error would create a much worse outage than a brief
 *    over-spend.
 */

import type { TokenBucket } from '@dzupagent/core'

/**
 * Minimal Redis-shaped client used by {@link DistributedRateLimiter}.
 *
 * Structurally compatible with `ioredis` and `node-redis` v4. Tests inject
 * an in-memory mock implementing the same shape.
 */
export interface RateLimiterClient {
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<number>
  get(key: string): Promise<string | null>
  del(key: string): Promise<number>
}

/** Local fallback rate limiter shape (subset of `TokenBucket`). */
export interface LocalRateLimiter {
  /**
   * Attempt to consume a token without blocking. Returning `false`
   * indicates the local limiter is also exhausted.
   */
  consume(tokens?: number): boolean
}

export interface DistributedRateLimiterConfig {
  /** Redis-shaped client. */
  client: RateLimiterClient
  /** Key prefix. Defaults to `'dzupagent:rl'`. */
  keyPrefix?: string
  /** Window length in milliseconds. Defaults to 60_000 (1 minute). */
  windowMs?: number
  /** Max requests per window. Defaults to 60. */
  maxRequests?: number
  /**
   * When the Redis client throws, fall back to the local limiter (if
   * supplied) or fail open. Defaults to `true`.
   */
  fallbackToLocal?: boolean
}

const DEFAULT_KEY_PREFIX = 'dzupagent:rl'
const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_MAX_REQUESTS = 60

/**
 * Fixed-window distributed rate limiter.
 *
 * `tryConsume()` returns `false` when the window's request count has
 * exceeded the configured ceiling. On Redis errors the limiter falls
 * back to the local limiter (if supplied) or to fail-open behaviour.
 */
export class DistributedRateLimiter {
  private readonly client: RateLimiterClient
  private readonly keyPrefix: string
  private readonly windowMs: number
  private readonly maxRequests: number
  private readonly fallbackToLocal: boolean
  private readonly localFallback: LocalRateLimiter | undefined

  constructor(
    config: DistributedRateLimiterConfig,
    localFallback?: LocalRateLimiter | TokenBucket,
  ) {
    this.client = config.client
    this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX
    this.windowMs = config.windowMs ?? DEFAULT_WINDOW_MS
    this.maxRequests = config.maxRequests ?? DEFAULT_MAX_REQUESTS
    this.fallbackToLocal = config.fallbackToLocal ?? true
    this.localFallback = localFallback as LocalRateLimiter | undefined
  }

  /**
   * Try to consume one slot in the current window.
   *
   * @returns `true` when the request is allowed, `false` when the
   *          window's quota is exhausted. Errors fall back per
   *          `fallbackToLocal`.
   */
  async tryConsume(tenantId: string, agentId: string): Promise<boolean> {
    const key = this.buildKey(tenantId, agentId)
    const ttlSeconds = Math.max(1, Math.ceil(this.windowMs / 1000))

    try {
      const count = await this.client.incr(key)
      if (count === 1) {
        // First increment in the window — set TTL. Errors here are
        // logged as a fall-through; the counter still ticks even if
        // the TTL set fails (the next window will simply be longer).
        try {
          await this.client.expire(key, ttlSeconds)
        } catch {
          // best-effort
        }
      }
      return count <= this.maxRequests
    } catch {
      return this.handleClientFailure()
    }
  }

  /** Reset the window for the given (tenant, agent). */
  async reset(tenantId: string, agentId: string): Promise<void> {
    const key = this.buildKey(tenantId, agentId)
    try {
      await this.client.del(key)
    } catch {
      // Reset is best-effort — if Redis is unavailable the window will
      // expire on its own.
    }
  }

  private buildKey(tenantId: string, agentId: string): string {
    return `${this.keyPrefix}:${tenantId}:${agentId}`
  }

  private handleClientFailure(): boolean {
    if (this.fallbackToLocal && this.localFallback) {
      try {
        return this.localFallback.consume(1)
      } catch {
        return true
      }
    }
    // Fail open by default — see file header.
    return true
  }
}
