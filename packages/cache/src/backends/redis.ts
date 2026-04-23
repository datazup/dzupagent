import type { CacheBackend, CacheStats } from '../types.js'

/**
 * Minimal ioredis-compatible client interface.
 * Avoids importing ioredis directly since it is an optional peer dependency.
 */
interface RedisClientLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ex: 'EX', seconds: number): Promise<unknown>
  set(key: string, value: string): Promise<unknown>
  del(...keys: string[]): Promise<number>
  scan(cursor: string | number, ...args: unknown[]): Promise<[string, string[]]>
  zadd(key: string, score: number, member: string): Promise<unknown>
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>
  zrem(key: string, ...members: string[]): Promise<number>
  zcard(key: string): Promise<number>
}

/**
 * Redis-backed cache backend using ioredis.
 *
 * Uses key prefixing for namespace isolation and SCAN + DEL for safe
 * bulk deletion (no KEYS command in production).
 */
export class RedisCacheBackend implements CacheBackend {
  private client: RedisClientLike
  private prefix: string
  private stats_: { hits: number; misses: number }
  private onDegraded?: ((operation: 'get' | 'set' | 'delete' | 'clear', reason: string, key?: string) => void) | undefined

  constructor(client: unknown, options?: { prefix?: string; onDegraded?: (operation: 'get' | 'set' | 'delete' | 'clear', reason: string, key?: string) => void }) {
    this.client = client as RedisClientLike
    this.prefix = options?.prefix ?? ''
    this.stats_ = { hits: 0, misses: 0 }
    this.onDegraded = options?.onDegraded
  }

  private prefixedKey(key: string): string {
    return this.prefix ? `${this.prefix}:${key}` : key
  }

  async get(key: string): Promise<string | null> {
    try {
      const value = await this.client.get(this.prefixedKey(key))
      if (value === null) {
        this.stats_.misses++
        return null
      }
      this.stats_.hits++
      return value
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.onDegraded?.('get', reason, key)
      this.stats_.misses++
      return null
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      const prefixed = this.prefixedKey(key)
      if (ttlSeconds && ttlSeconds > 0) {
        await this.client.set(prefixed, value, 'EX', ttlSeconds)
      } else {
        await this.client.set(prefixed, value)
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.onDegraded?.('set', reason, key)
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.del(this.prefixedKey(key))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.onDegraded?.('delete', reason, key)
    }
  }

  async clear(): Promise<void> {
    try {
      const pattern = this.prefix ? `${this.prefix}:*` : '*'
      let cursor = '0'

      do {
        const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
        cursor = nextCursor
        if (keys.length > 0) {
          await this.client.del(...keys)
        }
      } while (cursor !== '0')

      this.stats_ = { hits: 0, misses: 0 }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.onDegraded?.('clear', reason)
    }
  }

  async stats(): Promise<CacheStats> {
    const total = this.stats_.hits + this.stats_.misses
    return {
      hits: this.stats_.hits,
      misses: this.stats_.misses,
      size: -1, // Redis size requires DBSIZE or key counting; return -1 to indicate unknown
      hitRate: total > 0 ? this.stats_.hits / total : 0,
    }
  }

  // --- sorted-set operations -------------------------------------------------
  // Unlike get/set/delete/clear (which degrade silently to keep the cache
  // path non-blocking), sorted-set ops surface errors so callers using the
  // backend for indexing/provenance can decide how to handle failures.

  async zadd(key: string, score: number, member: string): Promise<void> {
    await this.client.zadd(this.prefixedKey(key), score, member)
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    return await this.client.zrangebyscore(this.prefixedKey(key), min, max)
  }

  async zrem(key: string, member: string): Promise<void> {
    await this.client.zrem(this.prefixedKey(key), member)
  }

  async zcard(key: string): Promise<number> {
    return await this.client.zcard(this.prefixedKey(key))
  }
}
