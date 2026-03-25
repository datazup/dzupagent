import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ChromaDBAdapter } from '../adapters/chroma-adapter.js'

/** Shape of captured fetch calls */
interface CapturedFetchCall {
  url: string
  method: string
  body: unknown
}

/** Create a mock fetch that captures calls and returns configurable responses */
function createMockFetch() {
  const calls: CapturedFetchCall[] = []
  let nextResponses: Array<{ status: number; body: unknown }> = []

  const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body as string) as unknown : undefined

    calls.push({ url: urlStr, method, body })

    const next = nextResponses.shift()
    const status = next?.status ?? 200
    const responseBody = next?.body ?? {}

    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    } as Response
  })

  function queueResponse(status: number, body: unknown): void {
    nextResponses.push({ status, body })
  }

  function resetResponses(): void {
    nextResponses = []
    calls.length = 0
  }

  return { fetch: mockFetch, calls, queueResponse, resetResponses }
}

describe('ChromaDBAdapter', () => {
  let mockFetch: ReturnType<typeof createMockFetch>
  let adapter: ChromaDBAdapter

  beforeEach(() => {
    mockFetch = createMockFetch()
    adapter = new ChromaDBAdapter({
      url: 'http://chroma:8000',
      fetch: mockFetch.fetch as unknown as typeof globalThis.fetch,
    })
  })

  it('has provider set to chroma', () => {
    expect(adapter.provider).toBe('chroma')
  })

  describe('createCollection', () => {
    it('sends POST to /api/v1/collections', async () => {
      mockFetch.queueResponse(200, { id: 'uuid-123', name: 'docs', metadata: {} })

      await adapter.createCollection('docs', { dimensions: 1536, metric: 'cosine' })

      expect(mockFetch.calls).toHaveLength(1)
      const call = mockFetch.calls[0]!
      expect(call.url).toBe('http://chroma:8000/api/v1/collections')
      expect(call.method).toBe('POST')
      expect(call.body).toEqual({
        name: 'docs',
        metadata: { 'hnsw:space': 'cosine' },
        get_or_create: true,
      })
    })

    it('maps dot_product metric to ip', async () => {
      mockFetch.queueResponse(200, { id: 'uuid-456', name: 'docs', metadata: {} })

      await adapter.createCollection('docs', { dimensions: 768, metric: 'dot_product' })

      const call = mockFetch.calls[0]!
      expect((call.body as Record<string, unknown>)['metadata']).toEqual({
        'hnsw:space': 'ip',
      })
    })

    it('maps euclidean metric to l2', async () => {
      mockFetch.queueResponse(200, { id: 'uuid-789', name: 'docs', metadata: {} })

      await adapter.createCollection('docs', { dimensions: 768, metric: 'euclidean' })

      const call = mockFetch.calls[0]!
      expect((call.body as Record<string, unknown>)['metadata']).toEqual({
        'hnsw:space': 'l2',
      })
    })
  })

  describe('deleteCollection', () => {
    it('sends DELETE to /api/v1/collections/{name}', async () => {
      mockFetch.queueResponse(200, {})

      await adapter.deleteCollection('docs')

      const call = mockFetch.calls[0]!
      expect(call.url).toBe('http://chroma:8000/api/v1/collections/docs')
      expect(call.method).toBe('DELETE')
    })
  })

  describe('listCollections', () => {
    it('sends GET to /api/v1/collections', async () => {
      mockFetch.queueResponse(200, [
        { id: 'uuid-1', name: 'docs', metadata: {} },
        { id: 'uuid-2', name: 'images', metadata: {} },
      ])

      const result = await adapter.listCollections()

      expect(mockFetch.calls[0]!.url).toBe('http://chroma:8000/api/v1/collections')
      expect(result).toEqual(['docs', 'images'])
    })
  })

  describe('collectionExists', () => {
    it('returns true when collection is found (200)', async () => {
      mockFetch.queueResponse(200, { id: 'uuid-1', name: 'docs', metadata: {} })

      const exists = await adapter.collectionExists('docs')
      expect(exists).toBe(true)
    })

    it('returns false when collection is not found (error)', async () => {
      mockFetch.queueResponse(404, { error: 'not found' })

      const exists = await adapter.collectionExists('missing')
      expect(exists).toBe(false)
    })
  })

  describe('upsert', () => {
    it('sends ids + embeddings + metadatas + documents', async () => {
      // First call: get collection UUID
      mockFetch.queueResponse(200, { id: 'uuid-123', name: 'docs', metadata: {} })
      // Second call: upsert
      mockFetch.queueResponse(200, {})

      await adapter.upsert('docs', [
        { id: 'doc-1', vector: [0.1, 0.2], metadata: { source: 'test' }, text: 'hello' },
        { id: 'doc-2', vector: [0.3, 0.4], metadata: {}, text: undefined },
      ])

      // Should have 2 calls: getCollectionId + upsert
      expect(mockFetch.calls).toHaveLength(2)

      const upsertCall = mockFetch.calls[1]!
      expect(upsertCall.url).toBe('http://chroma:8000/api/v1/collections/uuid-123/upsert')
      expect(upsertCall.method).toBe('POST')
      expect(upsertCall.body).toEqual({
        ids: ['doc-1', 'doc-2'],
        embeddings: [[0.1, 0.2], [0.3, 0.4]],
        metadatas: [{ source: 'test' }, {}],
        documents: ['hello', ''],
      })
    })
  })

  describe('search', () => {
    it('sends query_embeddings + n_results + where', async () => {
      // Get collection
      mockFetch.queueResponse(200, { id: 'uuid-123', name: 'docs', metadata: {} })
      // Query
      mockFetch.queueResponse(200, {
        ids: [['doc-1', 'doc-2']],
        distances: [[0.1, 0.3]],
        metadatas: [[{ source: 'test' }, {}]],
        documents: [['hello', 'world']],
        embeddings: null,
      })

      const results = await adapter.search('docs', {
        vector: [0.1, 0.2],
        limit: 10,
        filter: { field: 'category', op: 'eq', value: 'auth' },
      })

      const queryCall = mockFetch.calls[1]!
      expect(queryCall.url).toContain('/collections/uuid-123/query')
      expect(queryCall.method).toBe('POST')
      const body = queryCall.body as Record<string, unknown>
      expect(body['query_embeddings']).toEqual([[0.1, 0.2]])
      expect(body['n_results']).toBe(10)
      expect(body['where']).toEqual({ category: { $eq: 'auth' } })

      expect(results).toHaveLength(2)
      expect(results[0]!.id).toBe('doc-1')
      expect(results[0]!.score).toBeCloseTo(0.9) // 1 - 0.1
      expect(results[0]!.text).toBe('hello')
      expect(results[1]!.id).toBe('doc-2')
      expect(results[1]!.score).toBeCloseTo(0.7) // 1 - 0.3
    })

    it('filters results by minScore', async () => {
      mockFetch.queueResponse(200, { id: 'uuid-123', name: 'docs', metadata: {} })
      mockFetch.queueResponse(200, {
        ids: [['doc-1', 'doc-2']],
        distances: [[0.1, 0.5]],
        metadatas: [[{}, {}]],
        documents: [[null, null]],
        embeddings: null,
      })

      const results = await adapter.search('docs', {
        vector: [0.1],
        limit: 10,
        minScore: 0.6,
      })

      // doc-1 score=0.9 (passes), doc-2 score=0.5 (filtered out)
      expect(results).toHaveLength(1)
      expect(results[0]!.id).toBe('doc-1')
    })
  })

  describe('filter translation', () => {
    it('translates eq to $eq', async () => {
      mockFetch.queueResponse(200, { id: 'uuid-123', name: 'docs', metadata: {} })
      mockFetch.queueResponse(200, {
        ids: [[]], distances: [[]], metadatas: [[]], documents: [[]], embeddings: null,
      })

      await adapter.search('docs', {
        vector: [0.1],
        limit: 5,
        filter: { field: 'status', op: 'eq', value: 'active' },
      })

      const body = mockFetch.calls[1]!.body as Record<string, unknown>
      expect(body['where']).toEqual({ status: { $eq: 'active' } })
    })

    it('translates gte to $gte', async () => {
      mockFetch.queueResponse(200, { id: 'uuid-123', name: 'docs', metadata: {} })
      mockFetch.queueResponse(200, {
        ids: [[]], distances: [[]], metadatas: [[]], documents: [[]], embeddings: null,
      })

      await adapter.search('docs', {
        vector: [0.1],
        limit: 5,
        filter: { field: 'score', op: 'gte', value: 0.8 },
      })

      const body = mockFetch.calls[1]!.body as Record<string, unknown>
      expect(body['where']).toEqual({ score: { $gte: 0.8 } })
    })

    it('translates AND to $and', async () => {
      mockFetch.queueResponse(200, { id: 'uuid-123', name: 'docs', metadata: {} })
      mockFetch.queueResponse(200, {
        ids: [[]], distances: [[]], metadatas: [[]], documents: [[]], embeddings: null,
      })

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

      const body = mockFetch.calls[1]!.body as Record<string, unknown>
      expect(body['where']).toEqual({
        $and: [
          { status: { $eq: 'active' } },
          { score: { $gte: 0.5 } },
        ],
      })
    })

    it('translates OR to $or', async () => {
      mockFetch.queueResponse(200, { id: 'uuid-123', name: 'docs', metadata: {} })
      mockFetch.queueResponse(200, {
        ids: [[]], distances: [[]], metadatas: [[]], documents: [[]], embeddings: null,
      })

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

      const body = mockFetch.calls[1]!.body as Record<string, unknown>
      expect(body['where']).toEqual({
        $or: [
          { type: { $eq: 'article' } },
          { type: { $eq: 'blog' } },
        ],
      })
    })

    it('translates in to $in', async () => {
      mockFetch.queueResponse(200, { id: 'uuid-123', name: 'docs', metadata: {} })
      mockFetch.queueResponse(200, {
        ids: [[]], distances: [[]], metadatas: [[]], documents: [[]], embeddings: null,
      })

      await adapter.search('docs', {
        vector: [0.1],
        limit: 5,
        filter: { field: 'tags', op: 'in', value: ['a', 'b'] },
      })

      const body = mockFetch.calls[1]!.body as Record<string, unknown>
      expect(body['where']).toEqual({ tags: { $in: ['a', 'b'] } })
    })
  })

  describe('delete', () => {
    it('deletes by ids', async () => {
      mockFetch.queueResponse(200, { id: 'uuid-123', name: 'docs', metadata: {} })
      mockFetch.queueResponse(200, {})

      await adapter.delete('docs', { ids: ['doc-1', 'doc-2'] })

      const deleteCall = mockFetch.calls[1]!
      expect(deleteCall.url).toContain('/collections/uuid-123/delete')
      expect(deleteCall.method).toBe('POST')
      expect(deleteCall.body).toEqual({ ids: ['doc-1', 'doc-2'] })
    })

    it('deletes by filter using where clause', async () => {
      mockFetch.queueResponse(200, { id: 'uuid-123', name: 'docs', metadata: {} })
      mockFetch.queueResponse(200, {})

      await adapter.delete('docs', {
        filter: { field: 'expired', op: 'eq', value: true },
      })

      const deleteCall = mockFetch.calls[1]!
      expect(deleteCall.body).toEqual({
        where: { expired: { $eq: true } },
      })
    })
  })

  describe('count', () => {
    it('returns count from /collections/{id}/count', async () => {
      mockFetch.queueResponse(200, { id: 'uuid-123', name: 'docs', metadata: {} })
      mockFetch.queueResponse(200, 42)

      const result = await adapter.count('docs')

      expect(mockFetch.calls[1]!.url).toContain('/collections/uuid-123/count')
      expect(result).toBe(42)
    })
  })

  describe('healthCheck', () => {
    it('calls /api/v1/heartbeat and returns healthy', async () => {
      mockFetch.queueResponse(200, { 'nanosecond heartbeat': 123456789 })

      const health = await adapter.healthCheck()

      expect(mockFetch.calls[0]!.url).toBe('http://chroma:8000/api/v1/heartbeat')
      expect(health.healthy).toBe(true)
      expect(health.provider).toBe('chroma')
      expect(health.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it('returns unhealthy when heartbeat fails', async () => {
      mockFetch.queueResponse(500, { error: 'internal error' })

      const health = await adapter.healthCheck()

      expect(health.healthy).toBe(false)
      expect(health.provider).toBe('chroma')
    })
  })

  describe('collection UUID caching', () => {
    it('caches UUID after first lookup', async () => {
      // First operation: collection lookup + upsert
      mockFetch.queueResponse(200, { id: 'uuid-123', name: 'docs', metadata: {} })
      mockFetch.queueResponse(200, {})
      // Second operation: only upsert (cached UUID)
      mockFetch.queueResponse(200, {})

      await adapter.upsert('docs', [
        { id: 'doc-1', vector: [0.1], metadata: {} },
      ])
      await adapter.upsert('docs', [
        { id: 'doc-2', vector: [0.2], metadata: {} },
      ])

      // 3 calls total: lookup + upsert1 + upsert2 (no second lookup)
      expect(mockFetch.calls).toHaveLength(3)
      // Second upsert should use cached UUID
      expect(mockFetch.calls[2]!.url).toContain('/collections/uuid-123/upsert')
    })

    it('caches UUID after createCollection', async () => {
      mockFetch.queueResponse(200, { id: 'uuid-456', name: 'newcol', metadata: {} })
      // upsert uses cached UUID
      mockFetch.queueResponse(200, {})

      await adapter.createCollection('newcol', { dimensions: 128 })
      await adapter.upsert('newcol', [
        { id: 'doc-1', vector: [0.1], metadata: {} },
      ])

      // 2 calls: create + upsert (no separate lookup)
      expect(mockFetch.calls).toHaveLength(2)
      expect(mockFetch.calls[1]!.url).toContain('/collections/uuid-456/upsert')
    })
  })

  describe('tenant and database', () => {
    it('includes tenant and database in API base URL', async () => {
      const tenantAdapter = new ChromaDBAdapter({
        url: 'http://chroma:8000',
        tenant: 'my-tenant',
        database: 'my-db',
        fetch: mockFetch.fetch as unknown as typeof globalThis.fetch,
      })

      mockFetch.queueResponse(200, [])
      await tenantAdapter.listCollections()

      expect(mockFetch.calls[0]!.url).toBe(
        'http://chroma:8000/api/v1/tenants/my-tenant/databases/my-db/collections',
      )
    })
  })

  describe('close', () => {
    it('clears cached collection IDs', async () => {
      // Populate cache
      mockFetch.queueResponse(200, { id: 'uuid-123', name: 'docs', metadata: {} })
      mockFetch.queueResponse(200, {})
      await adapter.upsert('docs', [{ id: 'doc-1', vector: [0.1], metadata: {} }])

      await adapter.close()

      // After close, should re-lookup collection
      mockFetch.queueResponse(200, { id: 'uuid-123', name: 'docs', metadata: {} })
      mockFetch.queueResponse(200, {})
      await adapter.upsert('docs', [{ id: 'doc-2', vector: [0.2], metadata: {} }])

      // Should have 4 calls: lookup + upsert + lookup_again + upsert
      expect(mockFetch.calls).toHaveLength(4)
    })
  })
})
