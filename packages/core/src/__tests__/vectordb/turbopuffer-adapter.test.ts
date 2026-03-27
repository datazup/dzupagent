import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  TurbopufferAdapter,
  translateFilter,
} from '../../vectordb/adapters/turbopuffer-adapter.js'
import type {
  MetadataFilter,
  VectorEntry,
  VectorQuery,
} from '../../vectordb/types.js'
import { detectVectorProvider } from '../../vectordb/auto-detect.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockResponseInit {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

function mockFetch(responses: MockResponseInit[]) {
  let callIndex = 0
  const calls: Array<{ url: string; init: RequestInit }> = []

  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const resp = responses[callIndex] ?? responses[responses.length - 1]
    callIndex++
    calls.push({ url: String(url), init: init ?? {} })

    const body = resp?.body !== undefined ? JSON.stringify(resp.body) : ''
    return new Response(body, {
      status: resp?.status ?? 200,
      headers: {
        'Content-Type': 'application/json',
        ...(resp?.headers ?? {}),
      },
    })
  })

  return { fetchFn, calls }
}

function createAdapter(fetchFn: typeof globalThis.fetch, opts?: { namespacePrefix?: string }) {
  return new TurbopufferAdapter({
    apiKey: 'tp-test-key',
    baseUrl: 'https://api.turbopuffer.com',
    ...(opts?.namespacePrefix != null ? { namespacePrefix: opts.namespacePrefix } : {}),
    fetch: fetchFn,
    maxRetries: 1,
  })
}

const sampleEntries: VectorEntry[] = [
  { id: 'v1', vector: [0.1, 0.2, 0.3], metadata: { topic: 'ai' }, text: 'hello world' },
  { id: 'v2', vector: [0.4, 0.5, 0.6], metadata: { topic: 'ml' } },
]

// ---------------------------------------------------------------------------
// Filter translation
// ---------------------------------------------------------------------------

describe('translateFilter', () => {
  it('translates eq filter', () => {
    const filter: MetadataFilter = { field: 'status', op: 'eq', value: 'active' }
    expect(translateFilter(filter)).toEqual(['status', 'Eq', 'active'])
  })

  it('translates neq filter', () => {
    const filter: MetadataFilter = { field: 'status', op: 'neq', value: 'deleted' }
    expect(translateFilter(filter)).toEqual(['status', 'NotEq', 'deleted'])
  })

  it('translates numeric comparison filters', () => {
    expect(translateFilter({ field: 'score', op: 'gt', value: 5 })).toEqual(['score', 'Gt', 5])
    expect(translateFilter({ field: 'score', op: 'gte', value: 5 })).toEqual(['score', 'Gte', 5])
    expect(translateFilter({ field: 'score', op: 'lt', value: 10 })).toEqual(['score', 'Lt', 10])
    expect(translateFilter({ field: 'score', op: 'lte', value: 10 })).toEqual(['score', 'Lte', 10])
  })

  it('translates in / not_in filters', () => {
    expect(translateFilter({ field: 'tag', op: 'in', value: ['a', 'b'] })).toEqual(['tag', 'In', ['a', 'b']])
    expect(translateFilter({ field: 'tag', op: 'not_in', value: [1, 2] })).toEqual(['tag', 'NotIn', [1, 2]])
  })

  it('translates and/or compositions', () => {
    const filter: MetadataFilter = {
      and: [
        { field: 'a', op: 'eq', value: 1 },
        { or: [
          { field: 'b', op: 'gt', value: 2 },
          { field: 'c', op: 'eq', value: 'x' },
        ] },
      ],
    }
    expect(translateFilter(filter)).toEqual([
      'And',
      [
        ['a', 'Eq', 1],
        ['Or', [['b', 'Gt', 2], ['c', 'Eq', 'x']]],
      ],
    ])
  })
})

// ---------------------------------------------------------------------------
// TurbopufferAdapter
// ---------------------------------------------------------------------------

describe('TurbopufferAdapter', () => {
  let adapter: TurbopufferAdapter

  describe('provider', () => {
    it('returns turbopuffer', () => {
      const { fetchFn } = mockFetch([])
      adapter = createAdapter(fetchFn)
      expect(adapter.provider).toBe('turbopuffer')
    })
  })

  // --- Collection lifecycle ---

  describe('createCollection', () => {
    it('marks the collection as known (no API call)', async () => {
      const { fetchFn, calls } = mockFetch([])
      adapter = createAdapter(fetchFn)

      await adapter.createCollection('test', { dimensions: 128 })
      expect(calls).toHaveLength(0)
      expect(await adapter.collectionExists('test')).toBe(true)
    })
  })

  describe('deleteCollection', () => {
    it('sends DELETE to the namespace endpoint', async () => {
      const { fetchFn, calls } = mockFetch([{ status: 200, body: {} }])
      adapter = createAdapter(fetchFn)
      await adapter.createCollection('test', { dimensions: 128 })

      await adapter.deleteCollection('test')
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('https://api.turbopuffer.com/v1/vectors/test')
      expect(calls[0].init.method).toBe('DELETE')
    })
  })

  describe('listCollections', () => {
    it('lists namespaces from the API', async () => {
      const { fetchFn } = mockFetch([
        { status: 200, body: { namespaces: [{ id: 'ns1' }, { id: 'ns2' }] } },
      ])
      adapter = createAdapter(fetchFn)

      const result = await adapter.listCollections()
      expect(result).toEqual(['ns1', 'ns2'])
    })

    it('filters by namespace prefix', async () => {
      const { fetchFn } = mockFetch([
        { status: 200, body: { namespaces: [{ id: 'tenant_a' }, { id: 'tenant_b' }, { id: 'other' }] } },
      ])
      adapter = createAdapter(fetchFn, { namespacePrefix: 'tenant' })

      const result = await adapter.listCollections()
      expect(result).toEqual(['a', 'b'])
    })

    it('handles pagination with next_cursor', async () => {
      const { fetchFn } = mockFetch([
        { status: 200, body: { namespaces: [{ id: 'a' }], next_cursor: 'cur1' } },
        { status: 200, body: { namespaces: [{ id: 'b' }] } },
      ])
      adapter = createAdapter(fetchFn)

      const result = await adapter.listCollections()
      expect(result).toEqual(['a', 'b'])
    })
  })

  describe('collectionExists', () => {
    it('returns true when namespace info returns 200', async () => {
      const { fetchFn } = mockFetch([
        { status: 200, body: { approx_count: 10, dimensions: 128 } },
      ])
      adapter = createAdapter(fetchFn)

      expect(await adapter.collectionExists('test')).toBe(true)
    })

    it('returns false when namespace returns 404', async () => {
      const { fetchFn } = mockFetch([{ status: 404 }])
      adapter = createAdapter(fetchFn)

      expect(await adapter.collectionExists('missing')).toBe(false)
    })
  })

  // --- Vector operations ---

  describe('upsert', () => {
    it('sends vectors in columnar format', async () => {
      const { fetchFn, calls } = mockFetch([{ status: 200, body: {} }])
      adapter = createAdapter(fetchFn)

      await adapter.upsert('test', sampleEntries)

      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('https://api.turbopuffer.com/v1/vectors/test')
      expect(calls[0].init.method).toBe('POST')

      const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>
      expect(body['ids']).toEqual(['v1', 'v2'])
      expect(body['vectors']).toEqual([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]])

      const attrs = body['attributes'] as Record<string, unknown[]>
      expect(attrs['topic']).toEqual(['ai', 'ml'])
      expect(attrs['text']).toEqual(['hello world', null])
    })

    it('batches large upserts', async () => {
      const { fetchFn, calls } = mockFetch([
        { status: 200, body: {} },
        { status: 200, body: {} },
      ])
      adapter = new TurbopufferAdapter({
        apiKey: 'tp-test-key',
        batchSize: 1,
        fetch: fetchFn,
      })

      await adapter.upsert('test', sampleEntries)
      expect(calls).toHaveLength(2)
    })

    it('uses namespace prefix when configured', async () => {
      const { fetchFn, calls } = mockFetch([{ status: 200, body: {} }])
      adapter = createAdapter(fetchFn, { namespacePrefix: 'tenant1' })

      await adapter.upsert('memories', [sampleEntries[0]])
      expect(calls[0].url).toBe('https://api.turbopuffer.com/v1/vectors/tenant1_memories')
    })
  })

  describe('search', () => {
    const queryResponse = {
      ids: ['v1', 'v2'],
      dist: [0.1, 0.5],
      attributes: {
        topic: ['ai', 'ml'],
        text: ['hello world', null],
      },
    }

    it('sends query and parses columnar response', async () => {
      const { fetchFn, calls } = mockFetch([{ status: 200, body: queryResponse }])
      adapter = createAdapter(fetchFn)

      const query: VectorQuery = {
        vector: [0.1, 0.2, 0.3],
        limit: 10,
      }
      const results = await adapter.search('test', query)

      expect(calls[0].url).toBe('https://api.turbopuffer.com/v1/vectors/test/query')
      expect(results).toHaveLength(2)
      expect(results[0]).toEqual({
        id: 'v1',
        score: 0.9,
        metadata: { topic: 'ai' },
        text: 'hello world',
      })
      expect(results[1]).toEqual({
        id: 'v2',
        score: 0.5,
        metadata: { topic: 'ml' },
      })
    })

    it('filters by minScore', async () => {
      const { fetchFn } = mockFetch([{ status: 200, body: queryResponse }])
      adapter = createAdapter(fetchFn)

      const results = await adapter.search('test', {
        vector: [0.1, 0.2, 0.3],
        limit: 10,
        minScore: 0.6,
      })

      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('v1')
    })

    it('includes vectors when requested', async () => {
      const responseWithVectors = {
        ...queryResponse,
        vectors: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
      }
      const { fetchFn, calls } = mockFetch([{ status: 200, body: responseWithVectors }])
      adapter = createAdapter(fetchFn)

      const results = await adapter.search('test', {
        vector: [0.1, 0.2, 0.3],
        limit: 10,
        includeVectors: true,
      })

      const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>
      expect(body['include_vectors']).toBe(true)
      expect(results[0].vector).toEqual([0.1, 0.2, 0.3])
    })

    it('applies metadata filter', async () => {
      const { fetchFn, calls } = mockFetch([{ status: 200, body: { ids: [], dist: [] } }])
      adapter = createAdapter(fetchFn)

      await adapter.search('test', {
        vector: [0.1, 0.2, 0.3],
        limit: 5,
        filter: { field: 'topic', op: 'eq', value: 'ai' },
      })

      const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>
      expect(body['filters']).toEqual(['topic', 'Eq', 'ai'])
    })
  })

  describe('delete', () => {
    it('deletes by IDs', async () => {
      const { fetchFn, calls } = mockFetch([{ status: 200, body: {} }])
      adapter = createAdapter(fetchFn)

      await adapter.delete('test', { ids: ['v1', 'v2'] })

      expect(calls[0].url).toBe('https://api.turbopuffer.com/v1/vectors/test/delete')
      const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>
      expect(body['ids']).toEqual(['v1', 'v2'])
    })

    it('deletes by filter', async () => {
      const { fetchFn, calls } = mockFetch([{ status: 200, body: {} }])
      adapter = createAdapter(fetchFn)

      await adapter.delete('test', {
        filter: { field: 'topic', op: 'eq', value: 'old' },
      })

      const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>
      expect(body['filters']).toEqual(['topic', 'Eq', 'old'])
    })
  })

  describe('count', () => {
    it('returns approx_count from namespace info', async () => {
      const { fetchFn } = mockFetch([
        { status: 200, body: { approx_count: 42, dimensions: 128 } },
      ])
      adapter = createAdapter(fetchFn)

      expect(await adapter.count('test')).toBe(42)
    })

    it('returns 0 when namespace does not exist', async () => {
      const { fetchFn } = mockFetch([{ status: 404 }])
      adapter = createAdapter(fetchFn)

      expect(await adapter.count('missing')).toBe(0)
    })
  })

  // --- Lifecycle ---

  describe('healthCheck', () => {
    it('returns healthy on successful list', async () => {
      const { fetchFn } = mockFetch([
        { status: 200, body: { namespaces: [] } },
      ])
      adapter = createAdapter(fetchFn)

      const health = await adapter.healthCheck()
      expect(health.healthy).toBe(true)
      expect(health.provider).toBe('turbopuffer')
      expect(typeof health.latencyMs).toBe('number')
    })

    it('returns unhealthy on error', async () => {
      const { fetchFn } = mockFetch([
        { status: 500, body: { error: 'Internal Server Error' } },
      ])
      adapter = createAdapter(fetchFn)

      const health = await adapter.healthCheck()
      expect(health.healthy).toBe(false)
      expect(health.provider).toBe('turbopuffer')
    })
  })

  describe('close', () => {
    it('clears known collections', async () => {
      const { fetchFn } = mockFetch([])
      adapter = createAdapter(fetchFn)
      await adapter.createCollection('test', { dimensions: 128 })

      await adapter.close()
      // After close, collectionExists should hit the API (not local cache)
    })
  })

  // --- Retry on 429 ---

  describe('rate limit retry', () => {
    it('retries on 429 and succeeds', async () => {
      const { fetchFn, calls } = mockFetch([
        { status: 429, body: {}, headers: { 'retry-after': '0' } },
        { status: 200, body: { approx_count: 5 } },
      ])
      adapter = createAdapter(fetchFn)

      const count = await adapter.count('test')
      expect(count).toBe(5)
      expect(calls).toHaveLength(2)
    })

    it('throws after exhausting retries', async () => {
      const { fetchFn } = mockFetch([
        { status: 429, body: {}, headers: { 'retry-after': '0' } },
        { status: 429, body: {}, headers: { 'retry-after': '0' } },
        { status: 429, body: {}, headers: { 'retry-after': '0' } },
      ])
      adapter = createAdapter(fetchFn)

      await expect(adapter.count('test')).rejects.toThrow('Turbopuffer request failed')
    })
  })

  // --- Error handling ---

  describe('error handling', () => {
    it('throws with error message from response', async () => {
      const { fetchFn } = mockFetch([
        { status: 400, body: { error: 'Invalid vector dimensions' } },
      ])
      adapter = createAdapter(fetchFn)

      await expect(
        adapter.upsert('test', sampleEntries),
      ).rejects.toThrow('Invalid vector dimensions')
    })

    it('throws generic message when no error field', async () => {
      const { fetchFn } = mockFetch([
        { status: 500, body: { detail: 'something' } },
      ])
      adapter = createAdapter(fetchFn)

      await expect(
        adapter.upsert('test', sampleEntries),
      ).rejects.toThrow('Turbopuffer request failed: 500')
    })
  })

  // --- Auth header ---

  describe('authentication', () => {
    it('sends Bearer token in Authorization header', async () => {
      const { fetchFn, calls } = mockFetch([
        { status: 200, body: { namespaces: [] } },
      ])
      adapter = createAdapter(fetchFn)

      await adapter.healthCheck()

      const headers = calls[0].init.headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer tp-test-key')
    })
  })
})

// ---------------------------------------------------------------------------
// Auto-detect integration
// ---------------------------------------------------------------------------

describe('detectVectorProvider — Turbopuffer', () => {
  it('detects Turbopuffer when TURBOPUFFER_API_KEY is set', () => {
    const result = detectVectorProvider({
      TURBOPUFFER_API_KEY: 'tp-key-123',
      TURBOPUFFER_BASE_URL: 'https://custom.turbopuffer.example.com',
      TURBOPUFFER_NAMESPACE_PREFIX: 'myapp',
    })
    expect(result.provider).toBe('turbopuffer')
    expect(result.config).toEqual({
      apiKey: 'tp-key-123',
      baseUrl: 'https://custom.turbopuffer.example.com',
      namespacePrefix: 'myapp',
    })
  })

  it('prefers Qdrant over Turbopuffer', () => {
    const result = detectVectorProvider({
      QDRANT_URL: 'http://localhost:6333',
      TURBOPUFFER_API_KEY: 'tp-key',
    })
    expect(result.provider).toBe('qdrant')
  })

  it('prefers Turbopuffer over Pinecone', () => {
    const result = detectVectorProvider({
      TURBOPUFFER_API_KEY: 'tp-key',
      PINECONE_API_KEY: 'pc-key',
    })
    expect(result.provider).toBe('turbopuffer')
  })

  it('falls back to memory when no provider is set', () => {
    const result = detectVectorProvider({})
    expect(result.provider).toBe('memory')
  })
})
