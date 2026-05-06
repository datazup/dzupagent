import { describe, it, expect } from 'vitest'
import { fusionSearch } from '../retrieval/rrf-fusion.js'
import type { FusedResult } from '../retrieval/rrf-fusion.js'

function makeItem(key: string, score: number, value: Record<string, unknown> = {}) {
  return { key, score, value }
}

describe('fusionSearch', () => {
  describe('basic single-source', () => {
    it('returns vector results with correct RRF scores', () => {
      const results = fusionSearch({
        vector: [makeItem('a', 0.9), makeItem('b', 0.7)],
      })
      // rank 0: 1/(60+0) = 1/60, rank 1: 1/(60+1) = 1/61
      expect(results[0]!.key).toBe('a')
      expect(results[0]!.score).toBeCloseTo(1 / 60, 6)
      expect(results[1]!.key).toBe('b')
      expect(results[1]!.score).toBeCloseTo(1 / 61, 6)
    })

    it('assigns correct source tag for single source', () => {
      const results = fusionSearch({ fts: [makeItem('x', 1.0)] })
      expect(results[0]!.sources).toContain('fts')
      expect(results[0]!.sources).toHaveLength(1)
    })

    it('handles undefined sources without crashing', () => {
      const results = fusionSearch({ vector: undefined, fts: undefined, graph: undefined })
      expect(results).toEqual([])
    })
  })

  describe('multi-source fusion', () => {
    it('accumulates scores for keys that appear in multiple sources', () => {
      const results = fusionSearch({
        vector: [makeItem('shared', 1.0), makeItem('vectorOnly', 0.8)],
        fts: [makeItem('shared', 0.9), makeItem('ftsOnly', 0.7)],
      })
      const shared = results.find(r => r.key === 'shared')!
      const vectorOnly = results.find(r => r.key === 'vectorOnly')!
      // shared appears rank 0 in both sources: 1/60 + 1/60 = 2/60
      expect(shared.score).toBeCloseTo(2 / 60, 6)
      // vectorOnly appears only rank 1 in vector: 1/61
      expect(vectorOnly.score).toBeCloseTo(1 / 61, 6)
      // shared must score higher than vectorOnly
      expect(shared.score).toBeGreaterThan(vectorOnly.score)
    })

    it('merges sources array for keys appearing in multiple sources', () => {
      const results = fusionSearch({
        vector: [makeItem('k1', 1.0)],
        fts: [makeItem('k1', 0.5)],
        graph: [makeItem('k1', 0.3)],
      })
      const item = results.find(r => r.key === 'k1')!
      expect(item.sources).toContain('vector')
      expect(item.sources).toContain('fts')
      expect(item.sources).toContain('graph')
    })

    it('sorts results by descending fused score', () => {
      // k1 in all 3 sources at rank 0: 3/60
      // k2 only in vector at rank 1: 1/61
      const results = fusionSearch({
        vector: [makeItem('k1', 0.5), makeItem('k2', 0.4)],
        fts: [makeItem('k1', 0.5)],
        graph: [makeItem('k1', 0.5)],
      })
      expect(results[0]!.key).toBe('k1')
      expect(results[1]!.key).toBe('k2')
    })
  })

  describe('options', () => {
    it('respects custom k constant', () => {
      const results = fusionSearch({ vector: [makeItem('a', 1.0)] }, { k: 10 })
      // rank 0: 1/(10+0) = 0.1
      expect(results[0]!.score).toBeCloseTo(1 / 10, 6)
    })

    it('respects limit option', () => {
      const items = Array.from({ length: 15 }, (_, i) => makeItem(`k${i}`, 1 - i * 0.01))
      const results = fusionSearch({ vector: items }, { limit: 5 })
      expect(results).toHaveLength(5)
    })

    it('returns all results when fewer than limit', () => {
      const results = fusionSearch({ vector: [makeItem('a', 1.0), makeItem('b', 0.5)] }, { limit: 10 })
      expect(results).toHaveLength(2)
    })

    it('defaults to limit=10 when not specified', () => {
      const items = Array.from({ length: 20 }, (_, i) => makeItem(`k${i}`, 1 - i * 0.01))
      const results = fusionSearch({ vector: items })
      expect(results).toHaveLength(10)
    })
  })

  describe('edge cases', () => {
    it('returns empty array for empty input', () => {
      expect(fusionSearch({})).toEqual([])
    })

    it('preserves the value object from the source item', () => {
      const val = { text: 'hello', extra: 42 }
      const results = fusionSearch({ vector: [makeItem('k', 1.0, val)] })
      expect(results[0]!.value).toBe(val)
    })

    it('deduplicates key across all three sources and sums all contributions', () => {
      // Same key at rank 0 in all three: score = 1/60 + 1/60 + 1/60
      const results = fusionSearch({
        vector: [makeItem('dup', 1.0)],
        fts: [makeItem('dup', 0.8)],
        graph: [makeItem('dup', 0.6)],
      })
      expect(results).toHaveLength(1)
      expect(results[0]!.score).toBeCloseTo(3 / 60, 6)
    })

    it('handles single-item input', () => {
      const results = fusionSearch({ graph: [makeItem('solo', 0.5)] })
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('solo')
      expect(results[0]!.sources).toEqual(['graph'])
    })
  })

  describe('return type', () => {
    it('result conforms to FusedResult interface', () => {
      const results: FusedResult[] = fusionSearch({ vector: [makeItem('k', 0.5)] })
      const r = results[0]!
      expect(typeof r.key).toBe('string')
      expect(typeof r.score).toBe('number')
      expect(Array.isArray(r.sources)).toBe(true)
      expect(typeof r.value).toBe('object')
    })
  })
})
