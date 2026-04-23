/**
 * Verifies the documented `@dzupagent/rag` public API surface:
 *
 *   - `QdrantVectorStore` — enforces `tenantId` payload filter on every
 *     search/keywordSearch call (Option A: single shared collection).
 *   - `RagRetriever` — alias for `HybridRetriever`; end-to-end retrieve()
 *     against mocked vector/keyword search fns returns ranked chunks.
 *   - `RagContextAssembler` — alias for `ContextAssembler`; assembles
 *     retrieved chunks into a formatted context string for LLM prompts.
 *   - `ChunkingPipeline` — alias for `SmartChunker`; splits documents
 *     into chunks with metadata (source, chunk_index).
 *
 * All Qdrant interactions are done through a plain-object mock that
 * satisfies `QdrantClientLike`, so these tests never touch a real server.
 */

import { describe, it, expect } from 'vitest'

import {
  QdrantVectorStore,
  RagRetriever,
  RagContextAssembler,
  ChunkingPipeline,
  HybridRetriever,
  ContextAssembler,
  SmartChunker,
  type QdrantClientLike,
  type QdrantFilter,
  type VectorSearchFn,
  type KeywordSearchFn,
  type RetrievalResult,
  type SourceMeta,
} from '../index.js'

// ---------------------------------------------------------------------------
// Mock Qdrant HTTP client (structural match against QdrantClientLike)
// ---------------------------------------------------------------------------

interface CapturedSearch {
  collectionName: string
  filter: QdrantFilter | undefined
  limit: number
  vector: number[]
}
interface CapturedScroll {
  collectionName: string
  filter: QdrantFilter | undefined
  limit: number
}

function makeMockClient(): {
  client: QdrantClientLike
  searches: CapturedSearch[]
  scrolls: CapturedScroll[]
} {
  const searches: CapturedSearch[] = []
  const scrolls: CapturedScroll[] = []

  const client: QdrantClientLike = {
    upsert: async () => ({ status: 'ok' }),
    search: async (collectionName, body) => {
      searches.push({
        collectionName,
        filter: body.filter,
        limit: body.limit,
        vector: body.vector,
      })
      return [
        { id: 'p-1', score: 0.91, payload: { text: 'alpha content', tenantId: 't-1' } },
        { id: 'p-2', score: 0.74, payload: { text: 'beta content', tenantId: 't-1' } },
      ]
    },
    scroll: async (collectionName, body) => {
      scrolls.push({
        collectionName,
        filter: body.filter,
        limit: body.limit,
      })
      return {
        points: [
          { id: 'p-1', payload: { text: 'alpha content', tenantId: 't-1' } },
        ],
      }
    },
  }

  return { client, searches, scrolls }
}

// ---------------------------------------------------------------------------
// QdrantVectorStore — enforces tenant filter
// ---------------------------------------------------------------------------

describe('QdrantVectorStore (Option A, single shared collection)', () => {
  it('injects a tenantId clause into search filter when supplied explicitly', async () => {
    const { client, searches } = makeMockClient()
    const store = new QdrantVectorStore(client, {
      url: 'http://localhost:6333',
      collectionName: 'rag',
    })

    const hits = await store.search([0.1, 0.2, 0.3], 5, { tenantId: 'tenant-42' })

    expect(hits).toHaveLength(2)
    expect(hits[0]!.id).toBe('p-1')
    expect(searches).toHaveLength(1)
    const captured = searches[0]!
    expect(captured.collectionName).toBe('rag')
    expect(captured.limit).toBe(5)
    expect(captured.filter?.must).toContainEqual({
      key: 'tenantId',
      match: { value: 'tenant-42' },
    })
  })

  it('uses defaultTenantId when the per-query filter omits tenantId', async () => {
    const { client, searches } = makeMockClient()
    const store = new QdrantVectorStore(client, {
      url: 'http://localhost:6333',
      collectionName: 'rag',
      defaultTenantId: 'fallback-tenant',
    })

    await store.search([0.1, 0.2], 3)

    const captured = searches[0]!
    expect(captured.filter?.must).toContainEqual({
      key: 'tenantId',
      match: { value: 'fallback-tenant' },
    })
  })

  it('also enforces tenantId filter on keywordSearch (scroll endpoint)', async () => {
    const { client, scrolls } = makeMockClient()
    const store = new QdrantVectorStore(client, {
      url: 'http://localhost:6333',
      collectionName: 'rag',
    })

    const hits = await store.keywordSearch('alpha', 2, { tenantId: 't-1' })

    expect(hits).toHaveLength(1)
    expect(hits[0]!.score).toBeGreaterThan(0)
    const captured = scrolls[0]!
    expect(captured.filter?.must).toContainEqual({
      key: 'tenantId',
      match: { value: 't-1' },
    })
  })

  it('forwards upsert payloads untouched to the underlying client', async () => {
    const calls: Array<{ collectionName: string; points: unknown[] }> = []
    const client: QdrantClientLike = {
      upsert: async (collectionName, body) => {
        calls.push({ collectionName, points: body.points })
        return { status: 'ok' }
      },
      search: async () => [],
      scroll: async () => ({ points: [] }),
    }
    const store = new QdrantVectorStore(client, {
      url: 'http://localhost:6333',
      collectionName: 'rag',
    })

    await store.upsert('chunk-1', [0.1, 0.2], { text: 'hi', tenantId: 't-1' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.collectionName).toBe('rag')
    expect(calls[0]!.points).toEqual([
      { id: 'chunk-1', vector: [0.1, 0.2], payload: { text: 'hi', tenantId: 't-1' } },
    ])
  })
})

// ---------------------------------------------------------------------------
// RagRetriever (alias for HybridRetriever)
// ---------------------------------------------------------------------------

describe('RagRetriever', () => {
  it('is the same class as HybridRetriever', () => {
    expect(RagRetriever).toBe(HybridRetriever)
  })

  it('retrieves ranked chunks from injected vector and keyword search fns', async () => {
    const vectorSearch: VectorSearchFn = async (_vec, filter, limit) => {
      expect(filter).toMatchObject({ tenantId: 't-1' })
      expect(limit).toBeGreaterThan(0)
      return [
        {
          id: 'c-1',
          score: 0.9,
          text: 'vector result one',
          metadata: { sourceId: 's-1', chunkIndex: 0, quality: 0.8 },
        },
        {
          id: 'c-2',
          score: 0.6,
          text: 'vector result two',
          metadata: { sourceId: 's-1', chunkIndex: 1, quality: 0.7 },
        },
      ]
    }
    const keywordSearch: KeywordSearchFn = async () => [
      {
        id: 'c-1',
        score: 1,
        text: 'vector result one',
        metadata: { sourceId: 's-1', chunkIndex: 0, quality: 0.8 },
      },
    ]

    const retriever = new RagRetriever({
      mode: 'hybrid',
      topK: 5,
      tokenBudget: 4000,
      qualityBoosting: false,
      qualityWeights: { chunk: 0.6, source: 0.4 },
      embedQuery: async () => [0.1, 0.2, 0.3],
      vectorSearch,
      keywordSearch,
    })

    const result = await retriever.retrieve('test query', { tenantId: 't-1' })

    expect(result.chunks.length).toBeGreaterThan(0)
    expect(result.chunks[0]!.id).toBe('c-1')
    expect(result.searchMode).toBe('hybrid')
    expect(result.totalTokens).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// RagContextAssembler (alias for ContextAssembler)
// ---------------------------------------------------------------------------

describe('RagContextAssembler', () => {
  it('is the same class as ContextAssembler', () => {
    expect(RagContextAssembler).toBe(ContextAssembler)
  })

  it('assembles retrieved chunks into a formatted context string', () => {
    const assembler = new RagContextAssembler()
    const retrievalResult: RetrievalResult = {
      searchMode: 'hybrid',
      queryTimeMs: 12,
      totalTokens: 40,
      chunks: [
        {
          id: 'c-1',
          text: 'The quick brown fox jumps over the lazy dog.',
          score: 0.9,
          sourceId: 's-1',
          sourceTitle: 'Fox Doc',
          chunkIndex: 0,
        },
      ],
    }
    const sources = new Map<string, SourceMeta>([
      ['s-1', { sourceId: 's-1', title: 'Fox Doc', contextMode: 'full' }],
    ])

    const ctx = assembler.assembleContext(retrievalResult, sources, {
      tokenBudget: 1000,
    })

    expect(ctx.contextText).toContain('quick brown fox')
    expect(ctx.citations).toHaveLength(1)
    expect(ctx.citations[0]!.sourceId).toBe('s-1')
    expect(ctx.sourceBreakdown[0]!.chunkCount).toBe(1)
    expect(ctx.totalTokens).toBeGreaterThan(0)
    expect(typeof ctx.systemPrompt).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// ChunkingPipeline (alias for SmartChunker)
// ---------------------------------------------------------------------------

describe('ChunkingPipeline', () => {
  it('is the same class as SmartChunker', () => {
    expect(ChunkingPipeline).toBe(SmartChunker)
  })

  it('splits documents into chunks with source and chunk_index metadata', () => {
    const chunker = new ChunkingPipeline({
      targetTokens: 80,
      overlapFraction: 0.1,
      respectBoundaries: true,
    })

    const text = [
      '# Heading A',
      'Paragraph one covers alpha material.',
      'Paragraph two extends the alpha discussion with more detail.',
      '',
      '# Heading B',
      'A different paragraph with beta content and more details here.',
      'More beta material follows to force additional chunking boundaries.',
    ].join('\n\n').repeat(4)

    const chunks = chunker.chunkText(text, 'doc-alpha')

    expect(chunks.length).toBeGreaterThan(1)
    chunks.forEach((c, i) => {
      expect(c.metadata.sourceId).toBe('doc-alpha')
      expect(c.metadata.chunkIndex).toBe(i)
      expect(c.text.length).toBeGreaterThan(0)
      expect(c.tokenCount).toBeGreaterThan(0)
      expect(c.quality).toBeGreaterThanOrEqual(0)
      expect(c.quality).toBeLessThanOrEqual(1)
    })
  })

  it('returns an empty array for empty input', () => {
    const chunker = new ChunkingPipeline()
    expect(chunker.chunkText('', 'doc')).toEqual([])
    expect(chunker.chunkText('   \n  ', 'doc')).toEqual([])
  })
})
