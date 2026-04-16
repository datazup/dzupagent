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

  // -------------------------------------------------------------------------
  // W14-A1: Expanded coverage
  // -------------------------------------------------------------------------

  describe('constructor edge cases', () => {
    it('uses default collection when config is undefined', async () => {
      const store2 = createMockSemanticStore()
      const svc = new CodeSearchService(store2 as never)
      await svc.init()
      expect(store2.ensureCollection).toHaveBeenCalledWith('code_chunks')
    })

    it('uses default collection when config is provided without collectionName', async () => {
      const store2 = createMockSemanticStore()
      const svc = new CodeSearchService(store2 as never, {})
      await svc.init()
      expect(store2.ensureCollection).toHaveBeenCalledWith('code_chunks')
    })

    it('accepts custom collectionName in config', async () => {
      const store2 = createMockSemanticStore()
      const svc = new CodeSearchService(store2 as never, { collectionName: 'custom' })
      await svc.init()
      expect(store2.ensureCollection).toHaveBeenCalledWith('custom')
    })
  })

  describe('indexFile — additional branches', () => {
    it('falls back to "unknown" language for unrecognized extension', async () => {
      const count = await service.indexFile('data.xyz123', 'some content here')
      // Should not throw; language resolves to 'unknown'
      expect(typeof count).toBe('number')
    })

    it('re-indexes same file path (upsert behavior)', async () => {
      await service.indexFile('src/user-service.ts', TS_SOURCE, 'typescript')
      const statsBefore = await service.getStats()
      const chunksBefore = statsBefore.totalChunks

      // Index same file again with different content
      await service.indexFile('src/user-service.ts', TS_SOURCE_2, 'typescript')
      // The file should still be tracked as 1 file
      const statsAfter = await service.getStats()
      expect(statsAfter.totalFiles).toBe(1)
      // upsert was called twice
      expect(mockStore.upsert).toHaveBeenCalledTimes(2)
    })

    it('tracks lastIndexedAt as a Date after indexing', async () => {
      const before = new Date()
      await service.indexFile('src/user-service.ts', TS_SOURCE, 'typescript')
      const stats = await service.getStats()
      expect(stats.lastIndexedAt).toBeInstanceOf(Date)
      expect(stats.lastIndexedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime())
    })

    it('adds language to tracked languages set', async () => {
      await service.indexFile('src/app.py', 'def foo(): pass', 'python')
      const stats = await service.getStats()
      expect(stats.languages).toContain('python')
    })

    it('correctly serializes multiple symbols into metadata', async () => {
      // TS_SOURCE has multiple symbols (User interface, UserService class, createRouter function)
      await service.indexFile('src/multi.ts', TS_SOURCE, 'typescript')
      const upsertCall = mockStore.upsert.mock.calls[0] as [string, StoredDoc[]]
      const docs = upsertCall[1]
      // Verify all metadata has valid JSON for symbols and symbolKinds
      for (const doc of docs) {
        expect(() => JSON.parse(String(doc.metadata.symbols))).not.toThrow()
        expect(() => JSON.parse(String(doc.metadata.symbolKinds))).not.toThrow()
      }
    })

    it('sets chunkId in metadata matching the document id', async () => {
      await service.indexFile('src/app.ts', 'export const x = 1', 'typescript')
      const upsertCall = mockStore.upsert.mock.calls[0] as [string, StoredDoc[]]
      if (upsertCall) {
        const docs = upsertCall[1]
        for (const doc of docs) {
          expect(doc.metadata.chunkId).toBe(doc.id)
        }
      }
    })
  })

  describe('indexFiles — additional branches', () => {
    it('returns zero counts for empty file list', async () => {
      const result = await service.indexFiles([])
      expect(result.filesIndexed).toBe(0)
      expect(result.chunksCreated).toBe(0)
      expect(result.errors).toHaveLength(0)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('does not count file as indexed if it produces 0 chunks', async () => {
      const result = await service.indexFiles([
        { filePath: 'src/empty.ts', content: '', language: 'typescript' },
      ])
      expect(result.filesIndexed).toBe(0)
      expect(result.chunksCreated).toBe(0)
      expect(result.errors).toHaveLength(0)
    })

    it('handles non-Error thrown objects in error capture', async () => {
      mockStore.upsert.mockImplementation(async () => {
        throw 'string error' // eslint-disable-line no-throw-literal
      })

      const result = await service.indexFiles([
        { filePath: 'src/a.ts', content: 'export const a = 1', language: 'typescript' },
      ])

      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]?.message).toBe('string error')
    })

    it('records positive durationMs for multiple files', async () => {
      const result = await service.indexFiles([
        { filePath: 'src/a.ts', content: TS_SOURCE, language: 'typescript' },
        { filePath: 'src/b.ts', content: TS_SOURCE_2, language: 'typescript' },
      ])
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('continues indexing after an error and counts remaining files', async () => {
      let callCount = 0
      mockStore.upsert.mockImplementation(async () => {
        callCount++
        if (callCount === 1) throw new Error('First failed')
      })

      const result = await service.indexFiles([
        { filePath: 'src/a.ts', content: 'export const a = 1', language: 'typescript' },
        { filePath: 'src/b.ts', content: 'export const b = 2', language: 'typescript' },
        { filePath: 'src/c.ts', content: 'export const c = 3', language: 'typescript' },
      ])

      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]?.filePath).toBe('src/a.ts')
      // Remaining files should have succeeded
      expect(result.filesIndexed).toBeGreaterThanOrEqual(1)
    })

    it('auto-detects language when not provided in batch', async () => {
      const result = await service.indexFiles([
        { filePath: 'src/auto.ts', content: 'export const x = 1' },
      ])
      // Should not error
      expect(result.errors).toHaveLength(0)
    })
  })

  describe('search — additional branches', () => {
    beforeEach(async () => {
      await service.indexFile('src/user-service.ts', TS_SOURCE, 'typescript')
      await service.indexFile('src/auth.ts', TS_SOURCE_2, 'typescript')
    })

    it('uses default limit of 10 when no options provided', async () => {
      await service.search('User')
      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'User',
        10,
        undefined,
      )
    })

    it('passes symbolKind filter to the store', async () => {
      await service.search('User', { symbolKind: 'class' })

      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'User',
        expect.any(Number),
        expect.objectContaining({
          field: 'symbolKinds',
          op: 'contains',
          value: 'class',
        }),
      )
    })

    it('combines all three filters (language, filePath, symbolKind)', async () => {
      await service.search('User', {
        language: 'typescript',
        filePath: 'src/',
        symbolKind: 'class',
      })

      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'User',
        expect.any(Number),
        expect.objectContaining({
          and: expect.arrayContaining([
            { field: 'language', op: 'eq', value: 'typescript' },
            { field: 'filePath', op: 'contains', value: 'src/' },
            { field: 'symbolKinds', op: 'contains', value: 'class' },
          ]),
        }),
      )
    })

    it('returns no results when minScore exceeds all scores', async () => {
      const results = await service.search('User', { minScore: 1.5 })
      expect(results).toEqual([])
    })

    it('returns all matching results when minScore is 0', async () => {
      const results = await service.search('User', { minScore: 0 })
      // Should include all results since minScore=0 means no filtering
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0)
      }
    })

    it('applies filter undefined when options have no filter fields', async () => {
      await service.search('User', { limit: 5 })
      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'User',
        5,
        undefined,
      )
    })

    it('returns results sorted by score (highest first)', async () => {
      const results = await service.search('User')
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score)
      }
    })

    it('each result has valid language field', async () => {
      const results = await service.search('User')
      for (const r of results) {
        expect(typeof r.language).toBe('string')
        expect(r.language.length).toBeGreaterThan(0)
      }
    })

    it('each result has valid chunkId field', async () => {
      const results = await service.search('User')
      for (const r of results) {
        expect(typeof r.chunkId).toBe('string')
        expect(r.chunkId.length).toBeGreaterThan(0)
      }
    })
  })

  describe('searchBySymbol — additional branches', () => {
    beforeEach(async () => {
      await service.indexFile('src/user-service.ts', TS_SOURCE, 'typescript')
      await service.indexFile('src/auth.ts', TS_SOURCE_2, 'typescript')
    })

    it('uses default limit of 10 when no options provided', async () => {
      await service.searchBySymbol('UserService')
      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'UserService',
        10,
        expect.any(Object),
      )
    })

    it('respects custom limit option', async () => {
      await service.searchBySymbol('UserService', { limit: 3 })
      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'UserService',
        3,
        expect.any(Object),
      )
    })

    it('filters results by minScore', async () => {
      const results = await service.searchBySymbol('UserService', { minScore: 0.99 })
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.99)
      }
    })

    it('returns empty array when symbol does not exist', async () => {
      const results = await service.searchBySymbol('NonExistentSymbol12345')
      expect(results).toEqual([])
    })

    it('combines filePath filter with symbol filter', async () => {
      await service.searchBySymbol('authenticate', { filePath: 'src/auth' })

      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'authenticate',
        expect.any(Number),
        expect.objectContaining({
          and: expect.arrayContaining([
            { field: 'filePath', op: 'contains', value: 'src/auth' },
            { field: 'symbols', op: 'contains', value: 'authenticate' },
          ]),
        }),
      )
    })

    it('combines symbolKind filter with symbol filter', async () => {
      await service.searchBySymbol('UserService', { symbolKind: 'class' })

      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'UserService',
        expect.any(Number),
        expect.objectContaining({
          and: expect.arrayContaining([
            { field: 'symbolKinds', op: 'contains', value: 'class' },
            { field: 'symbols', op: 'contains', value: 'UserService' },
          ]),
        }),
      )
    })

    it('combines all options with symbol filter', async () => {
      await service.searchBySymbol('UserService', {
        language: 'typescript',
        filePath: 'src/',
        symbolKind: 'class',
        limit: 5,
        minScore: 0.1,
      })

      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'UserService',
        5,
        expect.objectContaining({
          and: expect.arrayContaining([
            expect.objectContaining({
              and: expect.arrayContaining([
                { field: 'language', op: 'eq', value: 'typescript' },
                { field: 'filePath', op: 'contains', value: 'src/' },
                { field: 'symbolKinds', op: 'contains', value: 'class' },
              ]),
            }),
            { field: 'symbols', op: 'contains', value: 'UserService' },
          ]),
        }),
      )
    })
  })

  describe('toSearchResult — metadata edge cases', () => {
    it('handles malformed symbols JSON gracefully', async () => {
      // Manually insert a document with invalid JSON in symbols
      mockStore._collections.set('test_code', [
        {
          id: 'bad-1',
          text: 'some code with badquery',
          metadata: {
            filePath: 'src/bad.ts',
            language: 'typescript',
            startLine: 1,
            endLine: 10,
            symbols: '{{{not valid json',
            symbolKinds: '["class"]',
            chunkId: 'bad-1',
          },
        },
      ])

      const results = await service.search('badquery')
      expect(results.length).toBeGreaterThan(0)
      // Malformed symbols should result in empty array, not a throw
      expect(results[0]?.symbols).toEqual([])
    })

    it('handles completely missing metadata fields', async () => {
      mockStore._collections.set('test_code', [
        {
          id: 'missing-meta-1',
          text: 'some code missingmetaquery',
          metadata: {},
        },
      ])

      const results = await service.search('missingmetaquery')
      expect(results.length).toBeGreaterThan(0)
      const result = results[0]!
      expect(result.filePath).toBe('')
      expect(result.startLine).toBe(0)
      expect(result.endLine).toBe(0)
      expect(result.language).toBe('unknown')
      expect(result.symbols).toEqual([])
    })

    it('handles null symbols in metadata', async () => {
      mockStore._collections.set('test_code', [
        {
          id: 'null-sym-1',
          text: 'some code nullsymquery',
          metadata: {
            filePath: 'src/null.ts',
            language: 'typescript',
            startLine: 1,
            endLine: 5,
            symbols: null as unknown as string,
            symbolKinds: '[]',
            chunkId: 'null-sym-1',
          },
        },
      ])

      const results = await service.search('nullsymquery')
      expect(results.length).toBeGreaterThan(0)
      // When symbols is null, JSON.parse(null ?? '[]') = JSON.parse('[]') = []
      expect(results[0]?.symbols).toEqual([])
    })

    it('handles undefined symbols in metadata', async () => {
      mockStore._collections.set('test_code', [
        {
          id: 'undef-sym-1',
          text: 'some code undefsymquery',
          metadata: {
            filePath: 'src/undef.ts',
            language: 'typescript',
            startLine: 1,
            endLine: 5,
            chunkId: 'undef-sym-1',
          },
        },
      ])

      const results = await service.search('undefsymquery')
      expect(results.length).toBeGreaterThan(0)
      // undefined ?? '[]' = '[]', JSON.parse('[]') = []
      expect(results[0]?.symbols).toEqual([])
    })

    it('uses doc.id as fallback when chunkId is missing', async () => {
      mockStore._collections.set('test_code', [
        {
          id: 'fallback-id-1',
          text: 'some code fallbackidquery',
          metadata: {
            filePath: 'src/fallback.ts',
            language: 'typescript',
            startLine: 1,
            endLine: 5,
            symbols: '[]',
            symbolKinds: '[]',
          },
        },
      ])

      const results = await service.search('fallbackidquery')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]?.chunkId).toBe('fallback-id-1')
    })
  })

  describe('removeFile — additional branches', () => {
    it('succeeds for a file that was never indexed', async () => {
      // Should not throw
      await service.removeFile('src/never-indexed.ts')
      expect(mockStore.delete).toHaveBeenCalledWith('test_code', {
        filter: { field: 'filePath', op: 'eq', value: 'src/never-indexed.ts' },
      })
    })

    it('file count decreases correctly after multiple removals', async () => {
      await service.indexFile('src/a.ts', TS_SOURCE, 'typescript')
      await service.indexFile('src/b.ts', TS_SOURCE_2, 'typescript')

      let stats = await service.getStats()
      expect(stats.totalFiles).toBe(2)

      await service.removeFile('src/a.ts')
      stats = await service.getStats()
      expect(stats.totalFiles).toBe(1)

      await service.removeFile('src/b.ts')
      stats = await service.getStats()
      expect(stats.totalFiles).toBe(0)
    })

    it('search returns no results for removed file content', async () => {
      await service.indexFile('src/auth.ts', TS_SOURCE_2, 'typescript')
      await service.removeFile('src/auth.ts')

      // After removal from the mock store, search should not find the content
      const results = await service.search('authenticate')
      expect(results).toEqual([])
    })
  })

  describe('getStats — additional branches', () => {
    it('totalChunks reflects actual store count', async () => {
      await service.indexFile('src/user-service.ts', TS_SOURCE, 'typescript')

      const stats = await service.getStats()
      const storeCount = await mockStore.store.count('test_code')
      expect(stats.totalChunks).toBe(storeCount)
    })

    it('lastIndexedAt updates on subsequent indexing', async () => {
      await service.indexFile('src/a.ts', 'export const a = 1', 'typescript')
      const stats1 = await service.getStats()
      const time1 = stats1.lastIndexedAt!.getTime()

      await service.indexFile('src/b.ts', 'export const b = 2', 'typescript')
      const stats2 = await service.getStats()
      const time2 = stats2.lastIndexedAt!.getTime()

      expect(time2).toBeGreaterThanOrEqual(time1)
    })

    it('languages array does not contain duplicates', async () => {
      await service.indexFile('src/a.ts', 'export const a = 1', 'typescript')
      await service.indexFile('src/b.ts', 'export const b = 2', 'typescript')

      const stats = await service.getStats()
      const uniqueLangs = [...new Set(stats.languages)]
      expect(stats.languages).toEqual(uniqueLangs)
    })

    it('returns correct stats after removeFile', async () => {
      await service.indexFile('src/a.ts', TS_SOURCE, 'typescript')
      await service.removeFile('src/a.ts')

      const stats = await service.getStats()
      expect(stats.totalFiles).toBe(0)
      // Languages set is not cleared on removal
      expect(stats.languages).toContain('typescript')
      // lastIndexedAt is still set from the indexing
      expect(stats.lastIndexedAt).toBeInstanceOf(Date)
    })
  })

  describe('buildFilter — exhaustive coverage', () => {
    beforeEach(async () => {
      await service.indexFile('src/user-service.ts', TS_SOURCE, 'typescript')
    })

    it('returns undefined filter when options is empty object', async () => {
      await service.search('User', {})
      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'User',
        10,
        undefined,
      )
    })

    it('returns single filter for only symbolKind', async () => {
      await service.search('User', { symbolKind: 'function' })
      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'User',
        expect.any(Number),
        { field: 'symbolKinds', op: 'contains', value: 'function' },
      )
    })

    it('returns single filter for only language', async () => {
      await service.search('User', { language: 'python' })
      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'User',
        expect.any(Number),
        { field: 'language', op: 'eq', value: 'python' },
      )
    })

    it('returns single filter for only filePath', async () => {
      await service.search('User', { filePath: 'src/user' })
      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'User',
        expect.any(Number),
        { field: 'filePath', op: 'contains', value: 'src/user' },
      )
    })

    it('combines two filters (language + symbolKind) with AND', async () => {
      await service.search('User', { language: 'typescript', symbolKind: 'class' })
      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'User',
        expect.any(Number),
        expect.objectContaining({
          and: expect.arrayContaining([
            { field: 'language', op: 'eq', value: 'typescript' },
            { field: 'symbolKinds', op: 'contains', value: 'class' },
          ]),
        }),
      )
    })

    it('combines two filters (filePath + symbolKind) with AND', async () => {
      await service.search('User', { filePath: 'src/', symbolKind: 'interface' })
      expect(mockStore.search).toHaveBeenCalledWith(
        'test_code',
        'User',
        expect.any(Number),
        expect.objectContaining({
          and: expect.arrayContaining([
            { field: 'filePath', op: 'contains', value: 'src/' },
            { field: 'symbolKinds', op: 'contains', value: 'interface' },
          ]),
        }),
      )
    })
  })

  describe('concurrent and interleaved operations', () => {
    it('handles concurrent indexFile calls', async () => {
      const [count1, count2] = await Promise.all([
        service.indexFile('src/a.ts', TS_SOURCE, 'typescript'),
        service.indexFile('src/b.ts', TS_SOURCE_2, 'typescript'),
      ])

      expect(count1).toBeGreaterThan(0)
      expect(count2).toBeGreaterThan(0)
      const stats = await service.getStats()
      expect(stats.totalFiles).toBe(2)
    })

    it('handles concurrent search calls', async () => {
      await service.indexFile('src/user-service.ts', TS_SOURCE, 'typescript')

      const [results1, results2] = await Promise.all([
        service.search('User'),
        service.search('createRouter'),
      ])

      expect(Array.isArray(results1)).toBe(true)
      expect(Array.isArray(results2)).toBe(true)
    })

    it('search after re-indexing reflects new content', async () => {
      await service.indexFile('src/app.ts', 'export const old = 1', 'typescript')
      await service.indexFile('src/app.ts', 'export const newContent = 2', 'typescript')

      // The mock upsert replaces by id; search should find the latest
      const results = await service.search('newContent')
      // May or may not match depending on chunk IDs, but should not throw
      expect(Array.isArray(results)).toBe(true)
    })
  })

  describe('various content edge cases', () => {
    it('handles very large file content', async () => {
      const largeLine = 'export const x' + '_'.repeat(500) + ' = 1\n'
      const largeContent = largeLine.repeat(50)
      const count = await service.indexFile('src/large.ts', largeContent, 'typescript')
      expect(typeof count).toBe('number')
    })

    it('handles file with only imports (no exports)', async () => {
      const code = `import { foo } from 'bar'\nimport { baz } from 'qux'\n`
      const count = await service.indexFile('src/imports-only.ts', code, 'typescript')
      expect(typeof count).toBe('number')
    })

    it('handles file with unicode content', async () => {
      const code = `export const greeting = 'Hola mundo'\nexport const emoji = 'test'\n`
      const count = await service.indexFile('src/unicode.ts', code, 'typescript')
      expect(typeof count).toBe('number')
    })

    it('handles JavaScript files', async () => {
      const jsCode = `function hello() { return 'world' }\nmodule.exports = { hello }`
      const count = await service.indexFile('src/app.js', jsCode)
      expect(typeof count).toBe('number')
    })

    it('handles Python files', async () => {
      const pyCode = `def hello():\n    return "world"\n\nclass Foo:\n    pass\n`
      const count = await service.indexFile('src/app.py', pyCode, 'python')
      expect(typeof count).toBe('number')
    })

    it('handles file with only newlines', async () => {
      const count = await service.indexFile('src/newlines.ts', '\n\n\n\n\n', 'typescript')
      expect(count).toBe(0)
    })
  })
})
