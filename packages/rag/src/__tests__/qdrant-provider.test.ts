/**
 * Tests for the Option-A Qdrant provider:
 *   - QdrantVectorStore (single collection + tenantId filter)
 *   - createQdrantRetriever (VectorSearchFn / KeywordSearchFn factory)
 *   - QdrantCorpusStore (CorpusManager-compatible facade)
 *   - Dynamic import failure path
 *
 * The @qdrant/js-client-rest dependency is mocked at module level with
 * vi.mock so these tests run without the optional peer dep installed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CorpusManager } from '../corpus-manager.js'
import {
  QdrantVectorStore,
  QdrantCorpusStore,
  createQdrantRetriever,
  loadQdrantClient,
  __resetQdrantLoaderForTests,
} from '../providers/qdrant.js'
import type { QdrantClientLike } from '../providers/qdrant.js'
import type { EmbeddingProvider } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Module-level mock for @qdrant/js-client-rest
//
// The variable is hoisted via `vi.hoisted` so the factory closure can read
// it after vi.mock is hoisted above the import statements.
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  ctorCalls: [] as Array<{ url: string; apiKey?: string }>,
  ctorImpl: null as
    | (new (config: { url: string; apiKey?: string }) => unknown)
    | null,
  /** When true, the mock module pretends the package isn't installed. */
  failImport: false,
}))

vi.mock('@qdrant/js-client-rest', async () => {
  class QdrantClient {
    constructor(config: { url: string; apiKey?: string }) {
      mockState.ctorCalls.push(config)
      if (mockState.ctorImpl) {
        return new mockState.ctorImpl(config) as unknown as QdrantClient
      }
    }
    upsert = vi.fn().mockResolvedValue({ status: 'ok' })
    search = vi.fn().mockResolvedValue([])
    scroll = vi.fn().mockResolvedValue({ points: [] })
    delete = vi.fn().mockResolvedValue({ status: 'ok' })
  }
  // Use a getter so per-test flips of `mockState.failImport` are honoured
  // even though vi.mock module factories are cached after first import.
  const exported = {} as { QdrantClient?: typeof QdrantClient }
  Object.defineProperty(exported, 'QdrantClient', {
    enumerable: true,
    configurable: true,
    get() {
      return mockState.failImport ? undefined : QdrantClient
    },
  })
  return exported
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(): QdrantClientLike & {
  upsert: ReturnType<typeof vi.fn>
  search: ReturnType<typeof vi.fn>
  scroll: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
} {
  return {
    upsert: vi.fn().mockResolvedValue({ status: 'ok' }),
    search: vi.fn().mockResolvedValue([]),
    scroll: vi.fn().mockResolvedValue({ points: [] }),
    delete: vi.fn().mockResolvedValue({ status: 'ok' }),
  }
}

function makeEmbedding(dims = 4): EmbeddingProvider {
  return {
    modelId: 'mock-embed',
    dimensions: dims,
    embed: async (texts) =>
      texts.map((_, i) => {
        const v = new Array<number>(dims).fill(0)
        v[i % dims] = 1
        return v
      }),
    embedQuery: async () => {
      const v = new Array<number>(dims).fill(0)
      v[0] = 1
      return v
    },
  }
}

// ---------------------------------------------------------------------------
// QdrantVectorStore — direct tests
// ---------------------------------------------------------------------------

describe('QdrantVectorStore.search', () => {
  let client: ReturnType<typeof makeClient>
  let store: QdrantVectorStore

  beforeEach(() => {
    client = makeClient()
    store = new QdrantVectorStore(client, {
      url: 'http://qdrant',
      collectionName: 'rag_main',
    })
  })

  it('always appends the tenantId clause to the must filter', async () => {
    client.search.mockResolvedValueOnce([
      { id: 'p1', score: 0.9, payload: { text: 'hello', tenantId: 't1' } },
    ])

    await store.search([0.1, 0.2, 0.3, 0.4], 5, { tenantId: 't1' })

    expect(client.search).toHaveBeenCalledTimes(1)
    const [collection, body] = client.search.mock.calls[0] as [
      string,
      { filter: { must: Array<{ key: string }> } },
    ]
    expect(collection).toBe('rag_main')
    expect(body.filter.must).toEqual(
      expect.arrayContaining([
        { key: 'tenantId', match: { value: 't1' } },
      ]),
    )
  })

  it('omits tenantId clause when no tenant is provided', async () => {
    client.search.mockResolvedValueOnce([])
    await store.search([0.1, 0.2, 0.3, 0.4], 3)
    const [, body] = client.search.mock.calls[0] as [string, { filter?: unknown }]
    expect(body.filter).toBeUndefined()
  })

  it('falls back to defaultTenantId when filter omits tenantId', async () => {
    const tenantStore = new QdrantVectorStore(client, {
      url: 'http://qdrant',
      collectionName: 'rag_main',
      defaultTenantId: 'fallback-tenant',
    })
    await tenantStore.search([0.1, 0.2, 0.3, 0.4], 2)
    const [, body] = client.search.mock.calls[0] as [
      string,
      { filter: { must: Array<{ key: string; match: { value?: unknown } }> } },
    ]
    expect(body.filter.must).toEqual(
      expect.arrayContaining([
        { key: 'tenantId', match: { value: 'fallback-tenant' } },
      ]),
    )
  })

  it('passes through user filter clauses alongside tenantId', async () => {
    await store.search([0.1, 0.2, 0.3, 0.4], 5, {
      tenantId: 't1',
      sessionId: 'sess-1',
      tags: ['kb', 'faq'],
    })
    const [, body] = client.search.mock.calls[0] as [
      string,
      { filter: { must: Array<{ key: string; match: unknown }> } },
    ]
    const keys = body.filter.must.map((c) => c.key)
    expect(keys).toEqual(expect.arrayContaining(['tenantId', 'sessionId', 'tags']))
  })

  it('coerces hit ids to string and strips text via payload pick', async () => {
    client.search.mockResolvedValueOnce([
      { id: 42, score: 0.5, payload: { text: 'doc', meta: 'm' } },
    ])
    const hits = await store.search([0, 0, 0, 0], 1, { tenantId: 't1' })
    expect(hits[0]?.id).toBe('42')
    expect(hits[0]?.payload).toEqual({ text: 'doc', meta: 'm' })
  })
})

describe('QdrantVectorStore.upsert', () => {
  it('routes a single point through client.upsert with correct payload', async () => {
    const client = makeClient()
    const store = new QdrantVectorStore(client, {
      url: 'http://q',
      collectionName: 'rag_main',
    })

    await store.upsert('chunk-1', [0.1, 0.2, 0.3], {
      tenantId: 't1',
      text: 'hello world',
    })

    expect(client.upsert).toHaveBeenCalledWith('rag_main', {
      points: [
        {
          id: 'chunk-1',
          vector: [0.1, 0.2, 0.3],
          payload: { tenantId: 't1', text: 'hello world' },
        },
      ],
    })
  })

  it('upsertMany no-ops on empty array', async () => {
    const client = makeClient()
    const store = new QdrantVectorStore(client, {
      url: 'http://q',
      collectionName: 'rag_main',
    })
    await store.upsertMany([])
    expect(client.upsert).not.toHaveBeenCalled()
  })
})

describe('QdrantVectorStore.keywordSearch', () => {
  it('uses scroll with tenantId + text-match filter and rank-decayed scores', async () => {
    const client = makeClient()
    client.scroll.mockResolvedValueOnce({
      points: [
        { id: 'a', payload: { text: 'one' } },
        { id: 'b', payload: { text: 'two' } },
      ],
    })

    const store = new QdrantVectorStore(client, {
      url: 'http://q',
      collectionName: 'rag_main',
    })

    const hits = await store.keywordSearch('quick', 2, { tenantId: 't1' })

    expect(client.scroll).toHaveBeenCalledTimes(1)
    const [, body] = client.scroll.mock.calls[0] as [
      string,
      { filter: { must: Array<{ key: string; match: { value?: unknown } }> } },
    ]
    const keys = body.filter.must.map((c) => c.key)
    expect(keys).toEqual(expect.arrayContaining(['tenantId', 'text']))

    expect(hits).toHaveLength(2)
    expect(hits[0]?.score).toBe(1)
    expect(hits[1]?.score).toBe(0.5)
  })
})

describe('QdrantVectorStore.tryCreate', () => {
  beforeEach(() => {
    __resetQdrantLoaderForTests()
    mockState.ctorCalls.length = 0
    mockState.failImport = false
  })

  afterEach(() => {
    __resetQdrantLoaderForTests()
  })

  it('uses an injected client without touching the dynamic import', async () => {
    const client = makeClient()
    const store = await QdrantVectorStore.tryCreate({
      url: 'http://ignored',
      collectionName: 'rag_main',
      client,
    })
    expect(store).not.toBeNull()
    expect(mockState.ctorCalls).toHaveLength(0)
  })

  it('instantiates the SDK client when no test seam is provided', async () => {
    const store = await QdrantVectorStore.tryCreate({
      url: 'http://qdrant:6333',
      apiKey: 'sekret',
      collectionName: 'rag_main',
    })
    expect(store).not.toBeNull()
    expect(mockState.ctorCalls).toEqual([
      { url: 'http://qdrant:6333', apiKey: 'sekret' },
    ])
  })

  it('returns null when the dynamic import fails', async () => {
    __resetQdrantLoaderForTests()
    mockState.failImport = true
    try {
      const store = await QdrantVectorStore.tryCreate({
        url: 'http://qdrant',
        collectionName: 'rag_main',
      })
      expect(store).toBeNull()
    } finally {
      mockState.failImport = false
      __resetQdrantLoaderForTests()
    }
  })

  it('memoises the loader result across calls', async () => {
    await loadQdrantClient()
    const callsAfterFirst = mockState.ctorCalls.length
    await loadQdrantClient()
    // No new client construction — only the loader is memoised.
    expect(mockState.ctorCalls.length).toBe(callsAfterFirst)
  })
})

// ---------------------------------------------------------------------------
// createQdrantRetriever
// ---------------------------------------------------------------------------

describe('createQdrantRetriever', () => {
  beforeEach(() => {
    __resetQdrantLoaderForTests()
    mockState.failImport = false
  })

  it('returns wiring with vectorSearch and keywordSearch of the right shape', async () => {
    const client = makeClient()
    const wiring = await createQdrantRetriever({
      url: 'http://q',
      collectionName: 'rag_main',
      client,
    })
    expect(wiring).not.toBeNull()
    expect(typeof wiring!.vectorSearch).toBe('function')
    expect(typeof wiring!.keywordSearch).toBe('function')
    expect(wiring!.store).toBeInstanceOf(QdrantVectorStore)
  })

  it('vectorSearch returns VectorSearchHit objects with text + metadata + score', async () => {
    const client = makeClient()
    client.search.mockResolvedValueOnce([
      { id: 'p1', score: 0.8, payload: { text: 'doc one', sourceId: 's1' } },
    ])

    const wiring = await createQdrantRetriever({
      url: 'http://q',
      collectionName: 'rag_main',
      client,
    })

    const hits = await wiring!.vectorSearch([0.1, 0.2, 0.3, 0.4], { tenantId: 't1' }, 5)
    expect(hits).toEqual([
      {
        id: 'p1',
        score: 0.8,
        text: 'doc one',
        metadata: { text: 'doc one', sourceId: 's1' },
      },
    ])
  })

  it('vectorSearch honours minScore by filtering low-score hits', async () => {
    const client = makeClient()
    client.search.mockResolvedValueOnce([
      { id: 'a', score: 0.9, payload: { text: 'A' } },
      { id: 'b', score: 0.4, payload: { text: 'B' } },
      { id: 'c', score: 0.7, payload: { text: 'C' } },
    ])
    const wiring = await createQdrantRetriever({
      url: 'http://q',
      collectionName: 'rag_main',
      client,
    })
    const hits = await wiring!.vectorSearch([0, 0, 0, 0], { tenantId: 't1' }, 3, 0.6)
    expect(hits.map((h) => h.id)).toEqual(['a', 'c'])
  })

  it('keywordSearch returns KeywordSearchHit objects with text + metadata', async () => {
    const client = makeClient()
    client.scroll.mockResolvedValueOnce({
      points: [{ id: 'p1', payload: { text: 'matched text', sourceId: 's1' } }],
    })
    const wiring = await createQdrantRetriever({
      url: 'http://q',
      collectionName: 'rag_main',
      client,
    })
    const hits = await wiring!.keywordSearch('matched', { tenantId: 't1' }, 1)
    expect(hits).toEqual([
      {
        id: 'p1',
        score: 1,
        text: 'matched text',
        metadata: { text: 'matched text', sourceId: 's1' },
      },
    ])
  })

  it('returns null when @qdrant/js-client-rest cannot be loaded and no client seam given', async () => {
    __resetQdrantLoaderForTests()
    mockState.failImport = true
    try {
      const wiring = await createQdrantRetriever({
        url: 'http://q',
        collectionName: 'rag_main',
      })
      expect(wiring).toBeNull()
    } finally {
      mockState.failImport = false
      __resetQdrantLoaderForTests()
    }
  })

  it('honours a custom textField when extracting hit text', async () => {
    const client = makeClient()
    client.search.mockResolvedValueOnce([
      { id: 'p1', score: 0.8, payload: { body: 'doc one', sourceId: 's1' } },
    ])
    const wiring = await createQdrantRetriever({
      url: 'http://q',
      collectionName: 'rag_main',
      client,
      textField: 'body',
    })
    const hits = await wiring!.vectorSearch([0, 0, 0, 0], { tenantId: 't1' }, 1)
    expect(hits[0]?.text).toBe('doc one')
  })
})

// ---------------------------------------------------------------------------
// QdrantCorpusStore + CorpusManager wiring
// ---------------------------------------------------------------------------

describe('CorpusManager wired with QdrantCorpusStore', () => {
  it('ingests a source and routes points through the shared Qdrant collection', async () => {
    const client = makeClient()
    const store = new QdrantVectorStore(client, {
      url: 'http://q',
      collectionName: 'rag_shared',
    })
    const corpusStore = new QdrantCorpusStore(store)
    const embedding = makeEmbedding(4)

    const manager = new CorpusManager({ vectorStore: corpusStore, embedding })
    const corpus = await manager.createCorpus('Docs')

    await manager.ingestSource(corpus.id, {
      id: 'src-1',
      text: 'A short document used for verifying corpus ingestion through Qdrant.',
      metadata: { tenantId: 't1' },
    })

    expect(client.upsert).toHaveBeenCalled()
    const upsertCall = client.upsert.mock.calls.at(-1) as [
      string,
      { points: Array<{ payload: Record<string, unknown> }> },
    ]
    expect(upsertCall[0]).toBe('rag_shared')
    const point = upsertCall[1].points[0]!
    // Synthetic _collection field carries the corpus collection name
    expect(point.payload['_collection']).toBe(`corpus_${corpus.id}`)
    // Per-source metadata is preserved
    expect(point.payload['tenantId']).toBe('t1')
  })

  it('search injects both _collection and tenantId clauses', async () => {
    const client = makeClient()
    client.search.mockResolvedValue([
      { id: 'p1', score: 0.9, payload: { text: 'doc', _collection: 'corpus_x', tenantId: 't1' } },
    ])
    const store = new QdrantVectorStore(client, {
      url: 'http://q',
      collectionName: 'rag_shared',
    })
    const corpusStore = new QdrantCorpusStore(store)

    const results = await corpusStore.search('corpus_x', {
      vector: [0.1, 0.2, 0.3, 0.4],
      limit: 5,
      filter: { and: [{ field: 'tenantId', op: 'eq', value: 't1' }] },
    })

    expect(client.search).toHaveBeenCalledTimes(1)
    const [, body] = client.search.mock.calls[0] as [
      string,
      { filter: { must: Array<{ key: string; match: { value?: unknown } }> } },
    ]
    const keys = body.filter.must.map((c) => c.key)
    expect(keys).toEqual(expect.arrayContaining(['_collection', 'tenantId']))

    expect(results[0]?.id).toBe('p1')
    // Synthetic _collection and text are stripped from the returned metadata
    expect(results[0]?.metadata['_collection']).toBeUndefined()
    expect(results[0]?.metadata['text']).toBeUndefined()
    expect(results[0]?.text).toBe('doc')
  })

  it('createCollection / collectionExists / listCollections track logical names', async () => {
    const client = makeClient()
    const store = new QdrantVectorStore(client, {
      url: 'http://q',
      collectionName: 'rag_shared',
    })
    const corpusStore = new QdrantCorpusStore(store)

    await corpusStore.createCollection('corpus_a', { dimensions: 4, metric: 'cosine' })
    await corpusStore.createCollection('corpus_b', { dimensions: 4, metric: 'cosine' })

    expect(await corpusStore.collectionExists('corpus_a')).toBe(true)
    expect(await corpusStore.collectionExists('corpus_missing')).toBe(false)
    expect((await corpusStore.listCollections()).sort()).toEqual(['corpus_a', 'corpus_b'])
  })
})
