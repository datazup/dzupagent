import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PgVectorAdapter } from '../adapters/pgvector-adapter.js'
import type { PgVectorAdapterConfig } from '../adapters/pgvector-adapter.js'

type QueryFn = PgVectorAdapterConfig['queryFn']
type QueryResult = Awaited<ReturnType<QueryFn>>

function createMockQueryFn(): ReturnType<typeof vi.fn<QueryFn>> {
  return vi.fn<QueryFn>(async () => ({ rows: [] }))
}

function createAdapter(
  queryFn: QueryFn,
  prefix = 'forge_vectors_',
): PgVectorAdapter {
  return new PgVectorAdapter({
    connectionString: 'postgresql://localhost:5432/test',
    tablePrefix: prefix,
    queryFn,
  })
}

/** Helper to read captured call at index */
function getCall(queryFn: ReturnType<typeof vi.fn<QueryFn>>, idx: number) {
  const call = queryFn.mock.calls[idx]
  if (!call) throw new Error(`No call at index ${idx}`)
  return { sql: call[0], params: call[1] }
}

describe('PgVectorAdapter', () => {
  let queryFn: ReturnType<typeof vi.fn<QueryFn>>
  let adapter: PgVectorAdapter

  beforeEach(() => {
    queryFn = createMockQueryFn()
    adapter = createAdapter(queryFn)
  })

  it('has provider set to pgvector', () => {
    expect(adapter.provider).toBe('pgvector')
  })

  describe('createCollection', () => {
    it('generates CREATE EXTENSION, CREATE TABLE, and CREATE INDEX SQL', async () => {
      await adapter.createCollection('docs', { dimensions: 1536 })

      expect(queryFn).toHaveBeenCalledTimes(3)

      const ext = getCall(queryFn, 0)
      const table = getCall(queryFn, 1)
      const idx = getCall(queryFn, 2)

      expect(ext.sql).toBe('CREATE EXTENSION IF NOT EXISTS vector')
      expect(table.sql).toContain('CREATE TABLE IF NOT EXISTS forge_vectors_docs')
      expect(table.sql).toContain('vector(1536)')
      expect(table.sql).toContain('id TEXT PRIMARY KEY')
      expect(table.sql).toContain('metadata JSONB')
      expect(table.sql).toContain('text TEXT')
      expect(table.sql).toContain('created_at TIMESTAMPTZ')
      expect(idx.sql).toContain('CREATE INDEX IF NOT EXISTS idx_docs_vector')
      expect(idx.sql).toContain('USING ivfflat')
      expect(idx.sql).toContain('vector_cosine_ops')
    })

    it('uses custom table prefix', async () => {
      const customAdapter = createAdapter(queryFn, 'my_')
      await customAdapter.createCollection('embeddings', { dimensions: 768 })

      const table = getCall(queryFn, 1)
      expect(table.sql).toContain('my_embeddings')
    })
  })

  describe('deleteCollection', () => {
    it('generates DROP TABLE SQL', async () => {
      await adapter.deleteCollection('docs')

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(getCall(queryFn, 0).sql).toBe('DROP TABLE IF EXISTS forge_vectors_docs')
    })
  })

  describe('listCollections', () => {
    it('queries information_schema with LIKE pattern', async () => {
      queryFn.mockResolvedValueOnce({
        rows: [
          { table_name: 'forge_vectors_docs' },
          { table_name: 'forge_vectors_images' },
        ],
      })

      const result = await adapter.listCollections()

      const call = getCall(queryFn, 0)
      expect(call.sql).toContain('information_schema.tables')
      expect(call.sql).toContain('LIKE $1')
      expect(call.params).toEqual(['forge_vectors_%'])
      expect(result).toEqual(['docs', 'images'])
    })
  })

  describe('collectionExists', () => {
    it('checks information_schema for table existence', async () => {
      queryFn.mockResolvedValueOnce({
        rows: [{ exists: true }],
      })

      const exists = await adapter.collectionExists('docs')

      expect(exists).toBe(true)
      expect(getCall(queryFn, 0).params).toEqual(['forge_vectors_docs'])
    })

    it('returns false when table does not exist', async () => {
      queryFn.mockResolvedValueOnce({
        rows: [{ exists: false }],
      })

      const exists = await adapter.collectionExists('missing')
      expect(exists).toBe(false)
    })
  })

  describe('upsert', () => {
    it('generates INSERT ON CONFLICT for each entry', async () => {
      await adapter.upsert('docs', [
        { id: 'doc-1', vector: [0.1, 0.2, 0.3], metadata: { source: 'test' }, text: 'hello' },
        { id: 'doc-2', vector: [0.4, 0.5, 0.6], metadata: {}, text: undefined },
      ])

      expect(queryFn).toHaveBeenCalledTimes(2)

      const first = getCall(queryFn, 0)
      expect(first.sql).toContain('INSERT INTO forge_vectors_docs')
      expect(first.sql).toContain('ON CONFLICT (id) DO UPDATE SET')
      expect(first.params[0]).toBe('doc-1')
      expect(first.params[1]).toBe('[0.1,0.2,0.3]')
      expect(first.params[2]).toBe('{"source":"test"}')
      expect(first.params[3]).toBe('hello')

      const second = getCall(queryFn, 1)
      expect(second.params[3]).toBeNull() // undefined text -> null
    })
  })

  describe('search', () => {
    it('generates ORDER BY cosine distance with parameterized query', async () => {
      queryFn.mockResolvedValueOnce({
        rows: [
          { id: 'doc-1', score: 0.95, metadata: { source: 'test' }, text: 'hello' },
        ],
      })

      const results = await adapter.search('docs', {
        vector: [0.1, 0.2, 0.3],
        limit: 10,
      })

      const call = getCall(queryFn, 0)
      expect(call.sql).toContain('1 - (vector <=> $1) as score')
      expect(call.sql).toContain('ORDER BY vector <=> $1')
      expect(call.sql).toContain('LIMIT $2')
      expect(call.params[0]).toBe('[0.1,0.2,0.3]')
      expect(call.params[1]).toBe(10)
      expect(results).toHaveLength(1)
      expect(results[0]!.id).toBe('doc-1')
      expect(results[0]!.score).toBe(0.95)
    })

    it('applies eq filter as metadata->>field = $N', async () => {
      queryFn.mockResolvedValueOnce({ rows: [] })

      await adapter.search('docs', {
        vector: [0.1],
        limit: 5,
        filter: { field: 'category', op: 'eq', value: 'auth' },
      })

      const call = getCall(queryFn, 0)
      expect(call.sql).toContain("metadata->>'category' = $2")
      expect(call.params[1]).toBe('auth')
    })

    it('applies gte filter with numeric cast', async () => {
      queryFn.mockResolvedValueOnce({ rows: [] })

      await adapter.search('docs', {
        vector: [0.1],
        limit: 5,
        filter: { field: 'score', op: 'gte', value: 0.8 },
      })

      const call = getCall(queryFn, 0)
      expect(call.sql).toContain("(metadata->>'score')::numeric >= $2")
      expect(call.params[1]).toBe(0.8)
    })

    it('applies AND filter as SQL AND', async () => {
      queryFn.mockResolvedValueOnce({ rows: [] })

      await adapter.search('docs', {
        vector: [0.1],
        limit: 5,
        filter: {
          and: [
            { field: 'status', op: 'eq', value: 'active' },
            { field: 'score', op: 'gte', value: 0.5 },
          ],
        },
      })

      const call = getCall(queryFn, 0)
      expect(call.sql).toContain('AND')
      expect(call.sql).toContain("metadata->>'status' = $2")
      expect(call.sql).toContain("(metadata->>'score')::numeric >= $3")
    })

    it('applies OR filter as SQL OR', async () => {
      queryFn.mockResolvedValueOnce({ rows: [] })

      await adapter.search('docs', {
        vector: [0.1],
        limit: 5,
        filter: {
          or: [
            { field: 'type', op: 'eq', value: 'article' },
            { field: 'type', op: 'eq', value: 'blog' },
          ],
        },
      })

      const call = getCall(queryFn, 0)
      expect(call.sql).toContain('OR')
      expect(call.params).toContain('article')
      expect(call.params).toContain('blog')
    })

    it('applies in filter as ANY($N)', async () => {
      queryFn.mockResolvedValueOnce({ rows: [] })

      await adapter.search('docs', {
        vector: [0.1],
        limit: 5,
        filter: { field: 'tags', op: 'in', value: ['a', 'b'] },
      })

      const call = getCall(queryFn, 0)
      expect(call.sql).toContain("metadata->>'tags' = ANY($2)")
      expect(call.params[1]).toEqual(['a', 'b'])
    })

    it('applies minScore filter', async () => {
      queryFn.mockResolvedValueOnce({ rows: [] })

      await adapter.search('docs', {
        vector: [0.1],
        limit: 5,
        minScore: 0.7,
      })

      const call = getCall(queryFn, 0)
      expect(call.sql).toContain('1 - (vector <=> $1) >= $2')
      expect(call.params[1]).toBe(0.7)
    })

    it('includes vector column when includeVectors is true', async () => {
      queryFn.mockResolvedValueOnce({
        rows: [{ id: 'doc-1', score: 0.9, metadata: {}, text: null, vector: [0.1, 0.2] }],
      })

      const results = await adapter.search('docs', {
        vector: [0.1, 0.2],
        limit: 1,
        includeVectors: true,
      })

      const call = getCall(queryFn, 0)
      expect(call.sql).toContain('vector')
      expect(results[0]!.vector).toEqual([0.1, 0.2])
    })
  })

  describe('delete', () => {
    it('deletes by ids using ANY($1)', async () => {
      await adapter.delete('docs', { ids: ['doc-1', 'doc-2'] })

      const call = getCall(queryFn, 0)
      expect(call.sql).toContain('DELETE FROM forge_vectors_docs')
      expect(call.sql).toContain('WHERE id = ANY($1)')
      expect(call.params[0]).toEqual(['doc-1', 'doc-2'])
    })

    it('deletes by metadata filter', async () => {
      await adapter.delete('docs', {
        filter: { field: 'expired', op: 'eq', value: true },
      })

      const call = getCall(queryFn, 0)
      expect(call.sql).toContain('DELETE FROM forge_vectors_docs')
      expect(call.sql).toContain("metadata->>'expired' = $1")
      expect(call.params[0]).toBe(true)
    })
  })

  describe('count', () => {
    it('generates SELECT COUNT(*)', async () => {
      queryFn.mockResolvedValueOnce({
        rows: [{ count: 42 }],
      })

      const result = await adapter.count('docs')

      expect(getCall(queryFn, 0).sql).toBe('SELECT COUNT(*) as count FROM forge_vectors_docs')
      expect(result).toBe(42)
    })
  })

  describe('healthCheck', () => {
    it('returns healthy when SELECT 1 succeeds', async () => {
      queryFn.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

      const health = await adapter.healthCheck()

      expect(health.healthy).toBe(true)
      expect(health.provider).toBe('pgvector')
      expect(health.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it('returns unhealthy when query fails', async () => {
      queryFn.mockRejectedValueOnce(new Error('connection refused'))

      const health = await adapter.healthCheck()

      expect(health.healthy).toBe(false)
      expect(health.provider).toBe('pgvector')
    })
  })

  describe('parameterized queries (SQL injection prevention)', () => {
    it('never interpolates user values into SQL', async () => {
      await adapter.upsert('docs', [
        {
          id: "'; DROP TABLE users; --",
          vector: [0.1],
          metadata: { key: "'; DROP TABLE users; --" },
          text: "'; DROP TABLE users; --",
        },
      ])

      const call = getCall(queryFn, 0)
      // Malicious values should be in params, not in the SQL string
      expect(call.sql).not.toContain('DROP TABLE users')
      expect(call.params).toContain("'; DROP TABLE users; --")
    })

    it('rejects invalid collection names', async () => {
      await expect(
        adapter.createCollection("'; DROP TABLE--", { dimensions: 128 }),
      ).rejects.toThrow('Invalid collection name')
    })
  })

  describe('contains filter', () => {
    it('translates contains to ILIKE', async () => {
      queryFn.mockResolvedValueOnce({ rows: [] })

      await adapter.search('docs', {
        vector: [0.1],
        limit: 5,
        filter: { field: 'title', op: 'contains', value: 'search' },
      })

      const call = getCall(queryFn, 0)
      expect(call.sql).toContain("metadata->>'title' ILIKE $2")
      expect(call.params[1]).toBe('%search%')
    })
  })

  describe('close', () => {
    it('completes without error', async () => {
      await expect(adapter.close()).resolves.toBeUndefined()
    })
  })
})
