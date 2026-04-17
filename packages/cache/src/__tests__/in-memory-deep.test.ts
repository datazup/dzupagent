import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryCacheBackend } from '../backends/in-memory.js'

describe('InMemoryCacheBackend — deep coverage', () => {
  let backend: InMemoryCacheBackend

  beforeEach(() => {
    backend = new InMemoryCacheBackend()
  })

  // --- TTL edge cases ---

  describe('TTL edge cases', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('TTL of 0 is treated as no expiry', async () => {
      vi.useFakeTimers()
      await backend.set('k', 'val', 0)
      vi.advanceTimersByTime(999_999_999)
      expect(await backend.get('k')).toBe('val')
    })

    it('negative TTL still computes an expiresAt in the past, causing immediate expiry', async () => {
      // The implementation does `Date.now() + ttlSeconds * 1000` — a negative ttl
      // results in an expiresAt before now, so get() should return null.
      await backend.set('k', 'val', -1)
      expect(await backend.get('k')).toBeNull()
    })

    it('item expires exactly at the TTL boundary', async () => {
      vi.useFakeTimers({ now: 1000 })
      await backend.set('k', 'val', 5) // expiresAt = 1000 + 5000 = 6000

      // At exactly 6000ms, Date.now() === expiresAt, condition is > not >=, so should still be valid
      vi.setSystemTime(6000)
      expect(await backend.get('k')).toBe('val')

      // At 6001ms it should be expired
      vi.setSystemTime(6001)
      expect(await backend.get('k')).toBeNull()
    })

    it('multiple items with different TTLs expire independently', async () => {
      vi.useFakeTimers()
      await backend.set('short', 'a', 1)
      await backend.set('long', 'b', 10)
      await backend.set('forever', 'c')

      vi.advanceTimersByTime(2000)
      expect(await backend.get('short')).toBeNull()
      expect(await backend.get('long')).toBe('b')
      expect(await backend.get('forever')).toBe('c')

      vi.advanceTimersByTime(9000)
      expect(await backend.get('long')).toBeNull()
      expect(await backend.get('forever')).toBe('c')
    })

    it('stats purges multiple expired entries correctly', async () => {
      vi.useFakeTimers()
      await backend.set('a', '1', 1)
      await backend.set('b', '2', 2)
      await backend.set('c', '3', 3)
      await backend.set('permanent', '4')

      vi.advanceTimersByTime(2500)
      const stats = await backend.stats()
      // 'a' (ttl=1) and 'b' (ttl=2) should be purged
      expect(stats.size).toBe(2)
    })
  })

  // --- LRU eviction edge cases ---

  describe('LRU eviction edge cases', () => {
    it('maxEntries of 1 means only the last set key survives', async () => {
      const tiny = new InMemoryCacheBackend({ maxEntries: 1 })
      await tiny.set('a', '1')
      await tiny.set('b', '2')
      expect(await tiny.get('a')).toBeNull()
      expect(await tiny.get('b')).toBe('2')
    })

    it('eviction cascades correctly when adding many items at once', async () => {
      const small = new InMemoryCacheBackend({ maxEntries: 3 })
      for (let i = 0; i < 10; i++) {
        await small.set(`key-${i}`, `val-${i}`)
      }
      // Only the last 3 should remain
      const stats = await small.stats()
      expect(stats.size).toBe(3)
      expect(await small.get('key-7')).toBe('val-7')
      expect(await small.get('key-8')).toBe('val-8')
      expect(await small.get('key-9')).toBe('val-9')
      expect(await small.get('key-0')).toBeNull()
    })

    it('overwriting the same key does not increase size or trigger eviction', async () => {
      const small = new InMemoryCacheBackend({ maxEntries: 2 })
      await small.set('a', '1')
      await small.set('b', '2')
      // Overwrite 'a' should not evict 'b'
      await small.set('a', 'updated')
      expect(await small.get('a')).toBe('updated')
      expect(await small.get('b')).toBe('2')
      const stats = await small.stats()
      expect(stats.size).toBe(2)
    })

    it('get on an expired key does not count as LRU refresh', async () => {
      vi.useFakeTimers()
      try {
        const small = new InMemoryCacheBackend({ maxEntries: 3 })
        await small.set('a', '1', 1) // will expire
        await small.set('b', '2')
        await small.set('c', '3')

        vi.advanceTimersByTime(2000)
        // Accessing expired 'a' should not refresh it
        expect(await small.get('a')).toBeNull()

        // Adding a new key should not evict b or c since 'a' was already removed
        await small.set('d', '4')
        expect(await small.get('b')).toBe('2')
        expect(await small.get('c')).toBe('3')
        expect(await small.get('d')).toBe('4')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // --- Concurrent-like access patterns ---

  describe('concurrent access patterns', () => {
    it('parallel set operations all complete without error', async () => {
      const promises = Array.from({ length: 50 }, (_, i) =>
        backend.set(`key-${i}`, `val-${i}`)
      )
      await expect(Promise.all(promises)).resolves.toBeDefined()
      const stats = await backend.stats()
      expect(stats.size).toBe(50)
    })

    it('parallel get operations return correct values', async () => {
      for (let i = 0; i < 20; i++) {
        await backend.set(`key-${i}`, `val-${i}`)
      }
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => backend.get(`key-${i}`))
      )
      results.forEach((val, i) => {
        expect(val).toBe(`val-${i}`)
      })
    })

    it('interleaved set and get operations maintain consistency', async () => {
      const ops: Promise<unknown>[] = []
      for (let i = 0; i < 10; i++) {
        ops.push(backend.set(`k-${i}`, `v-${i}`))
        ops.push(backend.get(`k-${i}`))
      }
      await Promise.all(ops)
      // After all ops, all keys should be present
      for (let i = 0; i < 10; i++) {
        expect(await backend.get(`k-${i}`)).toBe(`v-${i}`)
      }
    })
  })

  // --- Key namespacing / special characters ---

  describe('key namespacing and special characters', () => {
    it('handles keys with colons', async () => {
      await backend.set('namespace:sub:key', 'val')
      expect(await backend.get('namespace:sub:key')).toBe('val')
    })

    it('handles keys with spaces', async () => {
      await backend.set('key with spaces', 'val')
      expect(await backend.get('key with spaces')).toBe('val')
    })

    it('handles empty string as key', async () => {
      await backend.set('', 'val')
      expect(await backend.get('')).toBe('val')
    })

    it('handles very long keys', async () => {
      const longKey = 'x'.repeat(10000)
      await backend.set(longKey, 'val')
      expect(await backend.get(longKey)).toBe('val')
    })

    it('handles unicode keys', async () => {
      await backend.set('clef:🎵:data', 'music')
      expect(await backend.get('clef:🎵:data')).toBe('music')
    })
  })

  // --- Value serialization edge cases ---

  describe('value storage edge cases', () => {
    it('stores empty string as value', async () => {
      await backend.set('k', '')
      expect(await backend.get('k')).toBe('')
    })

    it('stores very large values', async () => {
      const largeValue = 'x'.repeat(1_000_000)
      await backend.set('k', largeValue)
      expect(await backend.get('k')).toBe(largeValue)
    })

    it('stores JSON-serialized objects', async () => {
      const obj = { nested: { data: [1, 2, 3] }, nullField: null }
      const serialized = JSON.stringify(obj)
      await backend.set('k', serialized)
      const retrieved = await backend.get('k')
      expect(JSON.parse(retrieved!)).toEqual(obj)
    })

    it('stores values with special characters', async () => {
      const special = 'line1\nline2\ttab\r\nwindows\0null'
      await backend.set('k', special)
      expect(await backend.get('k')).toBe(special)
    })
  })

  // --- Stats accuracy ---

  describe('stats accuracy', () => {
    it('hitRate is calculated correctly with mixed operations', async () => {
      await backend.set('a', '1')
      await backend.set('b', '2')

      await backend.get('a') // hit
      await backend.get('b') // hit
      await backend.get('c') // miss
      await backend.get('d') // miss
      await backend.get('a') // hit

      const stats = await backend.stats()
      expect(stats.hits).toBe(3)
      expect(stats.misses).toBe(2)
      expect(stats.hitRate).toBeCloseTo(3 / 5)
    })

    it('delete does not affect hit/miss counters', async () => {
      await backend.set('k', 'v')
      await backend.get('k') // hit
      await backend.delete('k')

      const stats = await backend.stats()
      expect(stats.hits).toBe(1)
      expect(stats.misses).toBe(0)
    })

    it('stats size reflects current entries after deletes', async () => {
      await backend.set('a', '1')
      await backend.set('b', '2')
      await backend.set('c', '3')
      await backend.delete('b')

      const stats = await backend.stats()
      expect(stats.size).toBe(2)
    })

    it('clear resets both hits and misses to zero', async () => {
      await backend.set('k', 'v')
      await backend.get('k') // hit
      await backend.get('missing') // miss

      await backend.clear()
      const stats = await backend.stats()
      expect(stats.hits).toBe(0)
      expect(stats.misses).toBe(0)
    })
  })
})
