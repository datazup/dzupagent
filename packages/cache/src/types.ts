/**
 * Backend storage interface for cache implementations.
 * Both in-memory and Redis backends implement this contract.
 */
export interface CacheBackend {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds?: number): Promise<void>
  delete(key: string): Promise<void>
  clear(): Promise<void>
  stats(): Promise<CacheStats>
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
