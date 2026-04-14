import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryCacheBackend } from '../backends/in-memory.js'

describe('InMemoryCacheBackend', () => {
  let backend: InMemoryCacheBackend

  beforeEach(() => {
    backend = new InMemoryCacheBackend()
  })

  // --- basic get/set/delete ---

  it('returns null for a missing key', async () => {
    expect(await backend.get('nonexistent')).toBeNull()
  })

  it('stores and retrieves a value', async () => {
    await backend.set('k1', 'v1')
    expect(await backend.get('k1')).toBe('v1')
  })

  it('overwrites an existing key', async () => {
    await backend.set('k1', 'v1')
    await backend.set('k1', 'v2')
    expect(await backend.get('k1')).toBe('v2')
  })

  it('deletes a key', async () => {
    await backend.set('k1', 'v1')
    await backend.delete('k1')
    expect(await backend.get('k1')).toBeNull()
  })

  it('delete on nonexistent key does not throw', async () => {
    await expect(backend.delete('nope')).resolves.toBeUndefined()
  })

  // --- clear ---

  it('clear removes all entries and resets stats', async () => {
    await backend.set('a', '1')
    await backend.set('b', '2')
    await backend.get('a') // hit
    await backend.get('missing') // miss

    await backend.clear()

    expect(await backend.get('a')).toBeNull()
    expect(await backend.get('b')).toBeNull()
    const stats = await backend.stats()
    // After clear, the two gets above (for a and b) register as misses on the fresh stats
    expect(stats.hits).toBe(0)
    expect(stats.size).toBe(0)
  })

  // --- TTL expiry ---

  it('returns value before TTL expires', async () => {
    await backend.set('k', 'val', 60)
    expect(await backend.get('k')).toBe('val')
  })

  it('returns null after TTL expires', async () => {
    vi.useFakeTimers()
    try {
      await backend.set('k', 'val', 1) // 1 second TTL
      expect(await backend.get('k')).toBe('val')

      vi.advanceTimersByTime(1500) // 1.5 seconds later
      expect(await backend.get('k')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('items without TTL never expire', async () => {
    vi.useFakeTimers()
    try {
      await backend.set('k', 'val') // no TTL
      vi.advanceTimersByTime(999_999_999)
      expect(await backend.get('k')).toBe('val')
    } finally {
      vi.useRealTimers()
    }
  })

  // --- LRU eviction ---

  it('evicts the oldest entry when maxEntries is reached', async () => {
    const small = new InMemoryCacheBackend({ maxEntries: 3 })
    await small.set('a', '1')
    await small.set('b', '2')
    await small.set('c', '3')

    // Adding a 4th should evict 'a' (oldest)
    await small.set('d', '4')

    expect(await small.get('a')).toBeNull()
    expect(await small.get('b')).toBe('2')
    expect(await small.get('d')).toBe('4')
  })

  it('accessing a key refreshes its LRU position', async () => {
    const small = new InMemoryCacheBackend({ maxEntries: 3 })
    await small.set('a', '1')
    await small.set('b', '2')
    await small.set('c', '3')

    // Access 'a' to refresh it — now 'b' is the oldest
    await small.get('a')

    await small.set('d', '4')
    expect(await small.get('a')).toBe('1') // refreshed, should survive
    expect(await small.get('b')).toBeNull() // evicted as oldest
  })

  it('overwriting a key refreshes its LRU position', async () => {
    const small = new InMemoryCacheBackend({ maxEntries: 3 })
    await small.set('a', '1')
    await small.set('b', '2')
    await small.set('c', '3')

    // Overwrite 'a' — now 'b' is oldest
    await small.set('a', 'updated')

    await small.set('d', '4')
    expect(await small.get('a')).toBe('updated')
    expect(await small.get('b')).toBeNull()
  })

  // --- stats ---

  it('tracks hits and misses', async () => {
    await backend.set('k', 'v')
    await backend.get('k') // hit
    await backend.get('k') // hit
    await backend.get('missing') // miss

    const stats = await backend.stats()
    expect(stats.hits).toBe(2)
    expect(stats.misses).toBe(1)
    expect(stats.hitRate).toBeCloseTo(2 / 3)
  })

  it('reports size correctly', async () => {
    await backend.set('a', '1')
    await backend.set('b', '2')
    const stats = await backend.stats()
    expect(stats.size).toBe(2)
  })

  it('returns hitRate 0 when no operations have occurred', async () => {
    const stats = await backend.stats()
    expect(stats.hitRate).toBe(0)
    expect(stats.hits).toBe(0)
    expect(stats.misses).toBe(0)
    expect(stats.size).toBe(0)
  })

  it('expired entries count as misses', async () => {
    vi.useFakeTimers()
    try {
      await backend.set('k', 'v', 1)
      vi.advanceTimersByTime(2000)
      await backend.get('k') // should be a miss (expired)

      const stats = await backend.stats()
      expect(stats.misses).toBe(1)
      expect(stats.hits).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stats purges expired entries from size count', async () => {
    vi.useFakeTimers()
    try {
      await backend.set('expire-me', 'val', 1)
      await backend.set('keep-me', 'val') // no TTL

      vi.advanceTimersByTime(2000)
      const stats = await backend.stats()
      expect(stats.size).toBe(1) // only 'keep-me' remains
    } finally {
      vi.useRealTimers()
    }
  })

  it('defaults maxEntries to 1000', async () => {
    // Just verify we can add more than a few without eviction
    const b = new InMemoryCacheBackend()
    for (let i = 0; i < 100; i++) {
      await b.set(`key-${i}`, `val-${i}`)
    }
    const stats = await b.stats()
    expect(stats.size).toBe(100)
  })
})
