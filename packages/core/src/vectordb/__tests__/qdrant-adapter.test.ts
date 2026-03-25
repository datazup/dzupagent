import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QdrantAdapter, translateFilter } from '../adapters/qdrant-adapter.js'
import type { MetadataFilter } from '../types.js'

/** Creates a mock fetch that returns the given body with the given status */
function mockFetch(status: number, body: unknown): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as unknown as typeof globalThis.fetch
}

describe('QdrantAdapter', () => {
  let fetchFn: ReturnType<typeof vi.fn>
  let adapter: QdrantAdapter

  beforeEach(() => {
    fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: {} }),
    })
    adapter = new QdrantAdapter({
      url: 'http://qdrant:6333',
      apiKey: 'test-key',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
  })

  // --- createCollection ---

  it('createCollection sends correct PUT request', async () => {
    await adapter.createCollection('docs', { dimensions: 1536, metric: 'cosine' })

    expect(fetchFn).toHaveBeenCalledWith(
      'http://qdrant:6333/collections/docs',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          vectors: { size: 1536, distance: 'Cosine' },
        }),
      }),
    )
  })

  it('createCollection defaults metric to cosine', async () => {
    await adapter.createCollection('docs', { dimensions: 768 })

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body).toEqual({ vectors: { size: 768, distance: 'Cosine' } })
  })

  it('createCollection maps euclidean metric', async () => {
    await adapter.createCollection('docs', { dimensions: 384, metric: 'euclidean' })

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body).toEqual({ vectors: { size: 384, distance: 'Euclid' } })
  })

  it('createCollection maps dot_product metric', async () => {
    await adapter.createCollection('docs', { dimensions: 384, metric: 'dot_product' })

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body).toEqual({ vectors: { size: 384, distance: 'Dot' } })
  })

  // --- upsert ---

  it('upsert sends points with vector + payload', async () => {
    await adapter.upsert('docs', [
      { id: 'v1', vector: [0.1, 0.2], metadata: { cat: 'auth' }, text: 'hello' },
      { id: 'v2', vector: [0.3, 0.4], metadata: { cat: 'db' } },
    ])

    expect(fetchFn).toHaveBeenCalledWith(
      'http://qdrant:6333/collections/docs/points',
      expect.objectContaining({ method: 'PUT' }),
    )

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as {
      points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>
    }
    expect(body.points).toHaveLength(2)
    expect(body.points[0]).toEqual({
      id: 'v1',
      vector: [0.1, 0.2],
      payload: { cat: 'auth', text: 'hello' },
    })
    expect(body.points[1]).toEqual({
      id: 'v2',
      vector: [0.3, 0.4],
      payload: { cat: 'db' },
    })
  })

  // --- search ---

  it('search sends query with filter translation', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          result: [
            { id: 'v1', score: 0.95, payload: { cat: 'auth', text: 'hello world' } },
          ],
        }),
    })

    const results = await adapter.search('docs', {
      vector: [0.1, 0.2],
      limit: 5,
      filter: { field: 'cat', op: 'eq', value: 'auth' },
    })

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body['filter']).toEqual({ must: [{ key: 'cat', match: { value: 'auth' } }] })
    expect(body['limit']).toBe(5)
    expect(body['with_payload']).toBe(true)
  })

  it('search returns VectorSearchResult with score', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          result: [
            { id: 'v1', score: 0.95, payload: { cat: 'auth', text: 'hello world' } },
            { id: 'v2', score: 0.8, payload: { cat: 'db' }, vector: [0.3, 0.4] },
          ],
        }),
    })

    const results = await adapter.search('docs', {
      vector: [0.1, 0.2],
      limit: 10,
      includeVectors: true,
    })

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      id: 'v1',
      score: 0.95,
      metadata: { cat: 'auth' },
      text: 'hello world',
    })
    expect(results[1]).toEqual({
      id: 'v2',
      score: 0.8,
      metadata: { cat: 'db' },
      vector: [0.3, 0.4],
    })
  })

  it('search passes minScore as score_threshold', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: [] }),
    })

    await adapter.search('docs', {
      vector: [0.1],
      limit: 5,
      minScore: 0.7,
    })

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body['score_threshold']).toBe(0.7)
  })

  // --- delete ---

  it('delete by ids sends points array', async () => {
    await adapter.delete('docs', { ids: ['v1', 'v2'] })

    expect(fetchFn).toHaveBeenCalledWith(
      'http://qdrant:6333/collections/docs/points/delete',
      expect.objectContaining({ method: 'POST' }),
    )

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body).toEqual({ points: ['v1', 'v2'] })
  })

  it('delete by filter translates filter', async () => {
    await adapter.delete('docs', {
      filter: { field: 'expired', op: 'eq', value: true },
    })

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body).toEqual({
      filter: { must: [{ key: 'expired', match: { value: true } }] },
    })
  })

  // --- count ---

  it('count calls points/count', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: { count: 42 } }),
    })

    const count = await adapter.count('docs')

    expect(fetchFn).toHaveBeenCalledWith(
      'http://qdrant:6333/collections/docs/points/count',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(count).toBe(42)
  })

  // --- healthCheck ---

  it('healthCheck calls /healthz and returns healthy', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    })

    const health = await adapter.healthCheck()

    expect(fetchFn).toHaveBeenCalledWith(
      'http://qdrant:6333/healthz',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(health.healthy).toBe(true)
    expect(health.provider).toBe('qdrant')
    expect(health.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('healthCheck returns unhealthy on fetch error', async () => {
    fetchFn.mockRejectedValueOnce(new Error('connection refused'))

    const health = await adapter.healthCheck()
    expect(health.healthy).toBe(false)
    expect(health.provider).toBe('qdrant')
  })

  // --- collectionExists ---

  it('collectionExists returns true for 200', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: {} }),
    })

    expect(await adapter.collectionExists('docs')).toBe(true)
  })

  it('collectionExists returns false for 404', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    })

    expect(await adapter.collectionExists('nonexistent')).toBe(false)
  })

  // --- listCollections ---

  it('listCollections returns collection names', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          result: { collections: [{ name: 'a' }, { name: 'b' }] },
        }),
    })

    const names = await adapter.listCollections()
    expect(names).toEqual(['a', 'b'])
  })

  // --- deleteCollection ---

  it('deleteCollection sends DELETE request', async () => {
    await adapter.deleteCollection('docs')

    expect(fetchFn).toHaveBeenCalledWith(
      'http://qdrant:6333/collections/docs',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  // --- API key header ---

  it('sends api-key header when configured', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: { collections: [] } }),
    })

    await adapter.listCollections()

    const headers = fetchFn.mock.calls[0][1].headers as Record<string, string>
    expect(headers['api-key']).toBe('test-key')
  })

  it('omits api-key header when not configured', async () => {
    const noKeyAdapter = new QdrantAdapter({
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })

    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ result: { collections: [] } }),
    })

    await noKeyAdapter.listCollections()

    const headers = fetchFn.mock.calls[0][1].headers as Record<string, string>
    expect(headers['api-key']).toBeUndefined()
  })

  // --- close ---

  it('close resolves without error', async () => {
    await expect(adapter.close()).resolves.toBeUndefined()
  })
})

describe('translateFilter (Qdrant)', () => {
  it('eq -> match.value', () => {
    const filter: MetadataFilter = { field: 'category', op: 'eq', value: 'auth' }
    expect(translateFilter(filter)).toEqual({
      must: [{ key: 'category', match: { value: 'auth' } }],
    })
  })

  it('neq -> must_not with match.value', () => {
    const filter: MetadataFilter = { field: 'status', op: 'neq', value: 'deleted' }
    expect(translateFilter(filter)).toEqual({
      must_not: [{ key: 'status', match: { value: 'deleted' } }],
    })
  })

  it('gte -> range.gte', () => {
    const filter: MetadataFilter = { field: 'score', op: 'gte', value: 0.8 }
    expect(translateFilter(filter)).toEqual({
      must: [{ key: 'score', range: { gte: 0.8 } }],
    })
  })

  it('gt -> range.gt', () => {
    const filter: MetadataFilter = { field: 'score', op: 'gt', value: 0.5 }
    expect(translateFilter(filter)).toEqual({
      must: [{ key: 'score', range: { gt: 0.5 } }],
    })
  })

  it('lt -> range.lt', () => {
    const filter: MetadataFilter = { field: 'score', op: 'lt', value: 1.0 }
    expect(translateFilter(filter)).toEqual({
      must: [{ key: 'score', range: { lt: 1.0 } }],
    })
  })

  it('lte -> range.lte', () => {
    const filter: MetadataFilter = { field: 'score', op: 'lte', value: 1.0 }
    expect(translateFilter(filter)).toEqual({
      must: [{ key: 'score', range: { lte: 1.0 } }],
    })
  })

  it('in -> match.any', () => {
    const filter: MetadataFilter = { field: 'tags', op: 'in', value: ['a', 'b'] }
    expect(translateFilter(filter)).toEqual({
      must: [{ key: 'tags', match: { any: ['a', 'b'] } }],
    })
  })

  it('not_in -> must_not with match.any', () => {
    const filter: MetadataFilter = { field: 'tags', op: 'not_in', value: [1, 2] }
    expect(translateFilter(filter)).toEqual({
      must_not: [{ key: 'tags', match: { any: [1, 2] } }],
    })
  })

  it('and -> must array', () => {
    const filter: MetadataFilter = {
      and: [
        { field: 'category', op: 'eq', value: 'auth' },
        { field: 'score', op: 'gte', value: 0.8 },
      ],
    }
    expect(translateFilter(filter)).toEqual({
      must: [
        { key: 'category', match: { value: 'auth' } },
        { key: 'score', range: { gte: 0.8 } },
      ],
    })
  })

  it('or -> should array', () => {
    const filter: MetadataFilter = {
      or: [
        { field: 'type', op: 'eq', value: 'article' },
        { field: 'type', op: 'eq', value: 'blog' },
      ],
    }
    expect(translateFilter(filter)).toEqual({
      should: [
        { key: 'type', match: { value: 'article' } },
        { key: 'type', match: { value: 'blog' } },
      ],
    })
  })

  it('nested and/or', () => {
    const filter: MetadataFilter = {
      and: [
        { field: 'status', op: 'eq', value: 'active' },
        {
          or: [
            { field: 'cat', op: 'eq', value: 'a' },
            { field: 'cat', op: 'eq', value: 'b' },
          ],
        },
      ],
    }

    const result = translateFilter(filter)
    expect(result).toEqual({
      must: [
        { key: 'status', match: { value: 'active' } },
        {
          should: [
            { key: 'cat', match: { value: 'a' } },
            { key: 'cat', match: { value: 'b' } },
          ],
        },
      ],
    })
  })
})
