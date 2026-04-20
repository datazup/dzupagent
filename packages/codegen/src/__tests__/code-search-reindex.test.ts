/**
 * W13-17: CodeSearchService.reindexCollection() extended coverage
 *
 * Tests for the reindexCollection() method which drops and recreates the
 * vector collection, resetting all tracking state (indexedFiles,
 * indexedLanguages, lastIndexedAt).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CodeSearchService } from '../search/code-search-service.js'
import type { IndexStats } from '../search/code-search-types.js'

// ---------------------------------------------------------------------------
// Mock SemanticStore (extended with deleteCollection support)
// ---------------------------------------------------------------------------

interface StoredDoc {
  id: string
  text: string
  metadata: Record<string, unknown>
}

function createMockSemanticStore() {
  const collections = new Map<string, StoredDoc[]>()

  const store = {
    ensureCollection: vi.fn(async (name: string) => {
      if (!collections.has(name)) {
        collections.set(name, [])
      }
    }),
    upsert: vi.fn(async (collection: string, docs: StoredDoc[]) => {
      const existing = collections.get(collection) ?? []
      for (const doc of docs) {
        const idx = existing.findIndex((d) => d.id === doc.id)
        if (idx >= 0) {
          existing[idx] = doc
        } else {
          existing.push(doc)
        }
      }
      collections.set(collection, existing)
    }),
    search: vi.fn(
      async (
        collection: string,
        query: string,
        limit: number,
        _filter?: unknown,
      ) => {
        const docs = collections.get(collection) ?? []
        const queryLower = query.toLowerCase()
        const scored = docs.map((doc) => {
          const textLower = doc.text.toLowerCase()
          const inText = textLower.includes(queryLower) ? 0.8 : 0
          return {
            id: doc.id,
            text: doc.text,
            score: inText,
            metadata: doc.metadata,
          }
        })
        return scored
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
      },
    ),
    delete: vi.fn(async (collection: string, filter: { filter?: { field: string; op: string; value: string } }) => {
      if (!filter.filter) return
      const docs = collections.get(collection) ?? []
      const { field, value } = filter.filter
      const remaining = docs.filter((d) => d.metadata[field] !== value)
      collections.set(collection, remaining)
    }),
    store: {
      count: vi.fn(async (collection: string) => {
        return (collections.get(collection) ?? []).length
      }),
      deleteCollection: vi.fn(async (name: string) => {
        collections.delete(name)
      }),
    },
    _collections: collections,
  }

  return store
}

type MockStore = ReturnType<typeof createMockSemanticStore>

// ---------------------------------------------------------------------------
// Sample source
// ---------------------------------------------------------------------------

const TS_SOURCE = `
export interface User {
  id: string
  name: string
}

export class UserService {
  async getUser(id: string): Promise<User> {
    return { id, name: 'test' }
  }
}
`.trim()

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodeSearchService.reindexCollection', () => {
  let mockStore: MockStore
  let service: CodeSearchService

  beforeEach(async () => {
    mockStore = createMockSemanticStore()
    service = new CodeSearchService(mockStore as never, {
      collectionName: 'test_reindex',
    })
    await service.init()
  })

  it('calls store.store.deleteCollection with the configured collection name', async () => {
    await service.reindexCollection()

    expect(mockStore.store.deleteCollection).toHaveBeenCalledWith('test_reindex')
  })

  it('calls store.ensureCollection after deleting the collection', async () => {
    await service.reindexCollection()

    // ensureCollection is called once on init() and once on reindexCollection()
    expect(mockStore.ensureCollection).toHaveBeenCalledTimes(2)
    const calls = mockStore.ensureCollection.mock.calls
    expect(calls[1]![0]).toBe('test_reindex')
  })

  it('resets totalFiles to 0 after reindexing', async () => {
    await service.indexFile('src/user-service.ts', TS_SOURCE, 'typescript')
    const statsBefore = await service.getStats()
    expect(statsBefore.totalFiles).toBe(1)

    await service.reindexCollection()
    const statsAfter = await service.getStats()
    expect(statsAfter.totalFiles).toBe(0)
  })

  it('resets languages array to empty after reindexing', async () => {
    await service.indexFile('src/app.ts', TS_SOURCE, 'typescript')
    await service.indexFile('src/app.py', 'def foo(): pass', 'python')

    const statsBefore = await service.getStats()
    expect(statsBefore.languages).toContain('typescript')
    expect(statsBefore.languages).toContain('python')

    await service.reindexCollection()
    const statsAfter = await service.getStats()
    expect(statsAfter.languages).toEqual([])
  })

  it('resets lastIndexedAt to null after reindexing', async () => {
    await service.indexFile('src/app.ts', TS_SOURCE, 'typescript')

    const statsBefore = await service.getStats()
    expect(statsBefore.lastIndexedAt).toBeInstanceOf(Date)

    await service.reindexCollection()
    const statsAfter = await service.getStats()
    expect(statsAfter.lastIndexedAt).toBeNull()
  })

  it('getStats returns zero totalChunks after reindexing when store is cleared', async () => {
    await service.indexFile('src/app.ts', TS_SOURCE, 'typescript')

    await service.reindexCollection()
    const stats: IndexStats = await service.getStats()

    // The underlying store's collection was deleted and recreated empty
    expect(stats.totalChunks).toBe(0)
    expect(stats.totalFiles).toBe(0)
  })

  it('allows re-indexing files after reindexCollection()', async () => {
    await service.indexFile('src/app.ts', TS_SOURCE, 'typescript')
    await service.reindexCollection()

    // Should be able to index again without errors
    const count = await service.indexFile('src/app.ts', TS_SOURCE, 'typescript')
    expect(count).toBeGreaterThan(0)

    const stats = await service.getStats()
    expect(stats.totalFiles).toBe(1)
    expect(stats.languages).toContain('typescript')
    expect(stats.lastIndexedAt).toBeInstanceOf(Date)
  })

  it('is idempotent — multiple reindexCollection() calls do not error', async () => {
    await service.reindexCollection()
    await service.reindexCollection()

    const stats = await service.getStats()
    expect(stats.totalFiles).toBe(0)
    expect(stats.languages).toEqual([])
    expect(stats.lastIndexedAt).toBeNull()
  })

  it('uses the default collection name when collectionName is not configured', async () => {
    const defaultStore = createMockSemanticStore()
    const defaultService = new CodeSearchService(defaultStore as never)
    await defaultService.init()

    await defaultService.reindexCollection()

    expect(defaultStore.store.deleteCollection).toHaveBeenCalledWith('code_chunks')
    expect(defaultStore.ensureCollection).toHaveBeenCalledWith('code_chunks')
  })

  it('search returns empty results after reindexCollection() (collection is empty)', async () => {
    await service.indexFile('src/app.ts', TS_SOURCE, 'typescript')

    // Verify search works before
    const resultsBefore = await service.search('UserService')
    expect(resultsBefore.length).toBeGreaterThan(0)

    await service.reindexCollection()

    const resultsAfter = await service.search('UserService')
    expect(resultsAfter).toEqual([])
  })

  it('clears multiple tracked files', async () => {
    await service.indexFile('src/a.ts', TS_SOURCE, 'typescript')
    await service.indexFile('src/b.ts', 'export const b = 2', 'typescript')
    await service.indexFile('src/c.py', 'def c(): pass', 'python')

    const statsBefore = await service.getStats()
    expect(statsBefore.totalFiles).toBe(3)
    expect(statsBefore.languages.length).toBe(2)

    await service.reindexCollection()
    const statsAfter = await service.getStats()
    expect(statsAfter.totalFiles).toBe(0)
    expect(statsAfter.languages).toEqual([])
  })

  it('reindexCollection() on a service that was never used (no files indexed)', async () => {
    // Fresh service, never indexed anything
    await service.reindexCollection()

    const stats = await service.getStats()
    expect(stats.totalFiles).toBe(0)
    expect(stats.languages).toEqual([])
    expect(stats.lastIndexedAt).toBeNull()
    expect(stats.totalChunks).toBe(0)
  })

  it('getStats() reflects fresh state after reindex then partial re-index', async () => {
    // Index two files
    await service.indexFile('src/a.ts', TS_SOURCE, 'typescript')
    await service.indexFile('src/b.py', 'def foo(): pass', 'python')

    // Drop and re-index only one
    await service.reindexCollection()
    await service.indexFile('src/a.ts', TS_SOURCE, 'typescript')

    const stats = await service.getStats()
    expect(stats.totalFiles).toBe(1)
    expect(stats.languages).toContain('typescript')
    expect(stats.languages).not.toContain('python')
  })
})
