import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryCacheBackend } from '../backends/in-memory.js'
import { RedisCacheBackend } from '../backends/redis.js'

// ---------------------------------------------------------------------------
// InMemoryCacheBackend — sorted-set semantics
// ---------------------------------------------------------------------------

describe('InMemoryCacheBackend sorted-set ops', () => {
  let backend: InMemoryCacheBackend

  beforeEach(() => {
    backend = new InMemoryCacheBackend()
  })

  it('zadd inserts a new member and zcard reflects the count', async () => {
    expect(await backend.zcard('s')).toBe(0)
    await backend.zadd('s', 10, 'a')
    await backend.zadd('s', 20, 'b')
    expect(await backend.zcard('s')).toBe(2)
  })

  it('zadd updates the score of an existing member without duplicating', async () => {
    await backend.zadd('s', 10, 'a')
    await backend.zadd('s', 99, 'a')
    expect(await backend.zcard('s')).toBe(1)
    const all = await backend.zrangebyscore('s', -Infinity, Infinity)
    expect(all).toEqual(['a'])
  })

  it('zrangebyscore returns members within range in ascending score order', async () => {
    await backend.zadd('s', 30, 'c')
    await backend.zadd('s', 10, 'a')
    await backend.zadd('s', 20, 'b')

    expect(await backend.zrangebyscore('s', 10, 20)).toEqual(['a', 'b'])
    expect(await backend.zrangebyscore('s', 0, 100)).toEqual(['a', 'b', 'c'])
    expect(await backend.zrangebyscore('s', 25, 35)).toEqual(['c'])
  })

  it('zrangebyscore on missing key returns []', async () => {
    expect(await backend.zrangebyscore('nope', -Infinity, Infinity)).toEqual([])
  })

  it('zrangebyscore is inclusive at both ends', async () => {
    await backend.zadd('s', 10, 'a')
    await backend.zadd('s', 20, 'b')
    expect(await backend.zrangebyscore('s', 10, 10)).toEqual(['a'])
    expect(await backend.zrangebyscore('s', 20, 20)).toEqual(['b'])
  })

  it('zrem removes a single member and is idempotent', async () => {
    await backend.zadd('s', 10, 'a')
    await backend.zadd('s', 20, 'b')

    await backend.zrem('s', 'a')
    expect(await backend.zcard('s')).toBe(1)
    expect(await backend.zrangebyscore('s', -Infinity, Infinity)).toEqual(['b'])

    // Removing an absent member must not throw
    await expect(backend.zrem('s', 'a')).resolves.toBeUndefined()
    await expect(backend.zrem('missing-key', 'x')).resolves.toBeUndefined()
  })

  it('zrem removing the last member drops the underlying set', async () => {
    await backend.zadd('s', 10, 'only')
    await backend.zrem('s', 'only')
    // zcard reports 0 whether the set was deleted or just emptied
    expect(await backend.zcard('s')).toBe(0)
  })

  it('clear() wipes both regular cache and sorted sets', async () => {
    await backend.set('k', 'v')
    await backend.zadd('s', 1, 'a')
    await backend.clear()
    expect(await backend.get('k')).toBeNull()
    expect(await backend.zcard('s')).toBe(0)
  })

  it('sorted-set keys are isolated from regular cache keys', async () => {
    await backend.set('shared', 'plain-value')
    await backend.zadd('shared', 1, 'm')
    // get/zcard inhabit different namespaces internally
    expect(await backend.get('shared')).toBe('plain-value')
    expect(await backend.zcard('shared')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// RedisCacheBackend — sorted-set ops delegate to the ioredis client and
// honor key prefixing.
// ---------------------------------------------------------------------------

describe('RedisCacheBackend sorted-set ops', () => {
  function makeClient() {
    return {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      scan: vi.fn(),
      zadd: vi.fn().mockResolvedValue(1),
      zrangebyscore: vi.fn().mockResolvedValue(['a', 'b']),
      zrem: vi.fn().mockResolvedValue(1),
      zcard: vi.fn().mockResolvedValue(2),
    }
  }

  it('prefixes the key on every sorted-set call', async () => {
    const client = makeClient()
    const backend = new RedisCacheBackend(client, { prefix: 'pref' })

    await backend.zadd('s', 10, 'a')
    expect(client.zadd).toHaveBeenCalledWith('pref:s', 10, 'a')

    await backend.zrangebyscore('s', 0, 100)
    expect(client.zrangebyscore).toHaveBeenCalledWith('pref:s', 0, 100)

    await backend.zrem('s', 'a')
    expect(client.zrem).toHaveBeenCalledWith('pref:s', 'a')

    await backend.zcard('s')
    expect(client.zcard).toHaveBeenCalledWith('pref:s')
  })

  it('returns the array from zrangebyscore unchanged', async () => {
    const client = makeClient()
    const backend = new RedisCacheBackend(client)
    expect(await backend.zrangebyscore('s', 0, 100)).toEqual(['a', 'b'])
  })

  it('returns the count from zcard', async () => {
    const client = makeClient()
    const backend = new RedisCacheBackend(client)
    expect(await backend.zcard('s')).toBe(2)
  })

  it('propagates errors from the underlying client (no silent degradation)', async () => {
    const client = makeClient()
    client.zadd.mockRejectedValueOnce(new Error('redis down'))
    const backend = new RedisCacheBackend(client)
    await expect(backend.zadd('s', 1, 'a')).rejects.toThrow('redis down')
  })
})
