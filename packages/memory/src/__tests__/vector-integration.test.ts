import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryService } from '../memory-service.js'
import { VectorStoreSearch } from '../retrieval/vector-store-search.js'
import { ConventionExtractor } from '../convention/convention-extractor.js'
import type { SemanticStoreAdapter } from '../memory-types.js'
import type { NamespaceConfig } from '../memory-types.js'
import type { BaseStore } from '@langchain/langgraph'

// ─── Mock BaseStore ─────────────────────────────────────────────────────────

interface StoreItem {
  namespace: string[]
  key: string
  value: Record<string, unknown>
}

function createMockBaseStore() {
  const data: StoreItem[] = []

  return {
    put: vi.fn(async (namespace: string[], key: string, value: Record<string, unknown>) => {
      const idx = data.findIndex(d => d.key === key && arrEq(d.namespace, namespace))
      if (idx >= 0) {
        data[idx] = { namespace, key, value }
      } else {
        data.push({ namespace, key, value })
      }
    }),
    get: vi.fn(async (namespace: string[], key: string) => {
      const found = data.find(d => d.key === key && arrEq(d.namespace, namespace))
      return found ? { key: found.key, value: found.value } : null
    }),
    search: vi.fn(async (namespace: string[], _opts?: { query?: string; limit?: number }) => {
      return data
        .filter(d => arrEq(d.namespace, namespace))
        .map(d => ({ key: d.key, value: d.value }))
    }),
    _data: data,
  }
}

function arrEq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

// ─── Mock SemanticStoreAdapter ───────────────────────────────────────────────

function createMockSemanticStore(): SemanticStoreAdapter & {
  search: ReturnType<typeof vi.fn>
  upsert: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  ensureCollection: ReturnType<typeof vi.fn>
} {
  return {
    search: vi.fn(async () => []),
    upsert: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    ensureCollection: vi.fn(async () => undefined),
  }
}

// ─── Namespace configs ──────────────────────────────────────────────────────

const NAMESPACES: NamespaceConfig[] = [
  { name: 'lessons', scopeKeys: ['tenantId', 'lessons'], searchable: true },
  { name: 'decisions', scopeKeys: ['projectId', 'decisions'], searchable: false },
  { name: '__conventions', scopeKeys: ['scope'], searchable: false },
]

// ─── MemoryService + SemanticStore ──────────────────────────────────────────

describe('MemoryService with SemanticStore (VEC-009)', () => {
  let store: ReturnType<typeof createMockBaseStore>
  let semanticStore: ReturnType<typeof createMockSemanticStore>
  let svc: MemoryService

  beforeEach(() => {
    store = createMockBaseStore()
    semanticStore = createMockSemanticStore()
     
    svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
      semanticStore,
    })
  })

  it('auto-indexes into SemanticStore on put() for searchable namespaces', async () => {
    await svc.put('lessons', { tenantId: 't1', lessons: 'lessons' }, 'lesson-1', {
      text: 'Always validate user input',
    })

    expect(semanticStore.upsert).toHaveBeenCalledOnce()
    expect(semanticStore.upsert).toHaveBeenCalledWith('memory_lessons', [
      {
        id: 'lesson-1',
        text: 'Always validate user input',
        metadata: { namespace: 'lessons', tenantId: 't1', lessons: 'lessons' },
      },
    ])
  })

  it('does NOT auto-index non-searchable namespaces', async () => {
    await svc.put('decisions', { projectId: 'p1', decisions: 'decisions' }, 'dec-1', {
      text: 'Use PostgreSQL for persistence',
    })

    expect(semanticStore.upsert).not.toHaveBeenCalled()
  })

  it('put() succeeds even when SemanticStore upsert fails', async () => {
    semanticStore.upsert.mockRejectedValueOnce(new Error('Vector DB down'))

    await svc.put('lessons', { tenantId: 't1', lessons: 'lessons' }, 'lesson-2', {
      text: 'Handle errors gracefully',
    })

    // BaseStore should still have the record
    expect(store.put).toHaveBeenCalledOnce()
  })

  it('search() fuses keyword + vector results via RRF', async () => {
    // Pre-populate the keyword store with results
    store.search.mockResolvedValueOnce([
      { key: 'a', value: { text: 'Result A from keyword' } },
      { key: 'b', value: { text: 'Result B from keyword' } },
    ])

    // SemanticStore returns overlapping + new results
    semanticStore.search.mockResolvedValueOnce([
      { id: 'b', text: 'Result B from vector', score: 0.95, metadata: { text: 'Result B from vector' } },
      { id: 'c', text: 'Result C from vector', score: 0.80, metadata: { text: 'Result C from vector' } },
    ])

    const results = await svc.search('lessons', { tenantId: 't1', lessons: 'lessons' }, 'test query', 5)

    // 'b' appears in both lists so should have highest RRF score
    expect(results.length).toBe(3) // a, b, c
    // b should be first (appears in both keyword rank 1 and vector rank 0)
    expect(results[0]).toEqual(expect.objectContaining({ text: 'Result B from keyword' }))
  })

  it('search() falls back to keyword-only when vector search fails', async () => {
    store.search.mockResolvedValueOnce([
      { key: 'a', value: { text: 'Result A' } },
    ])
    semanticStore.search.mockRejectedValueOnce(new Error('Vector DB down'))

    const results = await svc.search('lessons', { tenantId: 't1', lessons: 'lessons' }, 'query', 5)

    expect(results.length).toBe(1)
    expect(results[0]).toEqual(expect.objectContaining({ text: 'Result A' }))
  })
})

describe('MemoryService without SemanticStore (backward compat)', () => {
  it('search() works identically without semanticStore', async () => {
    const store = createMockBaseStore()
     
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, { rejectUnsafe: false })

    store.search.mockResolvedValueOnce([
      { key: 'x', value: { text: 'Result X' } },
    ])

    const results = await svc.search('lessons', { tenantId: 't1', lessons: 'lessons' }, 'query', 5)

    expect(results.length).toBe(1)
    expect(results[0]).toEqual(expect.objectContaining({ text: 'Result X' }))
  })

  it('put() does NOT call any vector operations', async () => {
    const store = createMockBaseStore()
     
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, { rejectUnsafe: false })

    await svc.put('lessons', { tenantId: 't1', lessons: 'lessons' }, 'lesson-1', {
      text: 'Test',
    })

    // Only baseStore.put should be called — no vector operations
    expect(store.put).toHaveBeenCalledOnce()
  })
})

// ─── VectorStoreSearch (VEC-010) ────────────────────────────────────────────

describe('VectorStoreSearch', () => {
  it('delegates search to SemanticStoreAdapter', async () => {
    const semanticStore = createMockSemanticStore()
    semanticStore.search.mockResolvedValueOnce([
      { id: 'doc-1', text: 'First result', score: 0.92, metadata: { ns: 'test' } },
      { id: 'doc-2', text: 'Second result', score: 0.78, metadata: { ns: 'test' } },
    ])

    const provider = new VectorStoreSearch(semanticStore)
    const results = await provider.search(['memories', 'lessons'], 'test query', 10)

    expect(semanticStore.search).toHaveBeenCalledWith('memory_memories_lessons', 'test query', 10)
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ key: 'doc-1', score: 0.92, value: { ns: 'test' } })
    expect(results[1]).toEqual({ key: 'doc-2', score: 0.78, value: { ns: 'test' } })
  })

  it('uses custom collection prefix when provided', async () => {
    const semanticStore = createMockSemanticStore()
    semanticStore.search.mockResolvedValueOnce([])

    const provider = new VectorStoreSearch(semanticStore, 'custom_')
    await provider.search(['tenant', 'data'], 'query', 5)

    expect(semanticStore.search).toHaveBeenCalledWith('custom_tenant_data', 'query', 5)
  })

  it('returns VectorSearchResult shape', async () => {
    const semanticStore = createMockSemanticStore()
    semanticStore.search.mockResolvedValueOnce([
      { id: 'r1', text: 'text', score: 0.5, metadata: { a: 1 } },
    ])

    const provider = new VectorStoreSearch(semanticStore)
    const results = await provider.search(['ns'], 'q', 1)

    const result = results[0]!
    expect(result).toHaveProperty('key')
    expect(result).toHaveProperty('score')
    expect(result).toHaveProperty('value')
    expect(typeof result.key).toBe('string')
    expect(typeof result.score).toBe('number')
    expect(typeof result.value).toBe('object')
  })
})

// ─── Convention Extractor + SemanticStore (VEC-012) ─────────────────────────

describe('ConventionExtractor with SemanticStore (VEC-012)', () => {
  let store: ReturnType<typeof createMockBaseStore>
  let semanticStore: ReturnType<typeof createMockSemanticStore>
  let memorySvc: MemoryService
  let extractor: ConventionExtractor

  beforeEach(() => {
    store = createMockBaseStore()
    semanticStore = createMockSemanticStore()
     
    memorySvc = new MemoryService(store as unknown as BaseStore, NAMESPACES, { rejectUnsafe: false })
    extractor = new ConventionExtractor({
      memoryService: memorySvc,
      semanticStore,
      namespace: '__conventions',
    })
  })

  it('auto-embeds conventions after analyzeCode()', async () => {
    const files = [
      {
        path: 'test.ts',
        content: `
          const myVar = 1
          const anotherVar = 2
          class MyClass {}
          import { foo } from './bar.js'
        `,
      },
    ]

    await extractor.analyzeCode(files)

    // Should have called upsert on the 'conventions' collection
    expect(semanticStore.upsert).toHaveBeenCalled()
    const call = semanticStore.upsert.mock.calls[0]!
    expect(call[0]).toBe('conventions')
    // Should be an array of convention docs
    const docs = call[1] as Array<{ id: string; text: string; metadata: Record<string, unknown> }>
    expect(docs.length).toBeGreaterThan(0)
    for (const doc of docs) {
      expect(doc).toHaveProperty('id')
      expect(doc).toHaveProperty('text')
      expect(doc).toHaveProperty('metadata')
      expect(doc.metadata).toHaveProperty('category')
    }
  })

  it('getConventions with query uses semantic ranking', async () => {
    // Pre-populate 3 conventions in the store
    const conventions = [
      { id: 'c1', name: 'camelCase', category: 'naming', description: 'Use camelCase', pattern: '', examples: [], confidence: 0.8, occurrences: 5, text: 'camelCase: Use camelCase' },
      { id: 'c2', name: 'PascalCase', category: 'naming', description: 'Use PascalCase for classes', pattern: '', examples: [], confidence: 0.7, occurrences: 3, text: 'PascalCase: Use PascalCase for classes' },
      { id: 'c3', name: 'ESM imports', category: 'imports', description: 'Use ESM .js extensions', pattern: '', examples: [], confidence: 0.9, occurrences: 10, text: 'ESM imports: Use ESM .js extensions' },
    ]

    for (const c of conventions) {
      await memorySvc.put('__conventions', { scope: 'conventions' }, c.id, c)
    }

    // Semantic search returns c3 first, then c1
    semanticStore.search.mockResolvedValueOnce([
      { id: 'c3', text: 'ESM imports', score: 0.95, metadata: { category: 'imports' } },
      { id: 'c1', text: 'camelCase', score: 0.60, metadata: { category: 'naming' } },
    ])

    const result = await extractor.getConventions({ query: 'import paths' })

    // c3 should be first due to semantic ranking
    expect(result.length).toBe(3)
    expect(result[0]!.id).toBe('c3')
    expect(result[1]!.id).toBe('c1')
    expect(result[2]!.id).toBe('c2')
  })

  it('getConventions without query returns normal order (no semantic ranking)', async () => {
    const conventions = [
      { id: 'c1', name: 'camelCase', category: 'naming', description: 'Use camelCase', confidence: 0.8, occurrences: 5, text: 'test' },
      { id: 'c2', name: 'PascalCase', category: 'naming', description: 'Use PascalCase', confidence: 0.7, occurrences: 3, text: 'test' },
    ]

    for (const c of conventions) {
      await memorySvc.put('__conventions', { scope: 'conventions' }, c.id, c)
    }

    const result = await extractor.getConventions()

    // Should not call semantic search
    expect(semanticStore.search).not.toHaveBeenCalled()
    expect(result.length).toBe(2)
  })

  it('getConventions with query gracefully handles semantic search failure', async () => {
    const conventions = [
      { id: 'c1', name: 'camelCase', category: 'naming', description: 'Use camelCase', confidence: 0.8, occurrences: 5, text: 'test' },
    ]

    for (const c of conventions) {
      await memorySvc.put('__conventions', { scope: 'conventions' }, c.id, c)
    }

    semanticStore.search.mockRejectedValueOnce(new Error('Vector DB down'))

    const result = await extractor.getConventions({ query: 'naming' })

    // Should still return conventions even though semantic search failed
    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe('c1')
  })

  it('analyzeCode succeeds even when semantic upsert fails', async () => {
    semanticStore.upsert.mockRejectedValueOnce(new Error('Vector DB down'))

    const files = [
      {
        path: 'test.ts',
        content: `
          const myVar = 1
          const anotherVar = 2
          class MyClass {}
        `,
      },
    ]

    const result = await extractor.analyzeCode(files)

    // Should still return detected conventions
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('ConventionExtractor without SemanticStore (backward compat)', () => {
  it('getConventions ignores query param when no semanticStore', async () => {
    const store = createMockBaseStore()
     
    const memorySvc = new MemoryService(store as unknown as BaseStore, NAMESPACES, { rejectUnsafe: false })
    const extractor = new ConventionExtractor({
      memoryService: memorySvc,
      namespace: '__conventions',
      // No semanticStore
    })

    const conventions = [
      { id: 'c1', name: 'camelCase', category: 'naming', description: 'test', confidence: 0.8, occurrences: 1, text: 'test' },
    ]
    for (const c of conventions) {
      await memorySvc.put('__conventions', { scope: 'conventions' }, c.id, c)
    }

    // Should work fine without errors even with query param
    const result = await extractor.getConventions({ query: 'some query' })
    expect(result.length).toBe(1)
  })
})
