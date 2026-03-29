import type {
  CacheableRequest,
  CacheEntry,
  CacheMiddlewareConfig,
  CacheStats,
} from './types.js'
import { generateCacheKey } from './key-generator.js'

/**
 * Cache middleware for LLM response caching.
 *
 * Wraps a CacheBackend with policy enforcement (temperature gating,
 * TTL defaults, namespace isolation) and optional hit/miss callbacks
 * for integration with DzipEventBus or observability systems.
 *
 * @example
 * ```ts
 * const cache = new CacheMiddleware({
 *   backend: new InMemoryCacheBackend(),
 *   policy: { maxTemperature: 0.3, defaultTtlSeconds: 3600 },
 *   onHit: (key, model) => bus.emit({ type: 'cache:hit', key, model }),
 * })
 *
 * const cached = await cache.get(request)
 * if (!cached) {
 *   const response = await llm.invoke(request)
 *   await cache.set(request, response)
 * }
 * ```
 */
export class CacheMiddleware {
  private config: CacheMiddlewareConfig

  constructor(config: CacheMiddlewareConfig) {
    this.config = config
  }

  /**
   * Check if a request is cacheable based on the configured policy.
   *
   * Uses the custom `isCacheable` function if provided, otherwise
   * falls back to temperature-based gating (only cache responses for
   * near-deterministic requests where temperature <= maxTemperature).
   */
  isCacheable(request: CacheableRequest): boolean {
    const { policy } = this.config

    if (policy.isCacheable) {
      return policy.isCacheable(request)
    }

    const temperature = request.temperature ?? 1
    return temperature <= policy.maxTemperature
  }

  /**
   * Try to retrieve a cached response for the given request.
   * Returns null if the request is not cacheable or not in cache.
   */
  async get(request: CacheableRequest): Promise<string | null> {
    if (!this.isCacheable(request)) {
      return null
    }

    const key = generateCacheKey(request, this.config.policy.namespace)

    try {
      const raw = await this.config.backend.get(key)

      if (raw === null) {
        this.config.onMiss?.(key, request.model)
        return null
      }

      const entry = JSON.parse(raw) as CacheEntry
      this.config.onHit?.(key, request.model)
      return entry.response
    } catch {
      this.config.onMiss?.(key, request.model)
      return null
    }
  }

  /**
   * Store an LLM response in the cache.
   * Only stores if the request passes the cacheability check.
   */
  async set(request: CacheableRequest, response: string): Promise<void> {
    if (!this.isCacheable(request)) {
      return
    }

    const key = generateCacheKey(request, this.config.policy.namespace)
    const ttl = this.config.policy.defaultTtlSeconds

    const entry: CacheEntry = {
      response,
      model: request.model,
      cachedAt: Date.now(),
      ttl,
    }

    try {
      await this.config.backend.set(key, JSON.stringify(entry), ttl)
    } catch {
      // Best-effort — silently ignore cache write failures
    }
  }

  /**
   * Get cache performance statistics from the underlying backend.
   */
  async stats(): Promise<CacheStats> {
    return this.config.backend.stats()
  }
}
