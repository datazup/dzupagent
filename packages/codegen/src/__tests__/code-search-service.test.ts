import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CodeSearchService } from '../search/code-search-service.js'
import type { IndexResult, IndexStats, CodeSearchResult } from '../search/code-search-types.js'

// ---------------------------------------------------------------------------
// Mock SemanticStore
// ---------------------------------------------------------------------------

interface StoredDoc {
  id: string
  text: string
  metadata: Record<string, unknown>
}

/**
 * Minimal mock that satisfies the SemanticStore interface used by CodeSearchService.
 * Stores documents in-memory and performs naive keyword matching for search.
 */
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

        // Naive scoring: count occurrences of query terms
        const scored = docs.map((doc) => {
          const textLower = doc.text.toLowerCase()
          const metaStr = JSON.stringify(doc.metadata).toLowerCase()
          const inText = textLower.includes(queryLower) ? 0.8 : 0
          const inMeta = metaStr.includes(queryLower) ? 0.2 : 0
          return {
            id: doc.id,
            text: doc.text,
            score: inText + inMeta,
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
      const remaining = docs.filter((d) => {
        const metaVal = d.metadata[field]
        return metaVal !== value
      })
      collections.set(collection, remaining)
    }),
    store: {
      count: vi.fn(async (collection: string) => {
        return (collections.get(collection) ?? []).length
      }),
    },
    // Expose internal state for assertions
    _collections: collections,
  }

  return store
}

type MockStore = ReturnType<typeof createMockSemanticStore>

// ---------------------------------------------------------------------------
// Sample source files
// ---------------------------------------------------------------------------

const TS_SOURCE = `
import { Router } from 'express'

export interface User {
  id: string
  name: string
  email: string
}

export class UserService {
  private db: Database

  constructor(db: Database) {
    this.db = db
  }

  async getUser(id: string): Promise<User> {
    return this.db.query('SELECT * FROM users WHERE id = $1', [id])
  }

  async createUser(data: Partial<User>): Promise<User> {
    return this.db.query('INSERT INTO users ...')
  }
}

export function createRouter(service: UserService): Router {
  const router = Router()
  return router
}
`.trim()

const TS_SOURCE_2 = `
export function authenticate(token: string): boolean {
  return token === 'valid'
}

export class AuthGuard {
  check(req: Request): boolean {
    const token = req.headers['authorization']
    return authenticate(String(token))
  }
}
`.trim()

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodeSearchService', () => {
  let mockStore: MockStore
  let service: CodeSearchService

  beforeEach(async () => {
    mockStore = createMockSemanticStore()
    // Cast to satisfy the SemanticStore type — our mock covers the methods used
    service = new CodeSearchService(mockStore as never, {
      collectionName: 'test_code',
    })
    await service.init()
  })

  describe('init', () => {
    it('ensures the collection exists', () => {
      expect(mockStore.ensureCollection).toHaveBeenCalledWith('test_code')
    })

    it('uses default collection name when not configured', async () => {
      const defaultStore = createMockSemanticStore()
      const defaultService = new CodeSearchService(defaultStore as never)
      await defaultService.init()
      expect(defaultStore.ensureCollection).toHaveBeenCalledWith('code_chunks')
    })
  })

  describe('indexFile', () => {
    it('creates chunks with correct metadata', async () => {
      const count = await service.indexFile('src/user-service.ts', TS_SOURCE, 'typescript')

      expect(count).toBeGreaterThan(0)
      expect(mockStore.upsert).toHaveBeenCalledWith(
        'test_code',
        expect.arrayContaining([
          expect.objectContaining({
            id: expect.any(String),
            text: expect.any(String),
            metadata: expect.objectContaining({
              filePath: 'src/user-service.ts',
              language: 'typescript',
              startLine: expect.any(Number),
              endLine: expect.any(Number),
              symbols: expect.any(String),
              symbolKinds: expect.any(String),
              chunkId: expect.any(String),
            }),
          }),
        ]),
      )
    })

    it('returns 0 for empty content', async () => {
      const count = await service.indexFile('src/empty.ts', '', 'typescript')
      expect(count).toBe(0)
    })

    it('auto-detects language from file extension', async () => {
      const count = await service.indexFile('src/app.ts', TS_SOURCE)

      expect(count).toBeGreaterThan(0)

      // Verify metadata has typescript as language
      const upsertCall = mockStore.upsert.mock.calls[0] as [string, StoredDoc[]]
      const firstDoc = upsertCall[1][0]
      expect(firstDoc?.metadata.language).toBe('typescript')
    })

    it('stores symbol names as JSON in metadata', async () => {
      await service.indexFile('src/user-service.ts', TS_SOURCE, 'typescript')

      const upsertCall = mockStore.upsert.mock.calls[0] as [string, StoredDoc[]]
      const docs = upsertCall[1]

      // At least one chunk should have symbols
      const chunksWithSymbols = docs.filter((d) => {
        const symbols = JSON.parse(String(d.metadata.symbols)) as string[]
        return symbols.length > 0
      })
      expect(chunksWithSymbols.length).toBeGreaterThan(0)
    })

    it('stores symbol kinds as JSON in metadata', async () => {
      await service.indexFile('src/user-service.ts', TS_SOURCE, 'typescript')

      const upsertCall = mockStore.upsert.mock.calls[0] as [string, StoredDoc[]]
      const docs = upsertCall[1]

      const chunksWithKinds = docs.filter((d) => {
        const kinds = JSON.parse(String(d.metadata.symbolKinds)) as string[]
        return kinds.length > 0
      })
      expect(chunksWithKinds.length).toBeGreaterThan(0)
    })
  })

  describe('indexFiles', () => {
    it('indexes multiple files and returns aggregate result', async () => {
      const result: IndexResult = await service.indexFiles([
        { filePath: 'src/user-service.ts', content: TS_SOURCE, language: 'typescript' },
        { filePath: 'src/auth.ts', content: TS_SOURCE_2, language: 'typescript' },
      ])

      expect(result.filesIndexed).toBe(2)
      expect(result.chunksCreated).toBeGreaterThan(0)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
      expect(result.errors).toHaveLength(0)
    })

    it('captures errors without stopping batch', async () => {
      // Force an error on the upsert for the second call
      let callCount = 0
      mockStore.upsert.mockImplementation(async () => {
        callCount++
        if (callCount === 2) throw new Error('Upsert failed')
      })

      const result = await service.indexFiles([
        { filePath: 'src/a.ts', content: 'export const a = 1', language: 'typescript' },
        { filePath: 'src/b.ts', content: 'export const b = 2', language: 'typescript' },
        { filePath: 'src/c.ts', content: 'export const c = 3', language: 'typescript' },
      ])

      // At least some files should have been processed
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]?.message).toBe('Upsert failed')
    })
  })

  describe('search', () => {
    beforeEach(async () => {
      await service.indexFile('src/user-service.ts', TS_SOURCE, 'typescript')
      await service.indexFile('src/auth.ts', TS_SOURCE_2, 'typescript')
    })

    it('returns relevant results for text queries', async () => {
      const results = await service.search('getUser')

      // Our mock performs simple keyword match
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]?.content).toContain('getUser')
    })

    it('returns results with correct structure', async () => {
      const results = await service.search('User')

      for (const result of results) {
        expect(result).toEqual(
          expect.objectContaining({
            filePath: expect.any(String),
            content: expect.any(String),
            startLine: expect.any(Number),
            endLine: expect.any(Number),
            symbols: expect.any(Array),
            score: expect.any(Number),
            language: expect.any(String),
            chunkId: expect.any(String),
          }),
        )
      }
    })

    it('respects limit option', async () => {
      const results = await service.search('User', { limit: 1 })
      expect(results.length).toBeLessThanOrEqual(1)
    })

    it('filters by minimum score', async () => {
      const results = await service.search('User', { minScore: 0.99 })
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.99)
      }
    })

    it('passes language filter to the store', async () => {
      await service.search('User', { language: 'typescript' })

      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'User',
        expect.any(Number),
        expect.objectContaining({
          field: 'language',
          op: 'eq',
          value: 'typescript',
        }),
      )
    })

    it('passes filePath filter to the store', async () => {
      await service.search('User', { filePath: 'src/user' })

      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'User',
        expect.any(Number),
        expect.objectContaining({
          field: 'filePath',
          op: 'contains',
          value: 'src/user',
        }),
      )
    })

    it('combines multiple filters with AND', async () => {
      await service.search('User', { language: 'typescript', filePath: 'src/' })

      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'User',
        expect.any(Number),
        expect.objectContaining({
          and: expect.arrayContaining([
            { field: 'language', op: 'eq', value: 'typescript' },
            { field: 'filePath', op: 'contains', value: 'src/' },
          ]),
        }),
      )
    })
  })

  describe('searchBySymbol', () => {
    beforeEach(async () => {
      await service.indexFile('src/user-service.ts', TS_SOURCE, 'typescript')
      await service.indexFile('src/auth.ts', TS_SOURCE_2, 'typescript')
    })

    it('searches for chunks containing a specific symbol', async () => {
      const results = await service.searchBySymbol('UserService')

      // The mock store should find chunks with "UserService" in text
      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'UserService',
        expect.any(Number),
        expect.objectContaining({
          field: 'symbols',
          op: 'contains',
          value: 'UserService',
        }),
      )
    })

    it('combines symbol filter with additional options', async () => {
      await service.searchBySymbol('authenticate', { language: 'typescript' })

      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'authenticate',
        expect.any(Number),
        expect.objectContaining({
          and: expect.arrayContaining([
            { field: 'language', op: 'eq', value: 'typescript' },
            { field: 'symbols', op: 'contains', value: 'authenticate' },
          ]),
        }),
      )
    })
  })

  describe('removeFile', () => {
    it('deletes chunks for a specific file path', async () => {
      await service.indexFile('src/user-service.ts', TS_SOURCE, 'typescript')
      await service.removeFile('src/user-service.ts')

      expect(mockStore.delete).toHaveBeenCalledWith('test_code', {
        filter: { field: 'filePath', op: 'eq', value: 'src/user-service.ts' },
      })
    })

    it('removes file from tracked set', async () => {
      await service.indexFile('src/user-service.ts', TS_SOURCE, 'typescript')
      const statsBefore = await service.getStats()
      expect(statsBefore.totalFiles).toBe(1)

      await service.removeFile('src/user-service.ts')
      const statsAfter = await service.getStats()
      expect(statsAfter.totalFiles).toBe(0)
    })
  })

  describe('getStats', () => {
    it('returns empty stats before indexing', async () => {
      const stats: IndexStats = await service.getStats()

      expect(stats.totalChunks).toBe(0)
      expect(stats.totalFiles).toBe(0)
      expect(stats.languages).toEqual([])
      expect(stats.lastIndexedAt).toBeNull()
    })

    it('returns accurate stats after indexing', async () => {
      await service.indexFile('src/user-service.ts', TS_SOURCE, 'typescript')
      await service.indexFile('src/auth.ts', TS_SOURCE_2, 'typescript')

      const stats = await service.getStats()

      expect(stats.totalFiles).toBe(2)
      expect(stats.totalChunks).toBeGreaterThan(0)
      expect(stats.languages).toContain('typescript')
      expect(stats.lastIndexedAt).toBeInstanceOf(Date)
    })

    it('tracks multiple languages', async () => {
      await service.indexFile('src/app.ts', TS_SOURCE, 'typescript')
      await service.indexFile('src/app.py', 'def foo(): pass', 'python')

      const stats = await service.getStats()

      expect(stats.languages).toContain('typescript')
      expect(stats.languages).toContain('python')
    })
  })

  describe('edge cases', () => {
    it('handles files with no recognized symbols', async () => {
      const code = '// Just a comment\n\n'
      const count = await service.indexFile('src/empty-ish.ts', code, 'typescript')
      // May produce line-based chunks or nothing; should not throw
      expect(typeof count).toBe('number')
    })

    it('handles whitespace-only files', async () => {
      const count = await service.indexFile('src/blank.ts', '   \n  \n  ', 'typescript')
      expect(count).toBe(0)
    })

    it('handles single-line files', async () => {
      const count = await service.indexFile(
        'src/single.ts',
        'export const FOO = 42',
        'typescript',
      )
      expect(count).toBeGreaterThanOrEqual(0)
    })

    it('search returns empty array when no matches', async () => {
      await service.indexFile('src/user-service.ts', TS_SOURCE, 'typescript')
      const results = await service.search('xyznonexistent12345')
      expect(results).toEqual([])
    })

    it('search works on empty collection', async () => {
      const results = await service.search('anything')
      expect(results).toEqual([])
    })
  })
})
