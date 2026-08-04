/**
 * AGENT-C-09 — the MemoryPruner capacity pass must actually run at defaults.
 *
 * Root cause: `prune()` did a single `store.search(ns, { limit: pageSize })`
 * with `DEFAULT_PAGE_SIZE = 500`, while `DEFAULT_MAX_ENTRIES = 1000`. The
 * capacity guard `survivors.length > maxEntries` therefore compared a value
 * capped at 500 against 1000 and could never be true — the only global bound on
 * the store was dead code and memory grew unbounded.
 *
 * These tests use DEFAULT options only (no `maxEntries`, no `pageSize`), so
 * restoring the single-page scan makes them fail.
 */

import { describe, it, expect } from 'vitest'

import { MemoryPruner } from '../memory-pruner.js'
import type {
  ConsolidationStore,
  ConsolidationStoreItem,
} from '../consolidation-engine.js'

/** Paginating in-memory store with the same `search(ns, {limit, offset})` contract. */
function makeStore(count: number, now: number): {
  store: ConsolidationStore
  items: Map<string, ConsolidationStoreItem>
  searchCalls: Array<{ limit?: number | undefined; offset?: number | undefined }>
} {
  const items = new Map<string, ConsolidationStoreItem>()
  for (let i = 0; i < count; i++) {
    const key = `k${String(i).padStart(5, '0')}`
    items.set(key, {
      key,
      value: {
        text: `entry ${i}`,
        // All fresh, so the TTL pass is a no-op and only capacity can evict.
        _decay: { createdAt: now - 1000, strength: i / count },
      },
    })
  }

  const searchCalls: Array<{ limit?: number | undefined; offset?: number | undefined }> = []
  const store: ConsolidationStore = {
    async search(_ns, options) {
      searchCalls.push({ limit: options?.limit, offset: options?.offset })
      const all = [...items.values()]
      const offset = options?.offset ?? 0
      const limit = options?.limit ?? all.length
      return all.slice(offset, offset + limit)
    },
    async put(_ns, key, value) {
      items.set(key, { key, value })
    },
    async delete(_ns, key) {
      items.delete(key)
    },
  }
  return { store, items, searchCalls }
}

describe('AGENT-C-09 — capacity pass at default configuration', () => {
  it('evicts down to the default 1000-entry ceiling with no options supplied', async () => {
    const now = Date.UTC(2026, 6, 30)
    const { store, items } = makeStore(1200, now)

    // Default configuration: only the synthetic clock is injected.
    const result = await new MemoryPruner().prune(store, { now: () => now })

    expect(result.expired).toBe(0)
    // The whole finding: this was structurally stuck at 0.
    expect(result.evicted).toBe(200)
    expect(result.remaining).toBe(1000)
    expect(items.size).toBe(1000)
  })

  it('scans past the default page size — the guard that made the pass dead code', async () => {
    const now = Date.UTC(2026, 6, 30)
    const { store, searchCalls } = makeStore(1200, now)

    await new MemoryPruner().prune(store, { now: () => now })

    // More than one page was requested, and the total observed exceeds
    // DEFAULT_MAX_ENTRIES (1000). A single 500-row page cannot satisfy this.
    expect(searchCalls.length).toBeGreaterThan(1)
    expect(searchCalls.some((c) => (c.offset ?? 0) >= 500)).toBe(true)
  })

  it('evicts the weakest entries first', async () => {
    const now = Date.UTC(2026, 6, 30)
    const { store, items } = makeStore(1050, now)

    await new MemoryPruner().prune(store, { now: () => now })

    expect(items.size).toBe(1000)
    // strength was i/count, so the 50 lowest indices are the weakest.
    expect(items.has('k00000')).toBe(false)
    expect(items.has('k00049')).toBe(false)
    expect(items.has('k00050')).toBe(true)
    expect(items.has('k01049')).toBe(true)
  })

  it('is a no-op when the store is under the default ceiling', async () => {
    const now = Date.UTC(2026, 6, 30)
    const { store, items } = makeStore(900, now)

    const result = await new MemoryPruner().prune(store, { now: () => now })

    expect(result.evicted).toBe(0)
    expect(result.remaining).toBe(900)
    expect(items.size).toBe(900)
  })

  it('bounds a single run via maxScan rather than pulling the whole store', async () => {
    const now = Date.UTC(2026, 6, 30)
    const { store } = makeStore(5000, now)

    const result = await new MemoryPruner().prune(store, {
      now: () => now,
      maxEntries: 100,
      maxScan: 300,
    })

    expect(result.evicted).toBe(200)
    expect(result.remaining).toBe(100)
  })

  it('terminates when the backend ignores offset', async () => {
    const now = Date.UTC(2026, 6, 30)
    const { items } = makeStore(1200, now)
    const store: ConsolidationStore = {
      async search(_ns, options) {
        // Deliberately ignores `offset` — a naive loop would spin forever.
        return [...items.values()].slice(0, options?.limit ?? 500)
      },
      async put() {},
      async delete(_ns, key) {
        items.delete(key)
      },
    }

    const result = await new MemoryPruner().prune(store, { now: () => now })

    expect(result.evicted).toBe(0)
    expect(result.remaining).toBe(500)
  })
})
