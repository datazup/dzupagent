import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RedisCacheBackend } from '../backends/redis.js'

/**
 * Mock Redis client that behaves like a minimal ioredis instance.
 * Stores data in a plain Map so no real Redis connection is needed.
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
      // Return all keys matching any pattern in a single scan pass
      const keys = [...store.keys()]
      return ['0', keys]
    }),
  }
}

type MockRedisClient = ReturnType<typeof createMockRedisClient>

describe('RedisCacheBackend', () => {
  let client: MockRedisClient
  let backend: RedisCacheBackend

  beforeEach(() => {
    client = createMockRedisClient()
    backend = new RedisCacheBackend(client)
  })

  // --- basic operations ---

  it('returns null for a missing key', async () => {
    const result = await backend.get('missing')
    expect(result).toBeNull()
    expect(client.get).toHaveBeenCalledWith('missing')
  })

  it('stores and retrieves a value without TTL', async () => {
    await backend.set('k1', 'v1')
    expect(client.set).toHaveBeenCalledWith('k1', 'v1')

    const result = await backend.get('k1')
    expect(result).toBe('v1')
  })

  it('stores a value with TTL using EX flag', async () => {
    await backend.set('k1', 'v1', 3600)
    expect(client.set).toHaveBeenCalledWith('k1', 'v1', 'EX', 3600)
  })

  it('does not use EX when ttlSeconds is 0', async () => {
    await backend.set('k1', 'v1', 0)
    expect(client.set).toHaveBeenCalledWith('k1', 'v1')
  })

  it('deletes a key', async () => {
    await backend.set('k1', 'v1')
    await backend.delete('k1')
    expect(client.del).toHaveBeenCalledWith('k1')
    expect(await backend.get('k1')).toBeNull()
  })

  // --- prefix support ---

  describe('with prefix', () => {
    beforeEach(() => {
      client = createMockRedisClient()
      backend = new RedisCacheBackend(client, { prefix: 'myapp' })
    })

    it('prepends prefix on get', async () => {
      await backend.get('k1')
      expect(client.get).toHaveBeenCalledWith('myapp:k1')
    })

    it('prepends prefix on set', async () => {
      await backend.set('k1', 'v1')
      expect(client.set).toHaveBeenCalledWith('myapp:k1', 'v1')
    })

    it('prepends prefix on set with TTL', async () => {
      await backend.set('k1', 'v1', 60)
      expect(client.set).toHaveBeenCalledWith('myapp:k1', 'v1', 'EX', 60)
    })

    it('prepends prefix on delete', async () => {
      await backend.delete('k1')
      expect(client.del).toHaveBeenCalledWith('myapp:k1')
    })

    it('round-trips a value through prefix', async () => {
      await backend.set('k1', 'hello')
      const result = await backend.get('k1')
      expect(result).toBe('hello')
    })
  })

  // --- clear ---

  it('clear uses SCAN to delete all keys', async () => {
    await backend.set('a', '1')
    await backend.set('b', '2')
    await backend.clear()

    expect(client.scan).toHaveBeenCalled()
    expect(client.del).toHaveBeenCalled()
  })

  it('clear resets internal stats', async () => {
    await backend.get('miss1')
    await backend.set('k', 'v')
    await backend.get('k') // hit

    await backend.clear()
    const stats = await backend.stats()
    expect(stats.hits).toBe(0)
    expect(stats.misses).toBe(0)
  })

  // --- error resilience ---

  it('get returns null and counts miss on client error', async () => {
    client.get.mockRejectedValueOnce(new Error('connection lost'))
    const result = await backend.get('k1')
    expect(result).toBeNull()

    const stats = await backend.stats()
    expect(stats.misses).toBe(1)
  })

  it('set does not throw on client error', async () => {
    client.set.mockRejectedValueOnce(new Error('connection lost'))
    await expect(backend.set('k1', 'v1')).resolves.toBeUndefined()
  })

  it('delete does not throw on client error', async () => {
    client.del.mockRejectedValueOnce(new Error('connection lost'))
    await expect(backend.delete('k1')).resolves.toBeUndefined()
  })

  it('clear does not throw on client error', async () => {
    client.scan.mockRejectedValueOnce(new Error('connection lost'))
    await expect(backend.clear()).resolves.toBeUndefined()
  })

  // --- stats ---

  it('tracks hits and misses', async () => {
    await backend.set('k', 'v')
    await backend.get('k') // hit
    await backend.get('k') // hit
    await backend.get('nope') // miss

    const stats = await backend.stats()
    expect(stats.hits).toBe(2)
    expect(stats.misses).toBe(1)
    expect(stats.hitRate).toBeCloseTo(2 / 3)
  })

  it('returns hitRate 0 when no operations occurred', async () => {
    const stats = await backend.stats()
    expect(stats.hitRate).toBe(0)
  })

  it('reports size as -1 (unknown for Redis)', async () => {
    const stats = await backend.stats()
    expect(stats.size).toBe(-1)
  })
})
