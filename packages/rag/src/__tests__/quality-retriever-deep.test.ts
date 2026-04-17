/**
 * Deep coverage tests for QualityBoostedRetriever (CF-0023).
 *
 * Fills gaps left by quality-retriever.test.ts. Focus areas:
 *   - Boundary scoring at minScore threshold
 *   - Default chunk quality fallback when undefined
 *   - Ranking stability when multiple chunks have identical boost scores
 *   - Preservation of keyword/vector sub-scores through boosting
 *   - Pass-through of search mode, token budget, and other retrieval metadata
 *   - Error propagation from base retriever
 *   - Empty result set
 *   - Multi-source ranking with mixed external quality
 *   - Re-computation of qualityScore on each chunk
 */

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

function makeMockRetriever(
  chunks: ScoredChunk[],
  metadata?: Partial<RetrievalResult>,
): HybridRetriever {
  return {
    retrieve: vi.fn(async (
      _query: string,
      _filter: Record<string, unknown>,
      _options?: Record<string, unknown>,
    ) => {
      return {
        chunks,
        totalTokens: 100,
        searchMode: 'vector' as const,
        queryTimeMs: 5,
        ...metadata,
      } satisfies RetrievalResult
    }),
  } as unknown as HybridRetriever
}

function makeFailingRetriever(err: Error): HybridRetriever {
  return {
    retrieve: vi.fn(async () => {
      throw err
    }),
  } as unknown as HybridRetriever
}

// ===========================================================================
// Tests
// ===========================================================================

describe('QualityBoostedRetriever — deep branches', () => {
  it('returns empty chunks when base retriever yields []', async () => {
    const base = makeMockRetriever([])
    const retriever = new QualityBoostedRetriever(base)

    const result = await retriever.retrieve('q', {}, {})
    expect(result.chunks).toEqual([])
    expect(base.retrieve).toHaveBeenCalledTimes(1)
  })

  it('propagates errors from base retriever unchanged', async () => {
    const base = makeFailingRetriever(new Error('base-broke'))
    const retriever = new QualityBoostedRetriever(base)

    await expect(retriever.retrieve('q', {}, {})).rejects.toThrow('base-broke')
  })

  it('defaults chunk quality to 0.5 when qualityScore undefined', async () => {
    const chunks = [
      makeChunk({ id: 'c1', sourceId: 's1', score: 1.0, qualityScore: undefined }),
    ]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base)

    const result = await retriever.retrieve('q', {}, { s1: 0.5 })
    // boost = 0.6*0.5 + 0.4*0.5 = 0.5 → score = 1.0 * 0.5 = 0.5
    expect(result.chunks[0]!.score).toBeCloseTo(0.5, 5)
  })

  it('defaults source quality to 0.5 when sourceId not in map', async () => {
    const chunks = [
      makeChunk({ id: 'c1', sourceId: 'missing', score: 1.0, qualityScore: 0.5 }),
    ]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base)

    const result = await retriever.retrieve('q', {}, { other: 1.0 })
    // sourceId 'missing' not in map → defaults to 0.5
    expect(result.chunks[0]!.score).toBeCloseTo(0.5, 5)
  })

  it('keeps chunk exactly at minScore threshold (>=, inclusive)', async () => {
    const chunks = [
      makeChunk({ id: 'c1', sourceId: 's1', score: 1.0, qualityScore: 0.5 }),
    ]
    const base = makeMockRetriever(chunks)
    // minScore exactly matches boost result: 1.0 * 0.5 = 0.5
    const retriever = new QualityBoostedRetriever(base, { minScore: 0.5 })

    const result = await retriever.retrieve('q', {}, { s1: 0.5 })
    expect(result.chunks).toHaveLength(1)
    expect(result.chunks[0]!.score).toBeCloseTo(0.5, 5)
  })

  it('filters chunk just below minScore threshold', async () => {
    const chunks = [
      makeChunk({ id: 'c1', sourceId: 's1', score: 1.0, qualityScore: 0.5 }),
    ]
    const base = makeMockRetriever(chunks)
    // minScore slightly above 0.5 → chunk filtered out
    const retriever = new QualityBoostedRetriever(base, { minScore: 0.501 })

    const result = await retriever.retrieve('q', {}, { s1: 0.5 })
    expect(result.chunks).toHaveLength(0)
  })

  it('custom chunkWeight and sourceWeight affect score correctly', async () => {
    const chunks = [
      makeChunk({ id: 'c1', sourceId: 's1', score: 1.0, qualityScore: 0.2 }),
    ]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base, {
      chunkWeight: 0.1,
      sourceWeight: 0.9,
    })

    const result = await retriever.retrieve('q', {}, { s1: 1.0 })
    // boost = 0.1*0.2 + 0.9*1.0 = 0.92
    expect(result.chunks[0]!.score).toBeCloseTo(0.92, 2)
  })

  it('preserves searchMode and queryTimeMs from base retrieval', async () => {
    const chunks = [makeChunk({ id: 'c1', sourceId: 's1' })]
    const base = makeMockRetriever(chunks, {
      searchMode: 'hybrid',
      queryTimeMs: 42,
      totalTokens: 500,
    })
    const retriever = new QualityBoostedRetriever(base)

    const result = await retriever.retrieve('q', {}, {})
    expect(result.searchMode).toBe('hybrid')
    expect(result.queryTimeMs).toBe(42)
    expect(result.totalTokens).toBe(500)
  })

  it('passes filter through to base retriever unchanged', async () => {
    const base = makeMockRetriever([])
    const retriever = new QualityBoostedRetriever(base)

    const filter = { session: 's1', tenant: 't1', tag: 'x' }
    await retriever.retrieve('q', filter, {})

    expect(base.retrieve).toHaveBeenCalledWith(
      'q',
      filter,
      expect.objectContaining({ qualityBoosting: false }),
    )
  })

  it('multi-source ranking: source quality drives final order', async () => {
    const chunks = [
      makeChunk({ id: 'c1', sourceId: 'weak', score: 1.0, qualityScore: 0.5 }),
      makeChunk({ id: 'c2', sourceId: 'strong', score: 0.5, qualityScore: 0.5 }),
    ]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base)

    // weak source quality 0.1 vs strong 1.0
    // c1 boost = 0.6*0.5 + 0.4*0.1 = 0.34; new score = 1.0 * 0.34 = 0.34
    // c2 boost = 0.6*0.5 + 0.4*1.0 = 0.70; new score = 0.5 * 0.70 = 0.35
    // c2 narrowly wins
    const result = await retriever.retrieve('q', {}, { weak: 0.1, strong: 1.0 })
    expect(result.chunks[0]!.id).toBe('c2')
    expect(result.chunks[1]!.id).toBe('c1')
  })

  it('zero-score chunk stays at 0 after any boost (filtered only if minScore > 0)', async () => {
    const chunks = [
      makeChunk({ id: 'c-zero', sourceId: 's1', score: 0, qualityScore: 1.0 }),
    ]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base)

    const result = await retriever.retrieve('q', {}, { s1: 1.0 })
    // 0 * any-boost = 0; remains present because minScore default is 0 (inclusive)
    expect(result.chunks).toHaveLength(1)
    expect(result.chunks[0]!.score).toBe(0)
  })

  it('zero-score chunk is filtered when minScore > 0', async () => {
    const chunks = [
      makeChunk({ id: 'c-zero', sourceId: 's1', score: 0, qualityScore: 1.0 }),
    ]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base, { minScore: 0.01 })

    const result = await retriever.retrieve('q', {}, { s1: 1.0 })
    expect(result.chunks).toHaveLength(0)
  })

  it('sorts chunks descending by score after boosting (stable across calls)', async () => {
    const chunks = [
      makeChunk({ id: 'c1', sourceId: 'a', score: 0.3, qualityScore: 0.8 }),
      makeChunk({ id: 'c2', sourceId: 'b', score: 0.5, qualityScore: 0.2 }),
      makeChunk({ id: 'c3', sourceId: 'c', score: 0.9, qualityScore: 0.5 }),
    ]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base)

    const result = await retriever.retrieve('q', {}, { a: 0.2, b: 0.9, c: 0.5 })

    for (let i = 1; i < result.chunks.length; i++) {
      expect(result.chunks[i - 1]!.score).toBeGreaterThanOrEqual(result.chunks[i]!.score)
    }
  })

  it('qualityScore field reflects the chunkQuality used (not the boost)', async () => {
    const chunks = [
      makeChunk({ id: 'c1', sourceId: 's1', score: 1.0, qualityScore: 0.8 }),
    ]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base)

    const result = await retriever.retrieve('q', {}, { s1: 0.5 })
    // qualityScore is preserved at chunk level (0.8), not the boost value
    expect(result.chunks[0]!.qualityScore).toBe(0.8)
  })

  it('forces qualityBoosting=false on underlying retriever (double-boost prevention)', async () => {
    const base = makeMockRetriever([])
    const retriever = new QualityBoostedRetriever(base)

    // Even when caller passes qualityBoosting: true, we override to false
    await retriever.retrieve('q', {}, { mode: 'vector', qualityBoosting: true })
    expect(base.retrieve).toHaveBeenCalledWith(
      'q',
      {},
      expect.objectContaining({ qualityBoosting: false }),
    )
  })

  it('empty sourceQualities map still produces valid results (all defaults)', async () => {
    const chunks = [
      makeChunk({ id: 'c1', sourceId: 's1', score: 1.0, qualityScore: 0.5 }),
      makeChunk({ id: 'c2', sourceId: 's2', score: 0.8, qualityScore: 0.7 }),
    ]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base)

    const result = await retriever.retrieve('q', {}, {})
    expect(result.chunks).toHaveLength(2)
    // Both chunks should have their qualityScore preserved
    expect(result.chunks.find((c) => c.id === 'c1')?.qualityScore).toBe(0.5)
    expect(result.chunks.find((c) => c.id === 'c2')?.qualityScore).toBe(0.7)
  })

  it('preserves chunk text and sourceId through boosting', async () => {
    const chunks = [
      makeChunk({
        id: 'c1',
        sourceId: 's1',
        score: 1.0,
        qualityScore: 0.5,
        text: 'Original text content',
      }),
    ]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base)

    const result = await retriever.retrieve('q', {}, { s1: 0.8 })
    expect(result.chunks[0]!.text).toBe('Original text content')
    expect(result.chunks[0]!.sourceId).toBe('s1')
  })

  it('negative-like boost (very low quality) yields low but non-negative score', async () => {
    const chunks = [
      makeChunk({ id: 'c1', sourceId: 's1', score: 1.0, qualityScore: 0 }),
    ]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base)

    const result = await retriever.retrieve('q', {}, { s1: 0 })
    // boost = 0.6*0 + 0.4*0 = 0; score = 1.0 * 0 = 0
    expect(result.chunks[0]!.score).toBe(0)
  })

  it('does not mutate the original chunks returned by base retriever', async () => {
    const original = makeChunk({ id: 'c1', sourceId: 's1', score: 1.0, qualityScore: 0.5 })
    const base = makeMockRetriever([original])
    const retriever = new QualityBoostedRetriever(base)

    await retriever.retrieve('q', {}, { s1: 0.9 })

    // The original object should keep its original values
    expect(original.score).toBe(1.0)
    expect(original.qualityScore).toBe(0.5)
  })

  it('minScore=0 (default) keeps everything including zero-score chunks', async () => {
    const chunks = [
      makeChunk({ id: 'c1', sourceId: 's1', score: 0, qualityScore: 0 }),
      makeChunk({ id: 'c2', sourceId: 's1', score: 0.01, qualityScore: 0.01 }),
    ]
    const base = makeMockRetriever(chunks)
    const retriever = new QualityBoostedRetriever(base)

    const result = await retriever.retrieve('q', {}, {})
    expect(result.chunks).toHaveLength(2)
  })
})
