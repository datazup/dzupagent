import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RedisCacheBackend } from '../backends/redis.js'

/**
 * Mock Redis client with controllable behavior.
 */
function createMockRedisClient() {
  const store = new Map<string, { value: string; ttl?: number }>()

  return {
    store,
    get: vi.fn(async (key: string): Promise<string | null> => {
      const item = store.get(key)
      return item ? item.value : null
    }),
    set: vi.fn(async (key: string, value: string, ex?: string, seconds?: number): Promise<'OK'> => {
      store.set(key, { value, ttl: ex === 'EX' ? seconds : undefined })
      return 'OK'
    }),
    del: vi.fn(async (...keys: string[]): Promise<number> => {
      let count = 0
      for (const k of keys) {
        if (store.delete(k)) count++
      }
      return count
    }),
    scan: vi.fn(async (_cursor: string | number, ..._args: unknown[]): Promise<[string, string[]]> => {
      const keys = [...store.keys()]
      return ['0', keys]
    }),
  }
}

type MockRedisClient = ReturnType<typeof createMockRedisClient>

describe('RedisCacheBackend — deep coverage', () => {
  let client: MockRedisClient
  let backend: RedisCacheBackend

  beforeEach(() => {
    client = createMockRedisClient()
    backend = new RedisCacheBackend(client)
  })

  // --- onDegraded callback coverage ---
  // These target uncovered lines 48-49, 64-65, 73-74, 93-94 in redis.ts

  describe('onDegraded callback', () => {
    it('calls onDegraded with operation, reason, and key on get error', async () => {
      const onDegraded = vi.fn()
      const b = new RedisCacheBackend(client, { onDegraded })
      client.get.mockRejectedValueOnce(new Error('timeout'))

      await b.get('my-key')

      expect(onDegraded).toHaveBeenCalledTimes(1)
      expect(onDegraded).toHaveBeenCalledWith('get', 'timeout', 'my-key')
    })

    it('calls onDegraded with operation, reason, and key on set error', async () => {
      const onDegraded = vi.fn()
      const b = new RedisCacheBackend(client, { onDegraded })
      client.set.mockRejectedValueOnce(new Error('write failed'))

      await b.set('my-key', 'val')

      expect(onDegraded).toHaveBeenCalledTimes(1)
      expect(onDegraded).toHaveBeenCalledWith('set', 'write failed', 'my-key')
    })

    it('calls onDegraded with operation, reason, and key on delete error', async () => {
      const onDegraded = vi.fn()
      const b = new RedisCacheBackend(client, { onDegraded })
      client.del.mockRejectedValueOnce(new Error('del failed'))

      await b.delete('my-key')

      expect(onDegraded).toHaveBeenCalledTimes(1)
      expect(onDegraded).toHaveBeenCalledWith('delete', 'del failed', 'my-key')
    })

    it('calls onDegraded on clear error without key', async () => {
      const onDegraded = vi.fn()
      const b = new RedisCacheBackend(client, { onDegraded })
      client.scan.mockRejectedValueOnce(new Error('scan failed'))

      await b.clear()

      expect(onDegraded).toHaveBeenCalledTimes(1)
      expect(onDegraded).toHaveBeenCalledWith('clear', 'scan failed')
    })

    it('handles non-Error thrown values by converting to string', async () => {
      const onDegraded = vi.fn()
      const b = new RedisCacheBackend(client, { onDegraded })
      client.get.mockRejectedValueOnce('raw string error')

      await b.get('k')

      expect(onDegraded).toHaveBeenCalledWith('get', 'raw string error', 'k')
    })

    it('handles non-Error thrown values in set', async () => {
      const onDegraded = vi.fn()
      const b = new RedisCacheBackend(client, { onDegraded })
      client.set.mockRejectedValueOnce(42)

      await b.set('k', 'v')

      expect(onDegraded).toHaveBeenCalledWith('set', '42', 'k')
    })

    it('handles non-Error thrown values in delete', async () => {
      const onDegraded = vi.fn()
      const b = new RedisCacheBackend(client, { onDegraded })
      client.del.mockRejectedValueOnce({ code: 'ERR' })

      await b.delete('k')

      expect(onDegraded).toHaveBeenCalledWith('delete', '[object Object]', 'k')
    })

    it('handles non-Error thrown values in clear', async () => {
      const onDegraded = vi.fn()
      const b = new RedisCacheBackend(client, { onDegraded })
      client.scan.mockRejectedValueOnce(null)

      await b.clear()

      expect(onDegraded).toHaveBeenCalledWith('clear', 'null')
    })
  })

  // --- Prefix edge cases ---

  describe('prefix edge cases', () => {
    it('empty prefix string behaves like no prefix', async () => {
      const b = new RedisCacheBackend(client, { prefix: '' })
      await b.set('k1', 'v1')
      expect(client.set).toHaveBeenCalledWith('k1', 'v1')
    })

    it('prefix with special characters works correctly', async () => {
      const b = new RedisCacheBackend(client, { prefix: 'app:v2:prod' })
      await b.set('key', 'val')
      expect(client.set).toHaveBeenCalledWith('app:v2:prod:key', 'val')
    })

    it('clear uses prefixed pattern for SCAN', async () => {
      const b = new RedisCacheBackend(client, { prefix: 'myns' })
      await b.clear()
      expect(client.scan).toHaveBeenCalledWith('0', 'MATCH', 'myns:*', 'COUNT', 100)
    })

    it('clear uses wildcard pattern when no prefix', async () => {
      await backend.clear()
      expect(client.scan).toHaveBeenCalledWith('0', 'MATCH', '*', 'COUNT', 100)
    })
  })

  // --- Clear with multiple scan pages ---

  describe('clear with paginated SCAN', () => {
    it('continues scanning until cursor returns 0', async () => {
      client.store.set('a', { value: '1' })
      client.store.set('b', { value: '2' })
      client.store.set('c', { value: '3' })

      // Simulate paginated scan: first returns cursor "5" with 2 keys, second returns "0" with 1 key
      client.scan
        .mockResolvedValueOnce(['5', ['a', 'b']])
        .mockResolvedValueOnce(['0', ['c']])

      await backend.clear()

      expect(client.scan).toHaveBeenCalledTimes(2)
      expect(client.del).toHaveBeenCalledTimes(2)
      expect(client.del).toHaveBeenCalledWith('a', 'b')
      expect(client.del).toHaveBeenCalledWith('c')
    })

    it('does not call del when scan returns empty keys array', async () => {
      // Scan returns no keys (empty database)
      client.scan.mockResolvedValueOnce(['0', []])

      await backend.clear()

      expect(client.scan).toHaveBeenCalledTimes(1)
      expect(client.del).not.toHaveBeenCalled()
    })
  })

  // --- TTL handling in set ---

  describe('TTL handling in set', () => {
    it('negative ttlSeconds is treated as no TTL (falsy check fails for negative)', async () => {
      // The condition is `ttlSeconds && ttlSeconds > 0`
      // Negative values: ttlSeconds is truthy but > 0 is false, so no EX
      await backend.set('k', 'v', -5)
      expect(client.set).toHaveBeenCalledWith('k', 'v')
    })

    it('undefined ttlSeconds calls set without EX', async () => {
      await backend.set('k', 'v', undefined)
      expect(client.set).toHaveBeenCalledWith('k', 'v')
    })

    it('very large TTL is passed through to Redis', async () => {
      await backend.set('k', 'v', 999999)
      expect(client.set).toHaveBeenCalledWith('k', 'v', 'EX', 999999)
    })
  })

  // --- Stats edge cases ---

  describe('stats edge cases', () => {
    it('stats accumulate correctly across many operations', async () => {
      for (let i = 0; i < 10; i++) {
        await backend.set(`k${i}`, `v${i}`)
      }
      // 10 hits
      for (let i = 0; i < 10; i++) {
        await backend.get(`k${i}`)
      }
      // 5 misses
      for (let i = 10; i < 15; i++) {
        await backend.get(`k${i}`)
      }

      const stats = await backend.stats()
      expect(stats.hits).toBe(10)
      expect(stats.misses).toBe(5)
      expect(stats.hitRate).toBeCloseTo(10 / 15)
      expect(stats.size).toBe(-1) // Redis always reports -1
    })

    it('error on get counts as a miss in stats', async () => {
      client.get.mockRejectedValueOnce(new Error('fail'))
      await backend.get('k')

      const stats = await backend.stats()
      expect(stats.misses).toBe(1)
      expect(stats.hits).toBe(0)
    })

    it('clear resets stats even after many operations', async () => {
      await backend.set('k', 'v')
      await backend.get('k')
      await backend.get('k')
      await backend.get('miss')

      await backend.clear()
      const stats = await backend.stats()
      expect(stats.hits).toBe(0)
      expect(stats.misses).toBe(0)
      expect(stats.hitRate).toBe(0)
    })
  })

  // --- Constructor options ---

  describe('constructor options', () => {
    it('works with no options', () => {
      const b = new RedisCacheBackend(client)
      expect(b).toBeDefined()
    })

    it('works with empty options object', () => {
      const b = new RedisCacheBackend(client, {})
      expect(b).toBeDefined()
    })

    it('accepts prefix without onDegraded', () => {
      const b = new RedisCacheBackend(client, { prefix: 'test' })
      expect(b).toBeDefined()
    })

    it('accepts onDegraded without prefix', () => {
      const b = new RedisCacheBackend(client, { onDegraded: vi.fn() })
      expect(b).toBeDefined()
    })
  })
})
