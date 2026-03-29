import type { CacheBackend, CacheStats } from '../types.js'

interface CacheItem {
  value: string
  expiresAt: number
}

/**
 * In-memory cache backend with LRU eviction and TTL expiry.
 *
 * Suitable for development, testing, and single-process deployments.
 * For multi-process or distributed setups, use RedisCacheBackend.
 */
export class InMemoryCacheBackend implements CacheBackend {
  private cache = new Map<string, CacheItem>()
  private maxEntries: number
  private stats_: { hits: number; misses: number }

  constructor(options?: { maxEntries?: number }) {
    this.maxEntries = options?.maxEntries ?? 1000
    this.stats_ = { hits: 0, misses: 0 }
  }

  async get(key: string): Promise<string | null> {
    const item = this.cache.get(key)
    if (!item) {
      this.stats_.misses++
      return null
    }

    // Check TTL expiry
    if (item.expiresAt > 0 && Date.now() > item.expiresAt) {
      this.cache.delete(key)
      this.stats_.misses++
      return null
    }

    // Move to end for LRU ordering (Map preserves insertion order)
    this.cache.delete(key)
    this.cache.set(key, item)

    this.stats_.hits++
    return item.value
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    // If key already exists, delete first to refresh LRU position
    if (this.cache.has(key)) {
      this.cache.delete(key)
    }

    // LRU eviction: remove oldest entry (first in Map) if at capacity
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey)
      }
    }

    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0
    this.cache.set(key, { value, expiresAt })
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key)
  }

  async clear(): Promise<void> {
    this.cache.clear()
    this.stats_ = { hits: 0, misses: 0 }
  }

  async stats(): Promise<CacheStats> {
    // Purge expired entries before reporting size
    const now = Date.now()
    for (const [key, item] of this.cache) {
      if (item.expiresAt > 0 && now > item.expiresAt) {
        this.cache.delete(key)
      }
    }

    const total = this.stats_.hits + this.stats_.misses
    return {
      hits: this.stats_.hits,
      misses: this.stats_.misses,
      size: this.cache.size,
      hitRate: total > 0 ? this.stats_.hits / total : 0,
    }
  }
}
