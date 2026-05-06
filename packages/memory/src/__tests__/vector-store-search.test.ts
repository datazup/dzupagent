import { describe, it, expect, vi } from 'vitest'
import { VectorStoreSearch } from '../retrieval/vector-store-search.js'
import type { VectorSearchProvider } from '../retrieval/vector-search.js'
import type { SemanticStoreAdapter } from '../memory-types.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSemanticResult(id: string, score: number, metadata: Record<string, unknown> = {}) {
  return { id, text: 'sample text', score, metadata }
}

function makeStubAdapter(results: ReturnType<typeof makeSemanticResult>[]): SemanticStoreAdapter {
  return {
    search: vi.fn().mockResolvedValue(results),
    upsert: vi.fn(),
    delete: vi.fn(),
    createCollection: vi.fn(),
  } as unknown as SemanticStoreAdapter
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('VectorStoreSearch', () => {
  describe('collection name derivation', () => {
    it('uses "memory_<namespace>" as default collection name', async () => {
      const adapter = makeStubAdapter([])
      const sut = new VectorStoreSearch(adapter)
      await sut.search(['user123', 'project'], 'query', 5)
      expect(adapter.search).toHaveBeenCalledWith('memory_user123_project', 'query', 5)
    })

    it('prefixes collection name with collectionPrefix when provided', async () => {
      const adapter = makeStubAdapter([])
      const sut = new VectorStoreSearch(adapter, 'custom_')
      await sut.search(['tenantA', 'agent'], 'query', 5)
      expect(adapter.search).toHaveBeenCalledWith('custom_tenantA_agent', 'query', 5)
    })

    it('single-segment namespace produces "memory_<segment>"', async () => {
      const adapter = makeStubAdapter([])
      const sut = new VectorStoreSearch(adapter)
      await sut.search(['globalNs'], 'q', 3)
      expect(adapter.search).toHaveBeenCalledWith('memory_globalNs', 'q', 3)
    })

    it('empty namespace produces "memory_"', async () => {
      const adapter = makeStubAdapter([])
      const sut = new VectorStoreSearch(adapter)
      await sut.search([], 'q', 10)
      expect(adapter.search).toHaveBeenCalledWith('memory_', 'q', 10)
    })
  })

  describe('result mapping', () => {
    it('maps SemanticStoreAdapter results to VectorSearchResult shape', async () => {
      const meta = { origin: 'test', tag: 'unit' }
      const adapter = makeStubAdapter([makeSemanticResult('doc1', 0.88, meta)])
      const sut = new VectorStoreSearch(adapter)
      const results = await sut.search(['ns'], 'query', 10)
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('doc1')
      expect(results[0]!.score).toBeCloseTo(0.88)
      expect(results[0]!.value).toBe(meta)
    })

    it('maps id to key (not copying as id)', async () => {
      const adapter = makeStubAdapter([makeSemanticResult('semantic-id-123', 0.5)])
      const sut = new VectorStoreSearch(adapter)
      const results = await sut.search(['ns'], 'q', 10)
      expect(results[0]!.key).toBe('semantic-id-123')
    })

    it('maps score from the semantic store result', async () => {
      const adapter = makeStubAdapter([
        makeSemanticResult('a', 0.92),
        makeSemanticResult('b', 0.71),
      ])
      const sut = new VectorStoreSearch(adapter)
      const results = await sut.search(['ns'], 'q', 10)
      expect(results[0]!.score).toBeCloseTo(0.92)
      expect(results[1]!.score).toBeCloseTo(0.71)
    })
  })

  describe('edge cases', () => {
    it('returns empty array when adapter returns no results', async () => {
      const adapter = makeStubAdapter([])
      const sut = new VectorStoreSearch(adapter)
      const results = await sut.search(['ns'], 'q', 10)
      expect(results).toEqual([])
    })

    it('passes limit parameter to the adapter', async () => {
      const adapter = makeStubAdapter([])
      const sut = new VectorStoreSearch(adapter)
      await sut.search(['ns'], 'q', 7)
      expect(adapter.search).toHaveBeenCalledWith(expect.any(String), 'q', 7)
    })

    it('passes query string to the adapter unchanged', async () => {
      const adapter = makeStubAdapter([])
      const sut = new VectorStoreSearch(adapter)
      await sut.search(['ns'], 'find relevant memories about auth', 5)
      expect(adapter.search).toHaveBeenCalledWith(
        expect.any(String),
        'find relevant memories about auth',
        5,
      )
    })

    it('implements VectorSearchProvider interface', () => {
      const adapter = makeStubAdapter([])
      const sut: VectorSearchProvider = new VectorStoreSearch(adapter)
      expect(typeof sut.search).toBe('function')
    })
  })

  describe('error propagation', () => {
    it('rejects with the adapter error', async () => {
      const adapter: SemanticStoreAdapter = {
        search: vi.fn().mockRejectedValue(new Error('vector store down')),
        upsert: vi.fn(),
        delete: vi.fn(),
        createCollection: vi.fn(),
      } as unknown as SemanticStoreAdapter
      const sut = new VectorStoreSearch(adapter)
      await expect(sut.search(['ns'], 'q', 10)).rejects.toThrow('vector store down')
    })
  })

  describe('prefix edge cases', () => {
    it('empty prefix and single segment produces "memory_ns"', async () => {
      const adapter = makeStubAdapter([])
      // When collectionPrefix is '' (empty string, falsy), falls back to "memory_"
      const sut = new VectorStoreSearch(adapter, '')
      await sut.search(['ns'], 'q', 5)
      // '' is falsy so falls back to default "memory_<namespace>"
      expect(adapter.search).toHaveBeenCalledWith('memory_ns', 'q', 5)
    })

    it('non-empty prefix joins namespace with underscore', async () => {
      const adapter = makeStubAdapter([])
      const sut = new VectorStoreSearch(adapter, 'agent_')
      await sut.search(['alice', 'workspace'], 'q', 5)
      expect(adapter.search).toHaveBeenCalledWith('agent_alice_workspace', 'q', 5)
    })
  })
})
