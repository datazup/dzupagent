import { describe, it, expect, beforeEach } from 'vitest'
import { createStore, IN_MEMORY_STORE_CAPABILITIES } from '../store-factory.js'
import type { StoreQueryOptions } from '../store-factory.js'
import { getMemoryStoreCapabilities } from '../store-capabilities.js'
import type { BaseStore } from '@langchain/langgraph'

/**
 * Typed helper to call search with query options on the in-memory store.
 * The BaseStore interface does not expose StoreQueryOptions directly,
 * so we use this helper to pass them through.
 */
async function searchWithOptions(
  store: BaseStore,
  namespace: string[],
  options?: StoreQueryOptions,
): Promise<Array<{ namespace: string[]; key: string; value: Record<string, unknown> }>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (store as any).search(namespace, options)
}

describe('InMemoryBaseStore search parity', () => {
  let store: BaseStore

  beforeEach(async () => {
    store = await createStore({ type: 'memory' })
  })

  describe('namespace prefix (baseline)', () => {
    it('returns all records matching namespace prefix', async () => {
      await store.put(['project', 'alpha'], 'r1', { text: 'hello' })
      await store.put(['project', 'alpha'], 'r2', { text: 'world' })
      await store.put(['project', 'beta'], 'r3', { text: 'other' })

      const results = await searchWithOptions(store, ['project'])
      expect(results).toHaveLength(3)
    })

    it('returns only matching namespace', async () => {
      await store.put(['project', 'alpha'], 'r1', { text: 'hello' })
      await store.put(['other', 'namespace'], 'r2', { text: 'world' })

      const results = await searchWithOptions(store, ['project'])
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('r1')
    })
  })

  describe('filter by metadata field equality', () => {
    it('filters records by a single metadata field', async () => {
      await store.put(['ns'], 'r1', { text: 'a', category: 'bug' })
      await store.put(['ns'], 'r2', { text: 'b', category: 'feature' })
      await store.put(['ns'], 'r3', { text: 'c', category: 'bug' })

      const results = await searchWithOptions(store, ['ns'], { filter: { category: 'bug' } })
      expect(results).toHaveLength(2)
      expect(results.map(r => r.key).sort()).toEqual(['r1', 'r3'])
    })

    it('filters by multiple metadata fields (AND semantics)', async () => {
      await store.put(['ns'], 'r1', { text: 'a', category: 'bug', priority: 'high' })
      await store.put(['ns'], 'r2', { text: 'b', category: 'bug', priority: 'low' })
      await store.put(['ns'], 'r3', { text: 'c', category: 'feature', priority: 'high' })

      const results = await searchWithOptions(store, ['ns'], {
        filter: { category: 'bug', priority: 'high' },
      })
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('r1')
    })

    it('returns empty array when no records match filter', async () => {
      await store.put(['ns'], 'r1', { text: 'a', category: 'bug' })

      const results = await searchWithOptions(store, ['ns'], { filter: { category: 'feature' } })
      expect(results).toHaveLength(0)
    })
  })

  describe('substring text query', () => {
    it('matches substring in text field', async () => {
      await store.put(['ns'], 'r1', { text: 'Fix the database connection timeout issue' })
      await store.put(['ns'], 'r2', { text: 'Add new API endpoint for users' })
      await store.put(['ns'], 'r3', { text: 'Database schema migration needed' })

      const results = await searchWithOptions(store, ['ns'], { query: 'database' })
      expect(results).toHaveLength(2)
      expect(results.map(r => r.key).sort()).toEqual(['r1', 'r3'])
    })

    it('matches substring in content field', async () => {
      await store.put(['ns'], 'r1', { content: 'Review the pull request changes' })
      await store.put(['ns'], 'r2', { content: 'Deploy to staging environment' })

      const results = await searchWithOptions(store, ['ns'], { query: 'pull request' })
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('r1')
    })

    it('is case-insensitive', async () => {
      await store.put(['ns'], 'r1', { text: 'TypeScript Migration Guide' })

      const results = await searchWithOptions(store, ['ns'], { query: 'typescript' })
      expect(results).toHaveLength(1)
    })

    it('returns empty when no text matches', async () => {
      await store.put(['ns'], 'r1', { text: 'hello world' })

      const results = await searchWithOptions(store, ['ns'], { query: 'nonexistent' })
      expect(results).toHaveLength(0)
    })

    it('skips records without text or content fields', async () => {
      await store.put(['ns'], 'r1', { count: 42 })
      await store.put(['ns'], 'r2', { text: 'has text query match' })

      const results = await searchWithOptions(store, ['ns'], { query: 'query' })
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('r2')
    })
  })

  describe('combined filter + namespace prefix + query', () => {
    it('applies all filters simultaneously', async () => {
      await store.put(['project', 'alpha'], 'r1', { text: 'Fix database bug', category: 'bug' })
      await store.put(['project', 'alpha'], 'r2', { text: 'Add database feature', category: 'feature' })
      await store.put(['project', 'alpha'], 'r3', { text: 'Fix UI bug', category: 'bug' })
      await store.put(['project', 'beta'], 'r4', { text: 'Fix database bug', category: 'bug' })

      // Namespace: project.alpha + filter: bug + query: database
      const results = await searchWithOptions(store, ['project', 'alpha'], {
        filter: { category: 'bug' },
        query: 'database',
      })
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('r1')
    })
  })

  describe('pagination (limit + offset)', () => {
    it('limits results', async () => {
      for (let i = 0; i < 5; i++) {
        await store.put(['ns'], `r${i}`, { text: `record-${i}` })
      }

      const results = await searchWithOptions(store, ['ns'], { limit: 2 })
      expect(results).toHaveLength(2)
    })

    it('offsets results', async () => {
      for (let i = 0; i < 5; i++) {
        await store.put(['ns'], `r${i}`, { text: `record-${i}` })
      }

      const all = await searchWithOptions(store, ['ns'])
      const offset = await searchWithOptions(store, ['ns'], { offset: 2 })
      expect(offset).toHaveLength(all.length - 2)
    })

    it('supports limit + offset together', async () => {
      for (let i = 0; i < 10; i++) {
        await store.put(['ns'], `r${i}`, { text: `record-${i}` })
      }

      const page = await searchWithOptions(store, ['ns'], { limit: 3, offset: 2 })
      expect(page).toHaveLength(3)
    })
  })

  describe('capability flags reflect limited search', () => {
    it('reports supportsSearchFilters as true', () => {
      const caps = getMemoryStoreCapabilities(store)
      expect(caps.supportsSearchFilters).toBe(true)
    })

    it('reports supportsPagination as true', () => {
      const caps = getMemoryStoreCapabilities(store)
      expect(caps.supportsPagination).toBe(true)
    })

    it('reports supportsDelete as true', () => {
      const caps = getMemoryStoreCapabilities(store)
      expect(caps.supportsDelete).toBe(true)
    })

    it('exposes searchParity as limited on the raw store', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawStore = store as any
      expect(rawStore.searchParity).toBe('limited')
    })

    it('IN_MEMORY_STORE_CAPABILITIES matches the store capabilities', () => {
      const caps = getMemoryStoreCapabilities(store)
      expect(caps).toEqual(IN_MEMORY_STORE_CAPABILITIES)
    })
  })
})
