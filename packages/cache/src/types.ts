/**
 * Backend storage interface for cache implementations.
 * Both in-memory and Redis backends implement this contract.
 *
 * Sorted-set methods (zadd/zrangebyscore/zrem/zcard) generalize the cache
 * for callers that need lightweight ordered indexes (e.g. provenance trackers,
 * recency queues). Implementations MUST be safe to call concurrently on
 * distinct keys; concurrency on the same key is the caller's responsibility.
 */
export interface CacheBackend {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds?: number): Promise<void>
  delete(key: string): Promise<void>
  clear(): Promise<void>
  stats(): Promise<CacheStats>
  /**
   * Add `member` to the sorted set at `key` with the given numeric `score`.
   * If `member` already exists, its score is updated.
   */
  zadd(key: string, score: number, member: string): Promise<void>
  /**
   * Return members with scores in [min, max] in ascending score order.
   */
  zrangebyscore(key: string, min: number, max: number): Promise<string[]>
  /**
   * Remove `member` from the sorted set at `key`. No-op if missing.
   */
  zrem(key: string, member: string): Promise<void>
  /**
   * Return the number of members in the sorted set at `key` (0 if missing).
   */
  zcard(key: string): Promise<number>
}

/**
 * Policy controlling what gets cached and for how long.
 */
export interface CachePolicy {
  /** Max temperature for cacheability (default 0.3) */
  maxTemperature: number
  /** Default TTL in seconds (default 3600) */
  defaultTtlSeconds: number
  /** Namespace prefix for tenant isolation */
  namespace?: string
  /** Custom cacheability check — overrides default temperature check when provided */
  isCacheable?: (request: CacheableRequest) => boolean
}

/**
 * Shape of an LLM request that can be cache-keyed.
 */
export interface CacheableRequest {
  messages: Array<{ role: string; content: string }>
  model: string
  temperature?: number
  maxTokens?: number
  [key: string]: unknown
}

/**
 * Cache performance statistics.
 */
export interface CacheStats {
  hits: number
  misses: number
  size: number
  hitRate: number
}

/**
 * Configuration for CacheMiddleware.
 */
export interface CacheMiddlewareConfig {
  backend: CacheBackend
  policy: CachePolicy
  /** Optional callback fired on cache hits */
  onHit?: (key: string, model: string) => void
  /** Optional callback fired on cache misses */
  onMiss?: (key: string, model: string) => void
  /**
   * Optional callback fired on degraded cache operations (non-fatal failures).
   * When provided, the middleware emits structured diagnostics instead of
   * silently swallowing errors.
   */
  onDegraded?: (operation: 'get' | 'set' | 'delete' | 'clear', reason: string, key?: string) => void
}

/**
 * Serialized cache entry stored in the backend.
 */
export interface CacheEntry {
  response: string
  model: string
  cachedAt: number
  ttl: number
}
