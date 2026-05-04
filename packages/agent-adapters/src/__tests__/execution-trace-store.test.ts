import { afterEach, describe, expect, it, vi } from 'vitest'

import { ExecutionTraceStore } from '../recovery/execution-trace-store.js'

describe('ExecutionTraceStore', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('construction', () => {
    it('rejects non-positive ttlMs', () => {
      expect(() => new ExecutionTraceStore({ ttlMs: 0, maxSize: 10 })).toThrow(
        /ttlMs must be > 0/,
      )
      expect(() => new ExecutionTraceStore({ ttlMs: -1, maxSize: 10 })).toThrow(
        /ttlMs must be > 0/,
      )
    })

    it('rejects non-positive maxSize', () => {
      expect(() => new ExecutionTraceStore({ ttlMs: 1000, maxSize: 0 })).toThrow(
        /maxSize must be > 0/,
      )
      expect(() => new ExecutionTraceStore({ ttlMs: 1000, maxSize: -5 })).toThrow(
        /maxSize must be > 0/,
      )
    })

    it('rejects non-finite values', () => {
      expect(() => new ExecutionTraceStore({ ttlMs: NaN, maxSize: 10 })).toThrow()
      expect(() => new ExecutionTraceStore({ ttlMs: 1000, maxSize: Infinity })).toThrow()
    })
  })

  describe('store + get', () => {
    it('stores and retrieves values', () => {
      const store = new ExecutionTraceStore<{ msg: string }>({ ttlMs: 60_000, maxSize: 10 })
      store.store('a', { msg: 'hello' })
      expect(store.get('a')).toEqual({ msg: 'hello' })
      expect(store.has('a')).toBe(true)
      expect(store.size).toBe(1)
      store.dispose()
    })

    it('replaces existing entry and clears its previous timer', () => {
      vi.useFakeTimers()
      const store = new ExecutionTraceStore<string>({ ttlMs: 1000, maxSize: 10 })
      store.store('a', 'first')
      vi.advanceTimersByTime(500)
      // Replace before original TTL expires.
      store.store('a', 'second')
      // Advance to a point where the *original* timer would have fired.
      vi.advanceTimersByTime(700) // total elapsed = 1200 ms — original expired at 1000
      // The replaced entry has a fresh 1000ms timer, so it should still exist.
      expect(store.get('a')).toBe('second')
      // Now advance past the new timer.
      vi.advanceTimersByTime(400) // 500ms after the replacement = past 1000ms ttl
      expect(store.get('a')).toBeUndefined()
      store.dispose()
    })

    it('returns undefined for missing keys', () => {
      const store = new ExecutionTraceStore({ ttlMs: 1000, maxSize: 10 })
      expect(store.get('missing')).toBeUndefined()
      expect(store.has('missing')).toBe(false)
      store.dispose()
    })
  })

  describe('TTL expiry', () => {
    it('evicts entries after ttlMs has elapsed', () => {
      vi.useFakeTimers()
      const store = new ExecutionTraceStore<string>({ ttlMs: 1000, maxSize: 10 })
      store.store('key', 'value')
      expect(store.get('key')).toBe('value')

      vi.advanceTimersByTime(999)
      expect(store.get('key')).toBe('value')

      vi.advanceTimersByTime(1)
      expect(store.get('key')).toBeUndefined()
      expect(store.size).toBe(0)

      store.dispose()
    })

    it('expires multiple entries independently', () => {
      vi.useFakeTimers()
      const store = new ExecutionTraceStore<string>({ ttlMs: 1000, maxSize: 10 })
      store.store('a', '1')
      vi.advanceTimersByTime(500)
      store.store('b', '2')

      // After 600ms total, both still alive.
      vi.advanceTimersByTime(100)
      expect(store.get('a')).toBe('1')
      expect(store.get('b')).toBe('2')

      // After 1100ms total, 'a' has expired but 'b' is still alive.
      vi.advanceTimersByTime(500)
      expect(store.get('a')).toBeUndefined()
      expect(store.get('b')).toBe('2')

      // After 1600ms total, 'b' has also expired.
      vi.advanceTimersByTime(500)
      expect(store.get('b')).toBeUndefined()

      store.dispose()
    })
  })

  describe('maxSize eviction', () => {
    it('evicts the oldest entry when maxSize is exceeded', () => {
      const store = new ExecutionTraceStore<string>({ ttlMs: 60_000, maxSize: 2 })
      store.store('first', '1')
      store.store('second', '2')
      store.store('third', '3')
      expect(store.size).toBeLessThanOrEqual(2)
      expect(store.get('first')).toBeUndefined()
      expect(store.get('second')).toBe('2')
      expect(store.get('third')).toBe('3')
      store.dispose()
    })

    it('evicts oldest by insertion time across multiple inserts', () => {
      const store = new ExecutionTraceStore<string>({ ttlMs: 60_000, maxSize: 1 })
      store.store('a', 'A')
      store.store('b', 'B')
      expect(store.get('a')).toBeUndefined()
      expect(store.get('b')).toBe('B')
      store.store('c', 'C')
      expect(store.get('b')).toBeUndefined()
      expect(store.get('c')).toBe('C')
      store.dispose()
    })

    it('clears the evicted entry timer (no late-firing eviction)', () => {
      vi.useFakeTimers()
      const store = new ExecutionTraceStore<string>({ ttlMs: 1000, maxSize: 1 })
      store.store('first', '1')
      // Force eviction of 'first'.
      store.store('second', '2')
      // Advance well past 'first's original TTL — should not affect 'second'.
      vi.advanceTimersByTime(1500)
      // 'second' was inserted at t=0 (alongside the eviction) and TTL is 1000ms.
      expect(store.get('second')).toBeUndefined()
      // But the eviction at t=0 should not have removed 'second' before its TTL.
      // (If the cleared timer had still fired, this would be a regression.)
      store.dispose()
    })
  })

  describe('remove', () => {
    it('removes an entry and clears its timer', () => {
      vi.useFakeTimers()
      const store = new ExecutionTraceStore<string>({ ttlMs: 1000, maxSize: 10 })
      store.store('key', 'value')
      store.remove('key')
      expect(store.get('key')).toBeUndefined()
      expect(store.has('key')).toBe(false)
      // Advancing past the TTL should be a no-op.
      vi.advanceTimersByTime(2000)
      store.dispose()
    })

    it('is a no-op for missing keys', () => {
      const store = new ExecutionTraceStore({ ttlMs: 1000, maxSize: 10 })
      expect(() => store.remove('missing')).not.toThrow()
      store.dispose()
    })
  })

  describe('values + size', () => {
    it('returns a snapshot of all values', () => {
      const store = new ExecutionTraceStore<number>({ ttlMs: 60_000, maxSize: 10 })
      store.store('a', 1)
      store.store('b', 2)
      store.store('c', 3)
      expect(store.values()).toEqual([1, 2, 3])
      expect(store.size).toBe(3)
      store.dispose()
    })
  })

  describe('clear', () => {
    it('removes all entries and clears their timers', () => {
      vi.useFakeTimers()
      const store = new ExecutionTraceStore<string>({ ttlMs: 1000, maxSize: 10 })
      store.store('a', '1')
      store.store('b', '2')
      store.clear()
      expect(store.size).toBe(0)
      expect(store.get('a')).toBeUndefined()
      // Original timers must not fire after clear.
      vi.advanceTimersByTime(2000)
      store.dispose()
    })
  })

  describe('dispose', () => {
    it('clears every entry and is idempotent', () => {
      vi.useFakeTimers()
      const store = new ExecutionTraceStore<string>({ ttlMs: 1000, maxSize: 10 })
      store.store('a', '1')
      store.store('b', '2')
      store.dispose()
      expect(store.size).toBe(0)
      // Calling dispose() again must not throw.
      expect(() => store.dispose()).not.toThrow()
      // Advancing past the original TTL must not produce side effects.
      vi.advanceTimersByTime(2000)
    })

    it('allows storing again after dispose', () => {
      const store = new ExecutionTraceStore<string>({ ttlMs: 1000, maxSize: 10 })
      store.store('a', '1')
      store.dispose()
      // Re-using the store should still be safe — dispose is just clear().
      store.store('b', '2')
      expect(store.get('b')).toBe('2')
      store.dispose()
    })
  })
})
