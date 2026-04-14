import { describe, it, expect, vi } from 'vitest'
import { QualityBoostedRetriever } from '../quality-retriever.js'
import type { HybridRetriever } from '../retriever.js'
import type { RetrievalResult, ScoredChunk } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunk(overrides: Partial<ScoredChunk> & { id: string }): ScoredChunk {
  return {
    text: `Text for ${overrides.id}`,
    score: 1.0,
    sourceId: 'src-1',
    chunkIndex: 0,
    qualityScore: 0.5,
    ...overrides,
  }
}

function makeMockRetriever(chunks: ScoredChunk[]): HybridRetriever {
  return {
    retrieve: vi.fn(async (_query: string, _filter: Record<string, unknown>, options?: Record<string, unknown>) => {
      // Verify that quality boosting is disabled
      expect(options?.qualityBoosting).toBe(false)
      return {
        chunks,
        totalTokens: 100,
        searchMode: 'vector' as const,
        queryTimeMs: 5,
      } satisfies RetrievalResult
    }),
  } as unknown as HybridRetriever
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QualityBoostedRetriever', () => {
  it('applies source quality boost from an external quality map', async () => {
    const chunks = [
      makeChunk({ id: 'c1', sourceId: 'high', score: 1.0, qualityScore: 0.5 }),
      makeChunk({ id: 'c2', sourceId: 'low', score: 1.0, qualityScore: 0.5 }),
    ]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base)

    const result = await retriever.retrieve('query', {}, { high: 1.0, low: 0.1 })

    // 'high' source should score higher than 'low'
    const highChunk = result.chunks.find(c => c.sourceId === 'high')!
    const lowChunk = result.chunks.find(c => c.sourceId === 'low')!
    expect(highChunk.score).toBeGreaterThan(lowChunk.score)
  })

  it('uses 0.5 as default source quality when not in map', async () => {
    const chunks = [makeChunk({ id: 'c1', sourceId: 'unknown', score: 1.0, qualityScore: 0.5 })]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base)

    const result = await retriever.retrieve('query', {}, {})

    // boost = 0.6 * 0.5 + 0.4 * 0.5 = 0.5; score = 1.0 * 0.5 = 0.5
    expect(result.chunks[0]!.score).toBeCloseTo(0.5, 5)
  })

  it('applies custom chunkWeight and sourceWeight', async () => {
    const chunks = [makeChunk({ id: 'c1', sourceId: 's1', score: 1.0, qualityScore: 0.8 })]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base, {
      chunkWeight: 0.3,
      sourceWeight: 0.7,
    })

    const result = await retriever.retrieve('query', {}, { s1: 0.9 })

    // boost = 0.3 * 0.8 + 0.7 * 0.9 = 0.24 + 0.63 = 0.87
    expect(result.chunks[0]!.score).toBeCloseTo(0.87, 2)
  })

  it('filters out chunks below minScore', async () => {
    const chunks = [
      makeChunk({ id: 'c1', sourceId: 's1', score: 1.0, qualityScore: 0.5 }),
      makeChunk({ id: 'c2', sourceId: 's2', score: 0.1, qualityScore: 0.1 }),
    ]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base, { minScore: 0.4 })

    const result = await retriever.retrieve('query', {}, { s1: 0.8, s2: 0.1 })

    // c2: score = 0.1 * (0.6*0.1 + 0.4*0.1) = 0.1 * 0.1 = 0.01 — below 0.4
    expect(result.chunks.every(c => c.score >= 0.4)).toBe(true)
    expect(result.chunks.find(c => c.id === 'c2')).toBeUndefined()
  })

  it('sorts results by descending score after boosting', async () => {
    const chunks = [
      makeChunk({ id: 'c1', sourceId: 's1', score: 0.5, qualityScore: 0.5 }),
      makeChunk({ id: 'c2', sourceId: 's2', score: 0.3, qualityScore: 0.5 }),
    ]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base)

    const result = await retriever.retrieve('query', {}, { s1: 0.2, s2: 1.0 })

    // After boosting, s2 might rank higher than s1 due to high source quality
    for (let i = 1; i < result.chunks.length; i++) {
      expect(result.chunks[i - 1]!.score).toBeGreaterThanOrEqual(result.chunks[i]!.score)
    }
  })

  it('disables built-in quality boosting on the base retriever', async () => {
    const chunks: ScoredChunk[] = []
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base)

    await retriever.retrieve('q', {}, {})

    // The mock already asserts qualityBoosting === false
    expect(base.retrieve).toHaveBeenCalledTimes(1)
  })

  it('passes through retrieval options to base retriever', async () => {
    const chunks: ScoredChunk[] = []
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base)

    await retriever.retrieve('q', { tenant: 'a' }, {}, { topK: 5, mode: 'keyword' })

    expect(base.retrieve).toHaveBeenCalledWith(
      'q',
      { tenant: 'a' },
      expect.objectContaining({ topK: 5, mode: 'keyword', qualityBoosting: false }),
    )
  })

  it('preserves non-chunk fields from base retrieval result', async () => {
    const chunks = [makeChunk({ id: 'c1', sourceId: 's1' })]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base)

    const result = await retriever.retrieve('q', {}, {})
    expect(result.searchMode).toBe('vector')
    expect(result.queryTimeMs).toBe(5)
  })
})
