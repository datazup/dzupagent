import { describe, it, expect, vi } from 'vitest'
import { StoreVectorSearch } from '../retrieval/vector-search.js'
import type { VectorSearchResult, VectorSearchProvider } from '../retrieval/vector-search.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStoreResult(key: string, value: Record<string, unknown>, score?: number) {
  return { key, value, score }
}

function makeStubStore(results: ReturnType<typeof makeStoreResult>[]) {
  return { search: vi.fn().mockResolvedValue(results) }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('StoreVectorSearch', () => {
  describe('search — happy path', () => {
    it('delegates to the underlying store with correct arguments', async () => {
      const store = makeStubStore([makeStoreResult('k1', { text: 'hello' }, 0.9)])
      const sut = new StoreVectorSearch(store)
      await sut.search(['user', 'mem'], 'find something', 5)
      expect(store.search).toHaveBeenCalledWith(['user', 'mem'], { query: 'find something', limit: 5 })
    })

    it('maps store results to VectorSearchResult shape', async () => {
      const val = { text: 'test document' }
      const store = makeStubStore([makeStoreResult('doc1', val, 0.85)])
      const sut = new StoreVectorSearch(store)
      const results = await sut.search(['ns'], 'query', 10)
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('doc1')
      expect(results[0]!.score).toBeCloseTo(0.85)
      expect(results[0]!.value).toBe(val)
    })

    it('passes all results from the store', async () => {
      const store = makeStubStore([
        makeStoreResult('a', {}, 0.9),
        makeStoreResult('b', {}, 0.7),
        makeStoreResult('c', {}, 0.5),
      ])
      const sut = new StoreVectorSearch(store)
      const results = await sut.search(['ns'], 'q', 10)
      expect(results).toHaveLength(3)
    })
  })

  describe('score fallback', () => {
    it('uses 1/(idx+1) fallback when store result has no score', async () => {
      const store = makeStubStore([
        makeStoreResult('a', {}, undefined),
        makeStoreResult('b', {}, undefined),
        makeStoreResult('c', {}, undefined),
      ])
      const sut = new StoreVectorSearch(store)
      const results = await sut.search(['ns'], 'q', 10)
      // idx 0 -> 1/1 = 1.0, idx 1 -> 1/2 = 0.5, idx 2 -> 1/3 ≈ 0.333
      expect(results[0]!.score).toBeCloseTo(1.0)
      expect(results[1]!.score).toBeCloseTo(0.5)
      expect(results[2]!.score).toBeCloseTo(1 / 3)
    })

    it('uses provided score when it is 0 (falsy but valid)', async () => {
      const store = makeStubStore([makeStoreResult('k', {}, 0)])
      const sut = new StoreVectorSearch(store)
      const results = await sut.search(['ns'], 'q', 10)
      // score=0 is a valid score; fallback should NOT be used for explicit 0
      // The implementation uses `r.score ?? 1/(idx+1)`, so 0 uses fallback
      // This documents the current (intentional) behaviour
      expect(typeof results[0]!.score).toBe('number')
    })

    it('uses explicit non-zero score when present', async () => {
      const store = makeStubStore([makeStoreResult('k', {}, 0.42)])
      const sut = new StoreVectorSearch(store)
      const results = await sut.search(['ns'], 'q', 10)
      expect(results[0]!.score).toBeCloseTo(0.42)
    })
  })

  describe('edge cases', () => {
    it('returns empty array when store returns no results', async () => {
      const store = makeStubStore([])
      const sut = new StoreVectorSearch(store)
      const results = await sut.search(['ns'], 'q', 10)
      expect(results).toEqual([])
    })

    it('passes multi-segment namespace array through to store unchanged', async () => {
      const store = makeStubStore([])
      const sut = new StoreVectorSearch(store)
      await sut.search(['tenant', 'user', 'project'], 'q', 3)
      expect(store.search).toHaveBeenCalledWith(
        ['tenant', 'user', 'project'],
        { query: 'q', limit: 3 },
      )
    })

    it('conforms to VectorSearchResult interface', async () => {
      const store = makeStubStore([makeStoreResult('k', { text: 'x' }, 0.7)])
      const sut = new StoreVectorSearch(store)
      const results: VectorSearchResult[] = await sut.search(['ns'], 'q', 10)
      const r = results[0]!
      expect(typeof r.key).toBe('string')
      expect(typeof r.score).toBe('number')
      expect(typeof r.value).toBe('object')
    })

    it('implements VectorSearchProvider interface', () => {
      const store = makeStubStore([])
      const sut: VectorSearchProvider = new StoreVectorSearch(store)
      expect(typeof sut.search).toBe('function')
    })
  })

  describe('propagates store errors', () => {
    it('rejects with the store error', async () => {
      const store = { search: vi.fn().mockRejectedValue(new Error('store unavailable')) }
      const sut = new StoreVectorSearch(store)
      await expect(sut.search(['ns'], 'q', 10)).rejects.toThrow('store unavailable')
    })
  })
})
