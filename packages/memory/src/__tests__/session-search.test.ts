import { describe, it, expect, vi } from 'vitest'
import { SessionSearch, type SessionSearchStore } from '../session-search.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStore(initialData?: {
  [namespace: string]: Record<string, unknown>[]
}): {
  store: SessionSearchStore
  getMock: ReturnType<typeof vi.fn>
  data: { [namespace: string]: Record<string, unknown>[] }
} {
  const data = initialData ? { ...initialData } : {}
  const getMock = vi.fn().mockImplementation(
    (ns: string, _scope: Record<string, string>, key?: string) => {
      const records = data[ns] ?? []
      if (key) return Promise.resolve(records.filter(r => r['key'] === key))
      return Promise.resolve(records)
    },
  )
  const store: SessionSearchStore = { get: getMock }
  return { store, getMock, data }
}

const SCOPE = { tenantId: 't1', projectId: 'p1' }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionSearch', () => {
  describe('constructor and config', () => {
    it('uses default defaultLimit=20 and minScore=0', async () => {
      const { store, data } = createMockStore()
      data.ns1 = Array.from({ length: 30 }, (_, i) => ({
        key: `k${i}`,
        text: `postgres item ${i}`,
      }))
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'postgres' })
      expect(results).toHaveLength(20) // defaultLimit
    })

    it('accepts custom defaultLimit', async () => {
      const { store, data } = createMockStore()
      data.ns1 = Array.from({ length: 30 }, (_, i) => ({
        key: `k${i}`,
        text: `postgres item ${i}`,
      }))
      const search = new SessionSearch(store, { defaultLimit: 5 })
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'postgres' })
      expect(results).toHaveLength(5)
    })

    it('accepts custom minScore', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [
        { key: 'a', text: 'foo bar' },
        { key: 'b', text: 'foo' },
      ]
      const search = new SessionSearch(store, { minScore: 1.0 })
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'foo bar' })
      // Only "foo bar" matches both terms (score 1.0); "foo" matches one (score 0.5)
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('a')
    })

    it('config undefined → all defaults applied', async () => {
      const { store } = createMockStore()
      const search = new SessionSearch(store, undefined)
      const results = await search.search({ text: 'anything' })
      expect(results).toEqual([])
    })

    it('partial config — only defaultLimit set', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'foo' }]
      const search = new SessionSearch(store, { defaultLimit: 1 })
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'foo' })
      expect(results).toHaveLength(1)
    })
  })

  describe('index()', () => {
    it('calls store.get with namespace and scope', async () => {
      const { store, getMock } = createMockStore()
      const search = new SessionSearch(store)
      await search.index('decisions', SCOPE)
      expect(getMock).toHaveBeenCalledWith('decisions', SCOPE)
    })

    it('stores records internally', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [
        { key: 'a', text: 'one' },
        { key: 'b', text: 'two' },
      ]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      expect(search.indexedCount).toBe(2)
    })

    it('indexedCount reflects total across namespaces', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'one' }]
      data.ns2 = [
        { key: 'b', text: 'two' },
        { key: 'c', text: 'three' },
      ]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      await search.index('ns2', SCOPE)
      expect(search.indexedCount).toBe(3)
    })

    it('handles empty namespace (no records)', async () => {
      const { store } = createMockStore({ ns1: [] })
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      expect(search.indexedCount).toBe(0)
    })

    it('re-indexing same namespace overwrites previous data', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'first' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      expect(search.indexedCount).toBe(1)

      // Update store and re-index
      data.ns1 = [
        { key: 'b', text: 'second' },
        { key: 'c', text: 'third' },
      ]
      await search.index('ns1', SCOPE)
      expect(search.indexedCount).toBe(2)

      const results = await search.search({ text: 'first' })
      expect(results).toHaveLength(0) // 'first' is gone
    })
  })

  describe('search() — basic matching', () => {
    it('finds records containing single term (case-insensitive)', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [
        { key: 'a', text: 'PostgreSQL is the database we use' },
        { key: 'b', text: 'Redis is the cache' },
      ]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)

      const results = await search.search({ text: 'postgres' })
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('a')
    })

    it('case-insensitive matching for query', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'we use postgresql' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)

      const r1 = await search.search({ text: 'POSTGRESQL' })
      const r2 = await search.search({ text: 'postgresql' })
      expect(r1).toHaveLength(1)
      expect(r2).toHaveLength(1)
    })

    it('case-insensitive matching for record text', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'POSTGRES is awesome' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'postgres' })
      expect(results).toHaveLength(1)
    })

    it('returns SearchResult with all required fields', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'k1', text: 'hello world' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)

      const results = await search.search({ text: 'hello' })
      expect(results).toHaveLength(1)
      const r = results[0]!
      expect(r.key).toBe('k1')
      expect(r.namespace).toBe('ns1')
      expect(r.scope).toEqual(SCOPE)
      expect(r.value).toEqual({ key: 'k1', text: 'hello world' })
      expect(r.score).toBe(1.0)
      expect(r.matchedTerms).toEqual(['hello'])
    })
  })

  describe('search() — multi-term scoring', () => {
    it('all terms match → score 1.0', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'postgres database is great' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'postgres database' })
      expect(results).toHaveLength(1)
      expect(results[0]!.score).toBe(1.0)
    })

    it('half terms match → score 0.5', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'postgres is great' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'postgres mysql' })
      expect(results).toHaveLength(1)
      expect(results[0]!.score).toBe(0.5)
    })

    it('one of three terms matches → score 1/3', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'postgres only' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'postgres mysql redis' })
      expect(results).toHaveLength(1)
      expect(results[0]!.score).toBeCloseTo(1 / 3, 5)
    })
  })

  describe('search() — empty / whitespace queries', () => {
    it('empty text returns []', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'foo' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: '' })
      expect(results).toEqual([])
    })

    it('whitespace-only text returns []', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'foo' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: '   \t\n  ' })
      expect(results).toEqual([])
    })

    it('single-character term is filtered out → no terms → []', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'foo bar' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'a' })
      expect(results).toEqual([])
    })

    it('all single-char terms filtered → []', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'foo bar baz' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'a b c' })
      expect(results).toEqual([])
    })

    it('mixed single-char and multi-char terms → only multi-char terms matter', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'postgres database' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'a postgres b' })
      expect(results).toHaveLength(1)
      expect(results[0]!.matchedTerms).toEqual(['postgres'])
      // Only 'postgres' counts as a term; score = 1/1 = 1
      expect(results[0]!.score).toBe(1)
    })
  })

  describe('search() — namespace filter', () => {
    it('only searches specified namespaces', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'postgres in ns1' }]
      data.ns2 = [{ key: 'b', text: 'postgres in ns2' }]
      data.ns3 = [{ key: 'c', text: 'postgres in ns3' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      await search.index('ns2', SCOPE)
      await search.index('ns3', SCOPE)

      const results = await search.search({ text: 'postgres', namespaces: ['ns2'] })
      expect(results).toHaveLength(1)
      expect(results[0]!.namespace).toBe('ns2')
    })

    it('searches multiple specified namespaces', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'postgres ns1' }]
      data.ns2 = [{ key: 'b', text: 'postgres ns2' }]
      data.ns3 = [{ key: 'c', text: 'postgres ns3' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      await search.index('ns2', SCOPE)
      await search.index('ns3', SCOPE)

      const results = await search.search({ text: 'postgres', namespaces: ['ns1', 'ns3'] })
      expect(results).toHaveLength(2)
      const namespaces = results.map(r => r.namespace).sort()
      expect(namespaces).toEqual(['ns1', 'ns3'])
    })

    it('namespace filter with non-indexed namespace yields nothing', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'foo' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'foo', namespaces: ['unknown'] })
      expect(results).toEqual([])
    })

    it('default (no namespace filter) searches all indexed namespaces', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'postgres' }]
      data.ns2 = [{ key: 'b', text: 'postgres' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      await search.index('ns2', SCOPE)

      const results = await search.search({ text: 'postgres' })
      expect(results).toHaveLength(2)
    })

    it('empty namespaces array → searches no namespaces (no results)', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'foo' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'foo', namespaces: [] })
      expect(results).toEqual([])
    })
  })

  describe('search() — limit', () => {
    it('returns at most N results', async () => {
      const { store, data } = createMockStore()
      data.ns1 = Array.from({ length: 50 }, (_, i) => ({
        key: `k${i}`,
        text: `postgres ${i}`,
      }))
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)

      const results = await search.search({ text: 'postgres', limit: 5 })
      expect(results).toHaveLength(5)
    })

    it('limit greater than result count returns all results', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [
        { key: 'a', text: 'postgres' },
        { key: 'b', text: 'postgres' },
      ]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'postgres', limit: 100 })
      expect(results).toHaveLength(2)
    })

    it('limit overrides defaultLimit', async () => {
      const { store, data } = createMockStore()
      data.ns1 = Array.from({ length: 30 }, (_, i) => ({
        key: `k${i}`,
        text: `postgres ${i}`,
      }))
      const search = new SessionSearch(store, { defaultLimit: 10 })
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'postgres', limit: 3 })
      expect(results).toHaveLength(3)
    })

    it('limit = 0 returns no results', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'postgres' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'postgres', limit: 0 })
      expect(results).toEqual([])
    })
  })

  describe('search() — minScore', () => {
    it('filters out low-scoring results', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [
        { key: 'all', text: 'postgres database server' },
        { key: 'half', text: 'postgres only' },
      ]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)

      const results = await search.search({ text: 'postgres database', minScore: 0.7 })
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('all')
    })

    it('minScore = 1.0 only returns full matches', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [
        { key: 'a', text: 'foo bar baz' },
        { key: 'b', text: 'foo only' },
      ]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'foo bar', minScore: 1.0 })
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('a')
    })

    it('minScore = 0 returns all matches', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [
        { key: 'a', text: 'foo' },
        { key: 'b', text: 'foo bar baz' },
      ]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'foo bar baz', minScore: 0 })
      expect(results).toHaveLength(2)
    })

    it('minScore overrides config minScore', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [
        { key: 'a', text: 'foo' },
      ]
      const search = new SessionSearch(store, { minScore: 1.0 })
      await search.index('ns1', SCOPE)

      // Default config would filter this out (score 0.5)
      const r1 = await search.search({ text: 'foo bar' })
      expect(r1).toHaveLength(0)

      // Per-query override allows it
      const r2 = await search.search({ text: 'foo bar', minScore: 0.4 })
      expect(r2).toHaveLength(1)
    })
  })

  describe('search() — score ordering', () => {
    it('returns highest-score results first', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [
        { key: 'half', text: 'postgres only' },
        { key: 'full', text: 'postgres database server fast' },
        { key: 'third', text: 'postgres only' },
      ]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'postgres database' })
      expect(results[0]!.key).toBe('full')
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score)
    })

    it('preserves stable order for equal scores', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [
        { key: 'a', text: 'postgres' },
        { key: 'b', text: 'postgres' },
        { key: 'c', text: 'postgres' },
      ]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'postgres' })
      expect(results).toHaveLength(3)
      // All have same score
      expect(results.every(r => r.score === results[0]!.score)).toBe(true)
    })
  })

  describe('search() — matchedTerms', () => {
    it('correctly lists which terms matched', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'postgres database is fast' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'postgres mysql database' })
      expect(results).toHaveLength(1)
      expect(results[0]!.matchedTerms.sort()).toEqual(['database', 'postgres'])
    })

    it('matchedTerms only includes lowercase forms', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'POSTGRES' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'POSTGRES' })
      expect(results[0]!.matchedTerms).toEqual(['postgres'])
    })

    it('matchedTerms reflects partial overlap correctly', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'use vue 3 with composition api' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'vue react composition' })
      expect(results).toHaveLength(1)
      expect(results[0]!.matchedTerms.sort()).toEqual(['composition', 'vue'])
    })
  })

  describe('search() — no matches and edge cases', () => {
    it('returns [] when no records match', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'redis cache' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'postgres' })
      expect(results).toEqual([])
    })

    it('returns [] when searching un-indexed namespace', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'postgres' }]
      const search = new SessionSearch(store)
      // Did not call index()
      const results = await search.search({ text: 'postgres' })
      expect(results).toEqual([])
    })

    it('returns [] from named namespace without index', async () => {
      const { store } = createMockStore()
      const search = new SessionSearch(store)
      const results = await search.search({ text: 'postgres', namespaces: ['ghost'] })
      expect(results).toEqual([])
    })
  })

  describe('record key extraction', () => {
    it('uses value["key"] as SearchResult.key', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'my-special-key', text: 'something' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'something' })
      expect(results[0]!.key).toBe('my-special-key')
    })

    it('returns empty string when key is missing', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ text: 'no key here' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'no key' })
      expect(results[0]!.key).toBe('')
    })

    it('coerces non-string key to string', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 42, text: 'numeric key' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'numeric' })
      expect(results[0]!.key).toBe('42')
    })
  })

  describe('text extraction from record', () => {
    it('all string values concatenated for matching', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [
        {
          key: 'a',
          title: 'PostgreSQL',
          description: 'fast database',
          tag: 'production',
        },
      ]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)

      // Match against title
      const r1 = await search.search({ text: 'postgresql' })
      expect(r1).toHaveLength(1)

      // Match against description
      const r2 = await search.search({ text: 'database' })
      expect(r2).toHaveLength(1)

      // Match against tag
      const r3 = await search.search({ text: 'production' })
      expect(r3).toHaveLength(1)
    })

    it('non-string values are ignored in text extraction', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [
        {
          key: 'a',
          text: 'postgres only',
          count: 42,
          active: true,
          meta: { nested: 'value' },
        },
      ]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)

      // Should match 'postgres' from text
      const r1 = await search.search({ text: 'postgres' })
      expect(r1).toHaveLength(1)

      // Should NOT match nested value from object
      const r2 = await search.search({ text: 'nested' })
      expect(r2).toHaveLength(0)

      // Numeric/bool not searchable
      const r3 = await search.search({ text: '42' })
      expect(r3).toHaveLength(0)
    })

    it('record with no string values produces no matches', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ count: 1, active: true }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const results = await search.search({ text: 'count' })
      expect(results).toEqual([])
    })
  })

  describe('invalidate()', () => {
    it('invalidate(ns) removes that namespace from index', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'foo' }]
      data.ns2 = [{ key: 'b', text: 'bar' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      await search.index('ns2', SCOPE)
      expect(search.indexedCount).toBe(2)

      search.invalidate('ns1')
      expect(search.indexedCount).toBe(1)
      const results = await search.search({ text: 'foo' })
      expect(results).toEqual([])
    })

    it('invalidate(ns) leaves other namespaces intact', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'foo' }]
      data.ns2 = [{ key: 'b', text: 'bar' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      await search.index('ns2', SCOPE)
      search.invalidate('ns1')

      const results = await search.search({ text: 'bar' })
      expect(results).toHaveLength(1)
      expect(results[0]!.namespace).toBe('ns2')
    })

    it('invalidate() with no args clears entire index', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'foo' }]
      data.ns2 = [{ key: 'b', text: 'bar' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      await search.index('ns2', SCOPE)
      expect(search.indexedCount).toBe(2)

      search.invalidate()
      expect(search.indexedCount).toBe(0)
    })

    it('invalidate of unknown namespace is a no-op', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'foo' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      expect(() => search.invalidate('unknown')).not.toThrow()
      expect(search.indexedCount).toBe(1)
    })

    it('search after invalidate yields no results from cleared namespace', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'postgres' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      search.invalidate()
      const results = await search.search({ text: 'postgres' })
      expect(results).toEqual([])
    })

    it('store.get is called again on next index() after invalidate', async () => {
      const { store, getMock, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'foo' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      const callsAfterFirstIndex = getMock.mock.calls.length

      search.invalidate('ns1')
      await search.index('ns1', SCOPE)
      expect(getMock.mock.calls.length).toBe(callsAfterFirstIndex + 1)
    })
  })

  describe('indexedCount getter', () => {
    it('is 0 initially', () => {
      const { store } = createMockStore()
      const search = new SessionSearch(store)
      expect(search.indexedCount).toBe(0)
    })

    it('increments after index()', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [
        { key: 'a', text: 'one' },
        { key: 'b', text: 'two' },
      ]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      expect(search.indexedCount).toBe(2)
    })

    it('decrements after invalidate', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'one' }]
      data.ns2 = [{ key: 'b', text: 'two' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      await search.index('ns2', SCOPE)
      expect(search.indexedCount).toBe(2)

      search.invalidate('ns1')
      expect(search.indexedCount).toBe(1)

      search.invalidate('ns2')
      expect(search.indexedCount).toBe(0)
    })

    it('reflects re-index correctly', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'one' }]
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      expect(search.indexedCount).toBe(1)

      // Re-index with more records
      data.ns1 = [
        { key: 'a', text: 'one' },
        { key: 'b', text: 'two' },
        { key: 'c', text: 'three' },
      ]
      await search.index('ns1', SCOPE)
      expect(search.indexedCount).toBe(3)
    })
  })

  describe('multi-namespace integration', () => {
    it('indexes and searches N namespaces simultaneously', async () => {
      const { store, data } = createMockStore()
      data.decisions = [{ key: 'd1', text: 'use postgres' }]
      data.lessons = [{ key: 'l1', text: 'always backup postgres' }]
      data.observations = [{ key: 'o1', text: 'team prefers postgres' }]
      const search = new SessionSearch(store)
      await search.index('decisions', SCOPE)
      await search.index('lessons', SCOPE)
      await search.index('observations', SCOPE)

      const results = await search.search({ text: 'postgres' })
      expect(results).toHaveLength(3)
      const namespaces = results.map(r => r.namespace).sort()
      expect(namespaces).toEqual(['decisions', 'lessons', 'observations'])
    })

    it('search across multiple namespaces respects limit', async () => {
      const { store, data } = createMockStore()
      data.ns1 = Array.from({ length: 5 }, (_, i) => ({ key: `a${i}`, text: 'postgres' }))
      data.ns2 = Array.from({ length: 5 }, (_, i) => ({ key: `b${i}`, text: 'postgres' }))
      const search = new SessionSearch(store)
      await search.index('ns1', SCOPE)
      await search.index('ns2', SCOPE)
      const results = await search.search({ text: 'postgres', limit: 4 })
      expect(results).toHaveLength(4)
    })
  })

  describe('scope handling', () => {
    it('different scopes produce different indices', async () => {
      const { store, getMock, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'foo' }]
      const search = new SessionSearch(store)

      const scope1 = { tenantId: 't1' }
      const scope2 = { tenantId: 't2' }

      await search.index('ns1', scope1)
      await search.index('ns1', scope2) // Re-index with different scope

      // Both calls were made
      expect(getMock.mock.calls.length).toBe(2)
      expect(getMock.mock.calls[0]![1]).toEqual(scope1)
      expect(getMock.mock.calls[1]![1]).toEqual(scope2)
    })

    it('scope is preserved in SearchResult', async () => {
      const { store, data } = createMockStore()
      data.ns1 = [{ key: 'a', text: 'foo' }]
      const search = new SessionSearch(store)
      const customScope = { userId: 'u42', orgId: 'org7' }
      await search.index('ns1', customScope)
      const results = await search.search({ text: 'foo' })
      expect(results[0]!.scope).toEqual(customScope)
    })
  })
})
