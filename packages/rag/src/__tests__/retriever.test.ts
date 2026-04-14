import { describe, it, expect, vi } from 'vitest'
import { HybridRetriever, DEFAULT_RETRIEVAL_CONFIG } from '../retriever.js'
import type { VectorSearchHit, KeywordSearchHit } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVectorHit(overrides: Partial<VectorSearchHit> & { id: string }): VectorSearchHit {
  return {
    score: 0.8,
    text: `Text for ${overrides.id}`,
    metadata: {
      source_id: 'src-1',
      chunk_index: 0,
      quality_score: 0.5,
    },
    ...overrides,
  }
}

function makeKeywordHit(overrides: Partial<KeywordSearchHit> & { id: string }): KeywordSearchHit {
  return {
    score: 0.7,
    text: `Text for ${overrides.id}`,
    metadata: {
      source_id: 'src-1',
      chunk_index: 0,
      quality_score: 0.5,
    },
    ...overrides,
  }
}

function makeRetriever(opts: {
  vectorHits?: VectorSearchHit[]
  keywordHits?: KeywordSearchHit[]
  mode?: 'vector' | 'keyword' | 'hybrid'
  topK?: number
  qualityBoosting?: boolean
  tokenBudget?: number
}) {
  return new HybridRetriever({
    mode: opts.mode ?? 'vector',
    topK: opts.topK ?? 10,
    qualityBoosting: opts.qualityBoosting ?? false,
    qualityWeights: { chunk: 0.6, source: 0.4 },
    tokenBudget: opts.tokenBudget ?? 8000,
    embedQuery: async () => [0.1, 0.2, 0.3],
    vectorSearch: async () => opts.vectorHits ?? [],
    keywordSearch: opts.keywordHits !== undefined
      ? async () => opts.keywordHits!
      : undefined,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HybridRetriever', () => {
  describe('default config', () => {
    it('has sensible defaults', () => {
      expect(DEFAULT_RETRIEVAL_CONFIG).toEqual({
        mode: 'hybrid',
        topK: 10,
        qualityBoosting: true,
        qualityWeights: { chunk: 0.6, source: 0.4 },
        tokenBudget: 8000,
        reranker: 'none',
      })
    })
  })

  // -------------------------------------------------------------------------
  // Vector-only mode
  // -------------------------------------------------------------------------

  describe('vector mode', () => {
    it('returns vector search results sorted by score', async () => {
      const retriever = makeRetriever({
        mode: 'vector',
        vectorHits: [
          makeVectorHit({ id: 'c1', score: 0.9 }),
          makeVectorHit({ id: 'c2', score: 0.7 }),
        ],
      })
      const result = await retriever.retrieve('query', {})
      expect(result.searchMode).toBe('vector')
      expect(result.chunks).toHaveLength(2)
      expect(result.chunks[0]!.id).toBe('c1')
      expect(result.chunks[1]!.id).toBe('c2')
    })

    it('populates vectorScore on returned chunks', async () => {
      const retriever = makeRetriever({
        mode: 'vector',
        vectorHits: [makeVectorHit({ id: 'c1', score: 0.85 })],
      })
      const result = await retriever.retrieve('query', {})
      expect(result.chunks[0]!.vectorScore).toBe(0.85)
    })

    it('calls embedQuery with the query text', async () => {
      const embedQuery = vi.fn(async () => [0.1])
      const retriever = new HybridRetriever({
        mode: 'vector',
        topK: 5,
        qualityBoosting: false,
        qualityWeights: { chunk: 0.6, source: 0.4 },
        tokenBudget: 8000,
        embedQuery,
        vectorSearch: async () => [],
      })
      await retriever.retrieve('my search query', {})
      expect(embedQuery).toHaveBeenCalledWith('my search query')
    })
  })

  // -------------------------------------------------------------------------
  // Keyword-only mode
  // -------------------------------------------------------------------------

  describe('keyword mode', () => {
    it('returns keyword search results', async () => {
      const retriever = makeRetriever({
        mode: 'keyword',
        keywordHits: [
          makeKeywordHit({ id: 'k1', score: 0.9 }),
          makeKeywordHit({ id: 'k2', score: 0.6 }),
        ],
      })
      const result = await retriever.retrieve('query', {}, { mode: 'keyword' })
      expect(result.searchMode).toBe('keyword')
      expect(result.chunks).toHaveLength(2)
    })

    it('populates keywordScore on returned chunks', async () => {
      const retriever = makeRetriever({
        mode: 'keyword',
        keywordHits: [makeKeywordHit({ id: 'k1', score: 0.75 })],
      })
      const result = await retriever.retrieve('query', {}, { mode: 'keyword' })
      expect(result.chunks[0]!.keywordScore).toBe(0.75)
    })

    it('returns empty when no keyword search function is provided', async () => {
      const retriever = makeRetriever({ mode: 'keyword' })
      const result = await retriever.retrieve('query', {}, { mode: 'keyword' })
      expect(result.chunks).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Hybrid (RRF) mode
  // -------------------------------------------------------------------------

  describe('hybrid mode (RRF)', () => {
    it('fuses vector and keyword results, boosting shared chunks', async () => {
      const retriever = makeRetriever({
        mode: 'hybrid',
        vectorHits: [
          makeVectorHit({ id: 'shared', score: 0.9 }),
          makeVectorHit({ id: 'vec-only', score: 0.8 }),
        ],
        keywordHits: [
          makeKeywordHit({ id: 'shared', score: 0.95 }),
          makeKeywordHit({ id: 'kw-only', score: 0.7 }),
        ],
      })
      const result = await retriever.retrieve('query', {})
      expect(result.searchMode).toBe('hybrid')
      // 'shared' appears in both, so should have highest RRF score
      expect(result.chunks[0]!.id).toBe('shared')
      // All 3 unique chunks should be present
      expect(result.chunks).toHaveLength(3)
    })

    it('assigns both vectorScore and keywordScore to shared chunks', async () => {
      const retriever = makeRetriever({
        mode: 'hybrid',
        vectorHits: [makeVectorHit({ id: 'shared', score: 0.9 })],
        keywordHits: [makeKeywordHit({ id: 'shared', score: 0.8 })],
      })
      const result = await retriever.retrieve('query', {})
      const shared = result.chunks.find(c => c.id === 'shared')!
      expect(shared.vectorScore).toBe(0.9)
      expect(shared.keywordScore).toBe(0.8)
    })
  })

  // -------------------------------------------------------------------------
  // Token budget
  // -------------------------------------------------------------------------

  describe('token budget enforcement', () => {
    it('trims chunks exceeding the token budget', async () => {
      // Each chunk text is ~14 chars = ~4 tokens. Budget of 5 should allow 1.
      const retriever = makeRetriever({
        mode: 'vector',
        tokenBudget: 5,
        vectorHits: [
          makeVectorHit({ id: 'c1', score: 0.9, text: 'A'.repeat(20) }),
          makeVectorHit({ id: 'c2', score: 0.8, text: 'B'.repeat(20) }),
        ],
      })
      const result = await retriever.retrieve('query', {})
      // First chunk is 20 chars = 5 tokens, fits exactly. Second would exceed.
      expect(result.chunks).toHaveLength(1)
      expect(result.chunks[0]!.id).toBe('c1')
    })

    it('always includes at least the first chunk even if it exceeds budget', async () => {
      const retriever = makeRetriever({
        mode: 'vector',
        tokenBudget: 1,
        vectorHits: [
          makeVectorHit({ id: 'c1', score: 0.9, text: 'A'.repeat(100) }),
        ],
      })
      const result = await retriever.retrieve('query', {})
      expect(result.chunks).toHaveLength(1)
    })

    it('reports correct totalTokens', async () => {
      const retriever = makeRetriever({
        mode: 'vector',
        vectorHits: [
          makeVectorHit({ id: 'c1', score: 0.9, text: 'Hello world' }),
        ],
      })
      const result = await retriever.retrieve('query', {})
      // 'Hello world' = 11 chars => ceil(11/4) = 3
      expect(result.totalTokens).toBe(3)
    })
  })

  // -------------------------------------------------------------------------
  // topK clamping
  // -------------------------------------------------------------------------

  describe('topK clamping', () => {
    it('clamps topK to minimum of 1', async () => {
      const vectorSearch = vi.fn(async () => [])
      const retriever = new HybridRetriever({
        mode: 'vector',
        topK: -5,
        qualityBoosting: false,
        qualityWeights: { chunk: 0.6, source: 0.4 },
        tokenBudget: 8000,
        embedQuery: async () => [0.1],
        vectorSearch,
      })
      await retriever.retrieve('q', {})
      // The limit passed to vectorSearch should be 1 (clamped from -5)
      expect(vectorSearch).toHaveBeenCalledWith(expect.anything(), expect.anything(), 1)
    })

    it('clamps topK to maximum of 100', async () => {
      const vectorSearch = vi.fn(async () => [])
      const retriever = new HybridRetriever({
        mode: 'vector',
        topK: 500,
        qualityBoosting: false,
        qualityWeights: { chunk: 0.6, source: 0.4 },
        tokenBudget: 8000,
        embedQuery: async () => [0.1],
        vectorSearch,
      })
      await retriever.retrieve('q', {})
      expect(vectorSearch).toHaveBeenCalledWith(expect.anything(), expect.anything(), 100)
    })
  })

  // -------------------------------------------------------------------------
  // Metadata parsing
  // -------------------------------------------------------------------------

  describe('metadata parsing', () => {
    it('extracts sourceId, sourceTitle, sourceUrl from vector hit metadata', async () => {
      const retriever = makeRetriever({
        mode: 'vector',
        vectorHits: [{
          id: 'c1',
          score: 0.9,
          text: 'content',
          metadata: {
            source_id: 'my-source',
            source_title: 'My Title',
            source_url: 'https://example.com',
            chunk_index: 3,
          },
        }],
      })
      const result = await retriever.retrieve('q', {})
      const chunk = result.chunks[0]!
      expect(chunk.sourceId).toBe('my-source')
      expect(chunk.sourceTitle).toBe('My Title')
      expect(chunk.sourceUrl).toBe('https://example.com')
      expect(chunk.chunkIndex).toBe(3)
    })

    it('parses source_quality from metadata', async () => {
      const retriever = makeRetriever({
        mode: 'vector',
        qualityBoosting: true,
        vectorHits: [{
          id: 'c1',
          score: 1.0,
          text: 'content',
          metadata: {
            source_id: 's1',
            chunk_index: 0,
            quality_score: 0.5,
            source_quality: 0.9,
          },
        }],
      })
      const result = await retriever.retrieve('q', {})
      // sourceQuality 0.9 should boost the score above baseline
      expect(result.chunks[0]!.score).toBeGreaterThan(1.0)
    })

    it('parses source quality from string metadata', async () => {
      const retriever = makeRetriever({
        mode: 'vector',
        qualityBoosting: true,
        vectorHits: [{
          id: 'c1',
          score: 1.0,
          text: 'content',
          metadata: {
            source_id: 's1',
            chunk_index: 0,
            quality_score: 0.5,
            source_quality: '0.9',
          },
        }],
      })
      const result = await retriever.retrieve('q', {})
      expect(result.chunks[0]!.score).toBeGreaterThan(1.0)
    })
  })

  // -------------------------------------------------------------------------
  // queryTimeMs
  // -------------------------------------------------------------------------

  describe('timing', () => {
    it('returns queryTimeMs as a non-negative number', async () => {
      const retriever = makeRetriever({ mode: 'vector', vectorHits: [] })
      const result = await retriever.retrieve('q', {})
      expect(result.queryTimeMs).toBeGreaterThanOrEqual(0)
    })
  })
})
