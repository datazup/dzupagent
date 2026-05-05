/**
 * Tests for `MemoryPruner` (MC-02).
 */
import { describe, it, expect, vi } from 'vitest'
import { MemoryPruner } from '../memory-pruner.js'
import type {
  ConsolidationStore,
  ConsolidationStoreItem,
} from '../consolidation-engine.js'

interface MockStore extends ConsolidationStore {
  data: Map<string, Record<string, unknown>>
}

function createMockStore(
  records: Array<{ key: string; value: Record<string, unknown> }> = [],
): MockStore {
  const data = new Map<string, Record<string, unknown>>()
  for (const { key, value } of records) {
    data.set(key, value)
  }
  return {
    data,
    search: vi.fn(async (): Promise<ConsolidationStoreItem[]> => {
      return [...data.entries()].map(([key, value]) => ({ key, value }))
    }),
    put: vi.fn(async (_ns: string[], key: string, value: Record<string, unknown>) => {
      data.set(key, value)
    }),
    delete: vi.fn(async (_ns: string[], key: string) => {
      data.delete(key)
    }),
  }
}

describe('MemoryPruner', () => {
  it('prunes TTL-expired entries', async () => {
    const now = 10_000_000
    const tenDays = 10 * 24 * 60 * 60 * 1000
    const oneDay = 24 * 60 * 60 * 1000

    const store = createMockStore([
      // Old: createdAt 10 days ago → expired
      { key: 'old:1', value: { text: 'old', _decay: { createdAt: now - tenDays, strength: 0.9 } } },
      { key: 'old:2', value: { text: 'old', _decay: { createdAt: now - tenDays, strength: 0.8 } } },
      // Fresh: 1 day ago
      { key: 'fresh:1', value: { text: 'fresh', _decay: { createdAt: now - oneDay, strength: 0.9 } } },
    ])

    const pruner = new MemoryPruner()
    const result = await pruner.prune(store, {
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      now: () => now,
    })

    expect(result.expired).toBe(2)
    expect(result.evicted).toBe(0)
    expect(result.remaining).toBe(1)
    expect(store.data.has('old:1')).toBe(false)
    expect(store.data.has('old:2')).toBe(false)
    expect(store.data.has('fresh:1')).toBe(true)
  })

  it('evicts lowest-strength entries when over maxEntries ceiling', async () => {
    const now = 10_000_000

    // 5 fresh entries with varying strengths; cap at 3
    const store = createMockStore([
      { key: 'a', value: { _decay: { createdAt: now, strength: 0.9 } } },
      { key: 'b', value: { _decay: { createdAt: now, strength: 0.1 } } },
      { key: 'c', value: { _decay: { createdAt: now, strength: 0.5 } } },
      { key: 'd', value: { _decay: { createdAt: now, strength: 0.05 } } },
      { key: 'e', value: { _decay: { createdAt: now, strength: 0.7 } } },
    ])

    const pruner = new MemoryPruner()
    const result = await pruner.prune(store, {
      maxEntries: 3,
      now: () => now,
    })

    expect(result.expired).toBe(0)
    expect(result.evicted).toBe(2)
    expect(result.remaining).toBe(3)
    // Weakest (d=0.05, b=0.1) should be evicted
    expect(store.data.has('d')).toBe(false)
    expect(store.data.has('b')).toBe(false)
    // Strongest survive
    expect(store.data.has('a')).toBe(true)
    expect(store.data.has('c')).toBe(true)
    expect(store.data.has('e')).toBe(true)
  })

  it('combines TTL expiry and capacity eviction in a single pass', async () => {
    const now = 10_000_000
    const tenDays = 10 * 24 * 60 * 60 * 1000

    const store = createMockStore([
      // Old → TTL expiry
      { key: 'old', value: { _decay: { createdAt: now - tenDays, strength: 1 } } },
      // 4 fresh entries; cap at 2 → 2 evictions
      { key: 'a', value: { _decay: { createdAt: now, strength: 0.9 } } },
      { key: 'b', value: { _decay: { createdAt: now, strength: 0.1 } } },
      { key: 'c', value: { _decay: { createdAt: now, strength: 0.5 } } },
      { key: 'd', value: { _decay: { createdAt: now, strength: 0.05 } } },
    ])

    const pruner = new MemoryPruner()
    const result = await pruner.prune(store, {
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      maxEntries: 2,
      now: () => now,
    })

    expect(result.expired).toBe(1)
    expect(result.evicted).toBe(2)
    expect(result.remaining).toBe(2)
    expect(store.data.has('old')).toBe(false)
    expect(store.data.has('d')).toBe(false)
    expect(store.data.has('b')).toBe(false)
  })

  it('returns zero counts on empty store', async () => {
    const store = createMockStore()
    const result = await new MemoryPruner().prune(store)
    expect(result).toEqual({ expired: 0, evicted: 0, remaining: 0 })
  })

  it('returns zero counts when search throws', async () => {
    const store: ConsolidationStore = {
      search: () => Promise.reject(new Error('boom')),
      put: vi.fn(),
      delete: vi.fn(),
    }
    const result = await new MemoryPruner().prune(store)
    expect(result).toEqual({ expired: 0, evicted: 0, remaining: 0 })
  })

  it('falls back to value.createdAt and item.createdAt when _decay is missing', async () => {
    const now = 10_000_000
    const tenDays = 10 * 24 * 60 * 60 * 1000

    const store: ConsolidationStore & { data: Map<string, Record<string, unknown>> } = {
      data: new Map(),
      search: vi.fn(async (): Promise<ConsolidationStoreItem[]> => [
        { key: 'a', value: { createdAt: now - tenDays } },
        { key: 'b', value: {}, createdAt: new Date(now - tenDays) },
        { key: 'c', value: { _decay: { createdAt: now, strength: 0.9 } } },
      ]),
      put: vi.fn(),
      delete: vi.fn(async () => undefined),
    }

    const pruner = new MemoryPruner()
    const result = await pruner.prune(store, {
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      now: () => now,
    })

    expect(result.expired).toBe(2)
    expect(store.delete).toHaveBeenCalledWith([], 'a')
    expect(store.delete).toHaveBeenCalledWith([], 'b')
  })
})
