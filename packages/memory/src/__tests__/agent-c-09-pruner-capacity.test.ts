/**
 * AGENT-C-09 — the MemoryPruner capacity pass must actually run at defaults.
 *
 * Root cause: `prune()` did a single `store.search(ns, { limit: pageSize })`
 * with `DEFAULT_PAGE_SIZE = 500`, while `DEFAULT_MAX_ENTRIES = 1000`. The
 * capacity guard `survivors.length > maxEntries` therefore compared a value
 * capped at 500 against 1000 and could never be true — the only global bound on
 * the store was dead code and memory grew unbounded.
 *
 * These tests use DEFAULT capacity options only (no `maxEntries`, no
 * `pageSize`), so restoring the single-page scan makes them fail. They do pass
 * the fixture `namespace`: against a namespace-faithful store the root-scope
 * default `[]` scans every namespace but its deletes address `[]`, which a
 * real store treats as a different namespace (DZUPAGENT-TEST-H-09 surfaced
 * this; it is tracked separately, not asserted here).
 */

import { describe, it, expect } from 'vitest'

import { MemoryPruner } from '../memory-pruner.js'
import type { ConsolidationStore } from '../consolidation-engine.js'
import { createStoreDouble } from './helpers/store-double.js'
import type { StoreDouble } from './helpers/store-double.js'

/** Namespace the fixtures live in; the pruner's default scope is every namespace. */
const FIXTURE_NAMESPACE = ['agent', 'memories']

/**
 * Shared InMemoryStore double (DZUPAGENT-TEST-H-09): the real
 * `search(ns, { limit, offset })` contract, namespace prefix and default limit
 * of 10 included, instead of a hand-rolled map that ignored the namespace.
 */
async function makeStore(count: number, now: number): Promise<{
  store: ConsolidationStore
  double: StoreDouble
  items: { count(): Promise<number>; has(key: string): Promise<boolean> }
  searchCalls: Array<{ limit?: number | undefined; offset?: number | undefined }>
}> {
  const double = createStoreDouble()
  for (let i = 0; i < count; i++) {
    const key = `k${String(i).padStart(5, '0')}`
    await double.seed(FIXTURE_NAMESPACE, key, {
      text: `entry ${i}`,
      // All fresh, so the TTL pass is a no-op and only capacity can evict.
      _decay: { createdAt: now - 1000, strength: i / count },
    })
  }
  const items = {
    count: async () => (await double.records()).length,
    has: async (key: string) => (await double.valueOf(key)) !== undefined,
  }
  return {
    store: double.store as unknown as ConsolidationStore,
    double,
    items,
    get searchCalls() {
      return double.search.mock.calls.map(
        ([, options]) => (options ?? {}) as { limit?: number; offset?: number },
      )
    },
  }
}

describe('AGENT-C-09 — capacity pass at default configuration', () => {
  it('evicts down to the default 1000-entry ceiling with no options supplied', async () => {
    const now = Date.UTC(2026, 6, 30)
    const { store, items } = await makeStore(1200, now)

    // Default configuration: only the synthetic clock is injected.
    const result = await new MemoryPruner().prune(store, { now: () => now, namespace: FIXTURE_NAMESPACE })

    expect(result.expired).toBe(0)
    // The whole finding: this was structurally stuck at 0.
    expect(result.evicted).toBe(200)
    expect(result.remaining).toBe(1000)
    expect(await items.count()).toBe(1000)
  })

  it('scans past the default page size — the guard that made the pass dead code', async () => {
    const now = Date.UTC(2026, 6, 30)
    const fixture = await makeStore(1200, now)
    const { store } = fixture

    await new MemoryPruner().prune(store, { now: () => now, namespace: FIXTURE_NAMESPACE })

    // More than one page was requested, and the total observed exceeds
    // DEFAULT_MAX_ENTRIES (1000). A single 500-row page cannot satisfy this.
    const { searchCalls } = fixture
    expect(searchCalls.length).toBeGreaterThan(1)
    expect(searchCalls.some((c) => (c.offset ?? 0) >= 500)).toBe(true)
  })

  it('evicts the weakest entries first', async () => {
    const now = Date.UTC(2026, 6, 30)
    const { store, items } = await makeStore(1050, now)

    await new MemoryPruner().prune(store, { now: () => now, namespace: FIXTURE_NAMESPACE })

    expect(await items.count()).toBe(1000)
    // strength was i/count, so the 50 lowest indices are the weakest.
    expect(await items.has('k00000')).toBe(false)
    expect(await items.has('k00049')).toBe(false)
    expect(await items.has('k00050')).toBe(true)
    expect(await items.has('k01049')).toBe(true)
  })

  it('is a no-op when the store is under the default ceiling', async () => {
    const now = Date.UTC(2026, 6, 30)
    const { store, items } = await makeStore(900, now)

    const result = await new MemoryPruner().prune(store, { now: () => now, namespace: FIXTURE_NAMESPACE })

    expect(result.evicted).toBe(0)
    expect(result.remaining).toBe(900)
    expect(await items.count()).toBe(900)
  })

  it('bounds a single run via maxScan rather than pulling the whole store', async () => {
    const now = Date.UTC(2026, 6, 30)
    const { store } = await makeStore(5000, now)

    const result = await new MemoryPruner().prune(store, {
      now: () => now,
      namespace: FIXTURE_NAMESPACE,
      maxEntries: 100,
      maxScan: 300,
    })

    expect(result.evicted).toBe(200)
    expect(result.remaining).toBe(100)
  })

  it('terminates when the backend ignores offset', async () => {
    const now = Date.UTC(2026, 6, 30)
    const { double } = await makeStore(1200, now)
    const store: ConsolidationStore = {
      async search(ns, options) {
        // Deliberately ignores `offset` — a naive loop would spin forever.
        return double.store.search(ns, { limit: options?.limit ?? 500 })
      },
      async put() {},
      async delete(ns, key) {
        await double.store.delete(ns, key)
      },
    }

    const result = await new MemoryPruner().prune(store, { now: () => now, namespace: FIXTURE_NAMESPACE })

    expect(result.evicted).toBe(0)
    expect(result.remaining).toBe(500)
  })
})
