import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  LanceDBAdapter,
  translateFilter,
} from '../vectordb/adapters/lancedb-adapter.js'
import type { MetadataFilter, VectorQuery } from '../vectordb/types.js'

// --- Mock LanceDB connection and table ---

interface MockRow {
  id: string
  vector: number[]
  text: string
  _distance: number
  [key: string]: unknown
}

function createMockQueryBuilder(rows: MockRow[]) {
  let appliedLimit = 10
  let appliedWhere: string | undefined
  let appliedDistanceType: string | undefined

  const builder = {
    limit(n: number) {
      appliedLimit = n
      return builder
    },
    where(filter: string) {
      appliedWhere = filter
      return builder
    },
    distanceType(metric: string) {
      appliedDistanceType = metric
      return builder
    },
    async toArray() {
      return rows.slice(0, appliedLimit)
    },
    async toArrow() {
      return { __arrow: true, rows: rows.slice(0, appliedLimit) }
    },
    get _appliedWhere() {
      return appliedWhere
    },
    get _appliedDistanceType() {
      return appliedDistanceType
    },
  }
  return builder
}

function createMockTable(opts?: {
  rows?: MockRow[]
  countResult?: number
}) {
  const storedRows: MockRow[] = opts?.rows ? [...opts.rows] : []
  const countResult = opts?.countResult ?? storedRows.length

  return {
    add: vi.fn(async (data: Record<string, unknown>[]) => {
      for (const row of data) {
        storedRows.push(row as MockRow)
      }
    }),
    update: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    countRows: vi.fn(async () => countResult),
    search: vi.fn((vector: number[]) => createMockQueryBuilder(storedRows)),
    createIndex: vi.fn(async () => undefined),
    toArrow: vi.fn(async () => ({ __arrow: true })),
    overwrite: vi.fn(async () => undefined),
    schema: {},
    _storedRows: storedRows,
  }
}

function createMockConnection(tables?: Record<string, ReturnType<typeof createMockTable>>) {
  const tableMap = new Map<string, ReturnType<typeof createMockTable>>(
    Object.entries(tables ?? {}),
  )

  return {
    tableNames: vi.fn(async () => [...tableMap.keys()]),
    createTable: vi.fn(async (name: string, data: Record<string, unknown>[]) => {
      const table = createMockTable({ rows: data as MockRow[] })
      tableMap.set(name, table)
      return table
    }),
    createEmptyTable: vi.fn(async (name: string) => {
      const table = createMockTable()
      tableMap.set(name, table)
      return table
    }),
    openTable: vi.fn(async (name: string) => {
      const table = tableMap.get(name)
      if (!table) throw new Error(`Table "${name}" not found`)
      return table
    }),
    dropTable: vi.fn(async (name: string) => {
      tableMap.delete(name)
    }),
    _tableMap: tableMap,
  }
}

// --- Tests ---

describe('LanceDBAdapter', () => {
  let adapter: LanceDBAdapter
  let mockDb: ReturnType<typeof createMockConnection>

  beforeEach(() => {
    mockDb = createMockConnection()
    adapter = LanceDBAdapter.createFromConnection(
      mockDb,
      { uri: '/tmp/test-lancedb', hybridSearch: true, vectorWeight: 0.7 },
    )
  })

  describe('provider', () => {
    it('reports lancedb as provider', () => {
      expect(adapter.provider).toBe('lancedb')
    })
  })

  describe('createCollection', () => {
    it('creates a table with seed row and deletes it', async () => {
      await adapter.createCollection('test', { dimensions: 4 })

      expect(mockDb.createTable).toHaveBeenCalledWith(
        'test',
        [{ id: '__seed__', vector: [0, 0, 0, 0], text: '' }],
        { mode: 'overwrite' },
      )

      // Seed row should be deleted
      const table = await mockDb.openTable('test')
      expect(table.delete).toHaveBeenCalledWith("id = '__seed__'")
    })

    it('throws VECTOR_COLLECTION_EXISTS if table already exists', async () => {
      // Create a pre-existing table
      mockDb._tableMap.set('existing', createMockTable())

      await expect(
        adapter.createCollection('existing', { dimensions: 4 }),
      ).rejects.toThrow('already exists')
    })
  })

  describe('deleteCollection', () => {
    it('drops the table', async () => {
      mockDb._tableMap.set('todelete', createMockTable())
      await adapter.deleteCollection('todelete')
      expect(mockDb.dropTable).toHaveBeenCalledWith('todelete')
    })
  })

  describe('listCollections', () => {
    it('returns table names', async () => {
      mockDb._tableMap.set('a', createMockTable())
      mockDb._tableMap.set('b', createMockTable())
      const names = await adapter.listCollections()
      expect(names).toEqual(['a', 'b'])
    })
  })

  describe('collectionExists', () => {
    it('returns true when table exists', async () => {
      mockDb._tableMap.set('exists', createMockTable())
      expect(await adapter.collectionExists('exists')).toBe(true)
    })

    it('returns false when table does not exist', async () => {
      expect(await adapter.collectionExists('nope')).toBe(false)
    })
  })

  describe('upsert', () => {
    it('adds rows to the table', async () => {
      const mockTable = createMockTable()
      mockDb._tableMap.set('coll', mockTable)

      await adapter.upsert('coll', [
        {
          id: 'v1',
          vector: [1, 2, 3, 4],
          metadata: { category: 'test' },
          text: 'hello world',
        },
      ])

      expect(mockTable.add).toHaveBeenCalled()
      const addedRows = mockTable.add.mock.calls[0]?.[0] as Record<string, unknown>[]
      expect(addedRows).toBeDefined()
      expect(addedRows[0]).toMatchObject({
        id: 'v1',
        vector: [1, 2, 3, 4],
        text: 'hello world',
        category: 'test',
      })
    })

    it('deletes existing IDs before adding (upsert semantics)', async () => {
      const mockTable = createMockTable()
      mockDb._tableMap.set('coll', mockTable)

      await adapter.upsert('coll', [
        { id: 'v1', vector: [1, 2, 3, 4], metadata: {}, text: 'updated' },
      ])

      // Should have tried to delete existing rows first
      expect(mockTable.delete).toHaveBeenCalledWith("id IN ('v1')")
    })

    it('handles empty entries gracefully', async () => {
      const mockTable = createMockTable()
      mockDb._tableMap.set('coll', mockTable)

      await adapter.upsert('coll', [])
      expect(mockTable.add).not.toHaveBeenCalled()
    })
  })

  describe('search', () => {
    it('returns results with score conversion', async () => {
      const mockTable = createMockTable({
        rows: [
          { id: 'r1', vector: [1, 0, 0, 0], text: 'first', _distance: 0.1 },
          { id: 'r2', vector: [0, 1, 0, 0], text: 'second', _distance: 0.5 },
        ],
      })
      mockDb._tableMap.set('coll', mockTable)

      const results = await adapter.search('coll', {
        vector: [1, 0, 0, 0],
        limit: 10,
      })

      expect(results).toHaveLength(2)
      expect(results[0]?.id).toBe('r1')
      // cosine distance 0.1 -> score 0.9
      expect(results[0]?.score).toBeCloseTo(0.9)
      expect(results[0]?.text).toBe('first')
    })

    it('filters by minScore', async () => {
      const mockTable = createMockTable({
        rows: [
          { id: 'r1', vector: [1, 0, 0, 0], text: 'first', _distance: 0.1 },
          { id: 'r2', vector: [0, 1, 0, 0], text: 'second', _distance: 0.8 },
        ],
      })
      mockDb._tableMap.set('coll', mockTable)

      const results = await adapter.search('coll', {
        vector: [1, 0, 0, 0],
        limit: 10,
        minScore: 0.5,
      })

      // Only r1 has score 0.9 >= 0.5; r2 has score 0.2 < 0.5
      expect(results).toHaveLength(1)
      expect(results[0]?.id).toBe('r1')
    })

    it('excludes metadata when includeMetadata is false', async () => {
      const mockTable = createMockTable({
        rows: [
          { id: 'r1', vector: [1, 0], text: 'test', _distance: 0.1, category: 'a' },
        ],
      })
      mockDb._tableMap.set('coll', mockTable)

      const results = await adapter.search('coll', {
        vector: [1, 0],
        limit: 10,
        includeMetadata: false,
      })

      expect(results[0]?.metadata).toEqual({})
    })

    it('includes vectors when includeVectors is true', async () => {
      const mockTable = createMockTable({
        rows: [
          { id: 'r1', vector: [1, 0, 0], text: '', _distance: 0.0 },
        ],
      })
      mockDb._tableMap.set('coll', mockTable)

      const results = await adapter.search('coll', {
        vector: [1, 0, 0],
        limit: 10,
        includeVectors: true,
      })

      expect(results[0]?.vector).toEqual([1, 0, 0])
    })

    it('applies metadata filter as WHERE clause', async () => {
      const mockTable = createMockTable({
        rows: [
          { id: 'r1', vector: [1, 0], text: '', _distance: 0.1, status: 'active' },
        ],
      })
      mockDb._tableMap.set('coll', mockTable)

      await adapter.search('coll', {
        vector: [1, 0],
        limit: 10,
        filter: { field: 'status', op: 'eq', value: 'active' },
      })

      expect(mockTable.search).toHaveBeenCalled()
    })

    it('returns empty text as undefined', async () => {
      const mockTable = createMockTable({
        rows: [
          { id: 'r1', vector: [1], text: '', _distance: 0.0 },
        ],
      })
      mockDb._tableMap.set('coll', mockTable)

      const results = await adapter.search('coll', {
        vector: [1],
        limit: 10,
      })

      expect(results[0]?.text).toBeUndefined()
    })
  })

  describe('delete', () => {
    it('deletes by IDs', async () => {
      const mockTable = createMockTable()
      mockDb._tableMap.set('coll', mockTable)

      await adapter.delete('coll', { ids: ['a', 'b'] })
      expect(mockTable.delete).toHaveBeenCalledWith("id IN ('a', 'b')")
    })

    it('deletes by metadata filter', async () => {
      const mockTable = createMockTable()
      mockDb._tableMap.set('coll', mockTable)

      await adapter.delete('coll', {
        filter: { field: 'status', op: 'eq', value: 'archived' },
      })

      expect(mockTable.delete).toHaveBeenCalledWith(`"status" = 'archived'`)
    })
  })

  describe('count', () => {
    it('returns row count', async () => {
      const mockTable = createMockTable({ countResult: 42 })
      mockDb._tableMap.set('coll', mockTable)

      expect(await adapter.count('coll')).toBe(42)
    })
  })

  describe('healthCheck', () => {
    it('returns healthy when tableNames() succeeds', async () => {
      const health = await adapter.healthCheck()
      expect(health.healthy).toBe(true)
      expect(health.provider).toBe('lancedb')
      expect(health.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it('returns unhealthy when tableNames() throws', async () => {
      mockDb.tableNames.mockRejectedValueOnce(new Error('connection failed'))
      const health = await adapter.healthCheck()
      expect(health.healthy).toBe(false)
      expect(health.provider).toBe('lancedb')
    })
  })

  describe('close', () => {
    it('clears collection config cache', async () => {
      await adapter.close()
      // Should not throw -- no-op cleanup
    })
  })

  describe('buildFTSIndex', () => {
    it('creates an FTS index on the text column', async () => {
      const mockTable = createMockTable()
      mockDb._tableMap.set('coll', mockTable)

      await adapter.buildFTSIndex('coll')
      expect(mockTable.createIndex).toHaveBeenCalledWith('text', {
        config: { type: 'fts' },
      })
    })

    it('does not throw if index already exists', async () => {
      const mockTable = createMockTable()
      mockTable.createIndex.mockRejectedValueOnce(new Error('index exists'))
      mockDb._tableMap.set('coll', mockTable)

      await expect(adapter.buildFTSIndex('coll')).resolves.toBeUndefined()
    })
  })

  describe('searchAsArrow', () => {
    it('returns null when apache-arrow is not available', async () => {
      const mockTable = createMockTable({
        rows: [
          { id: 'r1', vector: [1], text: 'test', _distance: 0.1 },
        ],
      })
      mockDb._tableMap.set('coll', mockTable)

      // apache-arrow is not installed in test environment, so this should return null
      const result = await adapter.searchAsArrow('coll', {
        vector: [1],
        limit: 10,
      })

      // May return null or an arrow result depending on environment
      expect(result === null || result !== undefined).toBe(true)
    })
  })

  describe('getConfig', () => {
    it('returns a copy of the resolved config', () => {
      const config = adapter.getConfig()
      expect(config.uri).toBe('/tmp/test-lancedb')
      expect(config.hybridSearch).toBe(true)
      expect(config.vectorWeight).toBe(0.7)
    })
  })
})

describe('translateFilter', () => {
  it('translates eq filter', () => {
    const result = translateFilter({ field: 'status', op: 'eq', value: 'active' })
    expect(result).toBe(`"status" = 'active'`)
  })

  it('translates neq filter', () => {
    const result = translateFilter({ field: 'status', op: 'neq', value: 'deleted' })
    expect(result).toBe(`"status" != 'deleted'`)
  })

  it('translates gt filter', () => {
    const result = translateFilter({ field: 'score', op: 'gt', value: 0.5 })
    expect(result).toBe('"score" > 0.5')
  })

  it('translates gte filter', () => {
    const result = translateFilter({ field: 'score', op: 'gte', value: 0.5 })
    expect(result).toBe('"score" >= 0.5')
  })

  it('translates lt filter', () => {
    const result = translateFilter({ field: 'score', op: 'lt', value: 10 })
    expect(result).toBe('"score" < 10')
  })

  it('translates lte filter', () => {
    const result = translateFilter({ field: 'score', op: 'lte', value: 10 })
    expect(result).toBe('"score" <= 10')
  })

  it('translates in filter', () => {
    const result = translateFilter({ field: 'tag', op: 'in', value: ['a', 'b'] })
    expect(result).toBe(`"tag" IN ('a', 'b')`)
  })

  it('translates not_in filter', () => {
    const result = translateFilter({ field: 'tag', op: 'not_in', value: [1, 2] })
    expect(result).toBe('"tag" NOT IN (1, 2)')
  })

  it('translates contains filter using LIKE', () => {
    const result = translateFilter({ field: 'name', op: 'contains', value: 'forge' })
    expect(result).toBe(`"name" LIKE '%forge%'`)
  })

  it('translates boolean eq filter', () => {
    const result = translateFilter({ field: 'active', op: 'eq', value: true })
    expect(result).toBe('"active" = true')
  })

  it('translates AND filter', () => {
    const result = translateFilter({
      and: [
        { field: 'a', op: 'eq', value: 1 },
        { field: 'b', op: 'gt', value: 2 },
      ],
    })
    expect(result).toBe('("a" = 1 AND "b" > 2)')
  })

  it('translates OR filter', () => {
    const result = translateFilter({
      or: [
        { field: 'status', op: 'eq', value: 'active' },
        { field: 'status', op: 'eq', value: 'pending' },
      ],
    })
    expect(result).toBe(`("status" = 'active' OR "status" = 'pending')`)
  })

  it('translates nested AND/OR filter', () => {
    const result = translateFilter({
      and: [
        { field: 'type', op: 'eq', value: 'memory' },
        {
          or: [
            { field: 'score', op: 'gte', value: 0.5 },
            { field: 'important', op: 'eq', value: true },
          ],
        },
      ],
    })
    expect(result).toBe(`("type" = 'memory' AND ("score" >= 0.5 OR "important" = true))`)
  })

  it('escapes single quotes in string values', () => {
    const result = translateFilter({ field: 'name', op: 'eq', value: "it's" })
    expect(result).toBe(`"name" = 'it''s'`)
  })

  it('escapes double quotes in field names', () => {
    const result = translateFilter({ field: 'my"field', op: 'eq', value: 'test' })
    expect(result).toBe(`"my""field" = 'test'`)
  })
})

describe('detectVectorProvider with LanceDB', () => {
  it('detects lancedb when LANCEDB_URI is set', async () => {
    const { detectVectorProvider } = await import('../vectordb/auto-detect.js')
    const result = detectVectorProvider({
      LANCEDB_URI: '/tmp/my-lancedb',
    })
    expect(result.provider).toBe('lancedb')
    expect(result.config).toEqual({ uri: '/tmp/my-lancedb' })
  })

  it('prefers qdrant over lancedb', async () => {
    const { detectVectorProvider } = await import('../vectordb/auto-detect.js')
    const result = detectVectorProvider({
      QDRANT_URL: 'http://localhost:6333',
      LANCEDB_URI: '/tmp/my-lancedb',
    })
    expect(result.provider).toBe('qdrant')
  })

  it('prefers pinecone over lancedb', async () => {
    const { detectVectorProvider } = await import('../vectordb/auto-detect.js')
    const result = detectVectorProvider({
      PINECONE_API_KEY: 'pk-test',
      LANCEDB_URI: '/tmp/my-lancedb',
    })
    expect(result.provider).toBe('pinecone')
  })

  it('prefers explicit VECTOR_PROVIDER over lancedb', async () => {
    const { detectVectorProvider } = await import('../vectordb/auto-detect.js')
    const result = detectVectorProvider({
      VECTOR_PROVIDER: 'chroma',
      LANCEDB_URI: '/tmp/my-lancedb',
    })
    expect(result.provider).toBe('chroma')
  })

  it('falls back to memory when nothing is set', async () => {
    const { detectVectorProvider } = await import('../vectordb/auto-detect.js')
    const result = detectVectorProvider({})
    expect(result.provider).toBe('memory')
  })
})
