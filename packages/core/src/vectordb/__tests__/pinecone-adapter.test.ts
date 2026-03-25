import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PineconeAdapter, translateFilter } from '../adapters/pinecone-adapter.js'
import type { MetadataFilter } from '../types.js'

describe('PineconeAdapter', () => {
  let fetchFn: ReturnType<typeof vi.fn>
  let adapter: PineconeAdapter

  beforeEach(() => {
    fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    })
    adapter = new PineconeAdapter({
      apiKey: 'pc-test-key',
      indexHost: 'https://my-index-host.pinecone.io',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
  })

  // --- createCollection ---

  it('createCollection sends POST /indexes', async () => {
    await adapter.createCollection('my-index', {
      dimensions: 1536,
      metric: 'cosine',
    })

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.pinecone.io/indexes',
      expect.objectContaining({ method: 'POST' }),
    )

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body['name']).toBe('my-index')
    expect(body['dimension']).toBe(1536)
    expect(body['metric']).toBe('cosine')
    expect(body['spec']).toEqual({
      serverless: { cloud: 'aws', region: 'us-east-1' },
    })
  })

  it('createCollection maps dot_product to dotproduct', async () => {
    await adapter.createCollection('idx', {
      dimensions: 768,
      metric: 'dot_product',
    })

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body['metric']).toBe('dotproduct')
  })

  it('createCollection maps euclidean metric', async () => {
    await adapter.createCollection('idx', {
      dimensions: 384,
      metric: 'euclidean',
    })

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body['metric']).toBe('euclidean')
  })

  // --- upsert ---

  it('upsert sends to index host /vectors/upsert', async () => {
    await adapter.upsert('my-index', [
      { id: 'v1', vector: [0.1, 0.2], metadata: { cat: 'auth' }, text: 'hello' },
      { id: 'v2', vector: [0.3, 0.4], metadata: { cat: 'db' } },
    ])

    expect(fetchFn).toHaveBeenCalledWith(
      'https://my-index-host.pinecone.io/vectors/upsert',
      expect.objectContaining({ method: 'POST' }),
    )

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as {
      vectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }>
    }
    expect(body.vectors).toHaveLength(2)
    expect(body.vectors[0]).toEqual({
      id: 'v1',
      values: [0.1, 0.2],
      metadata: { cat: 'auth', text: 'hello' },
    })
    expect(body.vectors[1]).toEqual({
      id: 'v2',
      values: [0.3, 0.4],
      metadata: { cat: 'db' },
    })
  })

  // --- search ---

  it('search sends /query with topK and filter', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          matches: [
            { id: 'v1', score: 0.95, metadata: { cat: 'auth', text: 'hello world' } },
          ],
        }),
    })

    const results = await adapter.search('my-index', {
      vector: [0.1, 0.2],
      limit: 5,
      filter: { field: 'cat', op: 'eq', value: 'auth' },
    })

    expect(fetchFn).toHaveBeenCalledWith(
      'https://my-index-host.pinecone.io/query',
      expect.objectContaining({ method: 'POST' }),
    )

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body['topK']).toBe(5)
    expect(body['filter']).toEqual({ cat: { $eq: 'auth' } })
    expect(body['includeMetadata']).toBe(true)

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      id: 'v1',
      score: 0.95,
      metadata: { cat: 'auth' },
      text: 'hello world',
    })
  })

  it('search filters by minScore client-side', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          matches: [
            { id: 'v1', score: 0.95, metadata: {} },
            { id: 'v2', score: 0.3, metadata: {} },
          ],
        }),
    })

    const results = await adapter.search('my-index', {
      vector: [0.1],
      limit: 10,
      minScore: 0.5,
    })

    expect(results).toHaveLength(1)
    expect(results[0]?.id).toBe('v1')
  })

  it('search includes vectors when requested', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          matches: [
            { id: 'v1', score: 0.9, metadata: {}, values: [0.1, 0.2] },
          ],
        }),
    })

    const results = await adapter.search('my-index', {
      vector: [0.1, 0.2],
      limit: 5,
      includeVectors: true,
    })

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body['includeValues']).toBe(true)
    expect(results[0]?.vector).toEqual([0.1, 0.2])
  })

  // --- delete ---

  it('delete by ids sends ids array', async () => {
    await adapter.delete('my-index', { ids: ['v1', 'v2'] })

    expect(fetchFn).toHaveBeenCalledWith(
      'https://my-index-host.pinecone.io/vectors/delete',
      expect.objectContaining({ method: 'POST' }),
    )

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body).toEqual({ ids: ['v1', 'v2'] })
  })

  it('delete by filter translates filter', async () => {
    await adapter.delete('my-index', {
      filter: { field: 'expired', op: 'eq', value: true },
    })

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body).toEqual({ filter: { expired: { $eq: true } } })
  })

  // --- count ---

  it('count via describe_index_stats', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ totalRecordCount: 1234 }),
    })

    const count = await adapter.count('my-index')

    expect(fetchFn).toHaveBeenCalledWith(
      'https://my-index-host.pinecone.io/describe_index_stats',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(count).toBe(1234)
  })

  it('count defaults to 0 if totalRecordCount missing', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    })

    expect(await adapter.count('my-index')).toBe(0)
  })

  // --- collectionExists ---

  it('collectionExists returns true for 200', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ name: 'my-index' }),
    })

    expect(await adapter.collectionExists('my-index')).toBe(true)
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

  it('listCollections returns index names', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          indexes: [{ name: 'idx-a' }, { name: 'idx-b' }],
        }),
    })

    const names = await adapter.listCollections()
    expect(names).toEqual(['idx-a', 'idx-b'])
  })

  it('listCollections returns empty array if no indexes', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    })

    expect(await adapter.listCollections()).toEqual([])
  })

  // --- deleteCollection ---

  it('deleteCollection sends DELETE /indexes/{name}', async () => {
    await adapter.deleteCollection('my-index')

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.pinecone.io/indexes/my-index',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  // --- healthCheck ---

  it('healthCheck returns healthy on success', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ indexes: [] }),
    })

    const health = await adapter.healthCheck()
    expect(health.healthy).toBe(true)
    expect(health.provider).toBe('pinecone')
    expect(health.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('healthCheck returns unhealthy on error', async () => {
    fetchFn.mockRejectedValueOnce(new Error('network error'))

    const health = await adapter.healthCheck()
    expect(health.healthy).toBe(false)
    expect(health.provider).toBe('pinecone')
  })

  // --- Api-Key header ---

  it('sends Api-Key header', async () => {
    fetchFn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ indexes: [] }),
    })

    await adapter.listCollections()

    const headers = fetchFn.mock.calls[0][1].headers as Record<string, string>
    expect(headers['Api-Key']).toBe('pc-test-key')
  })

  // --- close ---

  it('close resolves without error', async () => {
    await expect(adapter.close()).resolves.toBeUndefined()
  })
})

describe('translateFilter (Pinecone)', () => {
  it('eq -> { $eq }', () => {
    const filter: MetadataFilter = { field: 'category', op: 'eq', value: 'auth' }
    expect(translateFilter(filter)).toEqual({ category: { $eq: 'auth' } })
  })

  it('neq -> { $ne }', () => {
    const filter: MetadataFilter = { field: 'status', op: 'neq', value: 'deleted' }
    expect(translateFilter(filter)).toEqual({ status: { $ne: 'deleted' } })
  })

  it('gte -> { $gte }', () => {
    const filter: MetadataFilter = { field: 'score', op: 'gte', value: 0.8 }
    expect(translateFilter(filter)).toEqual({ score: { $gte: 0.8 } })
  })

  it('gt -> { $gt }', () => {
    const filter: MetadataFilter = { field: 'score', op: 'gt', value: 0.5 }
    expect(translateFilter(filter)).toEqual({ score: { $gt: 0.5 } })
  })

  it('lt -> { $lt }', () => {
    const filter: MetadataFilter = { field: 'score', op: 'lt', value: 1.0 }
    expect(translateFilter(filter)).toEqual({ score: { $lt: 1.0 } })
  })

  it('lte -> { $lte }', () => {
    const filter: MetadataFilter = { field: 'score', op: 'lte', value: 1.0 }
    expect(translateFilter(filter)).toEqual({ score: { $lte: 1.0 } })
  })

  it('in -> { $in }', () => {
    const filter: MetadataFilter = { field: 'tags', op: 'in', value: ['a', 'b'] }
    expect(translateFilter(filter)).toEqual({ tags: { $in: ['a', 'b'] } })
  })

  it('not_in -> { $nin }', () => {
    const filter: MetadataFilter = { field: 'tags', op: 'not_in', value: [1, 2] }
    expect(translateFilter(filter)).toEqual({ tags: { $nin: [1, 2] } })
  })

  it('and -> { $and }', () => {
    const filter: MetadataFilter = {
      and: [
        { field: 'category', op: 'eq', value: 'auth' },
        { field: 'score', op: 'gte', value: 0.8 },
      ],
    }
    expect(translateFilter(filter)).toEqual({
      $and: [
        { category: { $eq: 'auth' } },
        { score: { $gte: 0.8 } },
      ],
    })
  })

  it('or -> { $or }', () => {
    const filter: MetadataFilter = {
      or: [
        { field: 'type', op: 'eq', value: 'article' },
        { field: 'type', op: 'eq', value: 'blog' },
      ],
    }
    expect(translateFilter(filter)).toEqual({
      $or: [
        { type: { $eq: 'article' } },
        { type: { $eq: 'blog' } },
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

    expect(translateFilter(filter)).toEqual({
      $and: [
        { status: { $eq: 'active' } },
        {
          $or: [
            { cat: { $eq: 'a' } },
            { cat: { $eq: 'b' } },
          ],
        },
      ],
    })
  })
})
