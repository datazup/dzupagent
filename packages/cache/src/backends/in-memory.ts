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
  /**
   * Sorted-set storage: outer key → inner Map<member, score>. Order is not
   * tracked structurally; queries sort on read. Adequate for tests / dev.
   */
  private sortedSets = new Map<string, Map<string, number>>()
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
    this.sortedSets.clear()
    this.stats_ = { hits: 0, misses: 0 }
  }

  // --- sorted-set operations -------------------------------------------------

  async zadd(key: string, score: number, member: string): Promise<void> {
    const set = this.sortedSets.get(key) ?? new Map<string, number>()
    set.set(member, score)
    this.sortedSets.set(key, set)
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    const set = this.sortedSets.get(key)
    if (!set) return []
    return [...set.entries()]
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member)
  }

  async zrem(key: string, member: string): Promise<void> {
    const set = this.sortedSets.get(key)
    if (!set) return
    set.delete(member)
    if (set.size === 0) {
      this.sortedSets.delete(key)
    }
  }

  async zcard(key: string): Promise<number> {
    return this.sortedSets.get(key)?.size ?? 0
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
