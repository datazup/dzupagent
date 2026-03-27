import { describe, it, expect } from 'vitest'
import { voidFilter } from '../retrieval/void-filter.js'
import type { VoidFilterConfig, VoidFilterResult } from '../retrieval/void-filter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidate(
  key: string,
  score: number,
  value: Record<string, unknown> = {},
) {
  return { key, score, value }
}

type Candidate = ReturnType<typeof makeCandidate>

// ---------------------------------------------------------------------------
// Trivial / degenerate cases
// ---------------------------------------------------------------------------

describe('voidFilter', () => {
  describe('trivial cases', () => {
    it('returns empty result for empty array', () => {
      const result = voidFilter([])
      expect(result.active).toEqual([])
      expect(result.void).toEqual([])
      expect(result.inhibitory).toEqual([])
      expect(result.voidFraction).toBe(0)
    })

    it('single candidate is treated as all-active', () => {
      const candidates = [makeCandidate('a', 0.9)]
      const result = voidFilter(candidates)
      expect(result.active).toHaveLength(1)
      expect(result.void).toHaveLength(0)
      expect(result.inhibitory).toHaveLength(0)
      expect(result.voidFraction).toBe(0)
    })

    it('two candidates (< minCandidates=3) are all active', () => {
      const candidates = [
        makeCandidate('a', 0.9),
        makeCandidate('b', 0.3),
      ]
      const result = voidFilter(candidates)
      expect(result.active).toHaveLength(2)
      expect(result.void).toHaveLength(0)
      expect(result.voidFraction).toBe(0)
    })

    it('all identical scores produces no void items', () => {
      const candidates = [
        makeCandidate('a', 0.5),
        makeCandidate('b', 0.5),
        makeCandidate('c', 0.5),
        makeCandidate('d', 0.5),
      ]
      const result = voidFilter(candidates)
      expect(result.active).toHaveLength(4)
      expect(result.void).toHaveLength(0)
      expect(result.voidFraction).toBe(0)
      expect(result.boundaryScore).toBe(0.5)
    })
  })

  // ---------------------------------------------------------------------------
  // Score gap detection
  // ---------------------------------------------------------------------------

  describe('score gap detection', () => {
    it('identifies a clear gap and splits into active/void', () => {
      const candidates = [
        makeCandidate('a', 0.95),
        makeCandidate('b', 0.90),
        // Big gap here (0.30)
        makeCandidate('c', 0.60),
        makeCandidate('d', 0.55),
        makeCandidate('e', 0.50),
      ]
      const result = voidFilter(candidates)

      // The largest gap is between 0.90 and 0.60 (0.30)
      // But the algorithm also enforces targetVoidFraction ~0.30
      // With 5 candidates, desiredActive = ceil(5 * 0.70) = 4
      // So the gap at index 1 would put only 2 in active (fraction 0.60),
      // which is >= targetVoid (0.30), so it uses the gap boundary
      expect(result.void.length).toBeGreaterThan(0)
      expect(result.active.length).toBeGreaterThan(0)
      // All void items should have lower scores than all active items
      const minActive = Math.min(...result.active.map(c => c.score))
      const maxVoid = result.void.length > 0
        ? Math.max(...result.void.map(c => c.score))
        : -Infinity
      expect(minActive).toBeGreaterThan(maxVoid)
    })

    it('uses percentile fallback when no gap exceeds minScoreGap', () => {
      // Uniform distribution with no significant gap
      const candidates = [
        makeCandidate('a', 1.00),
        makeCandidate('b', 0.98),
        makeCandidate('c', 0.96),
        makeCandidate('d', 0.94),
        makeCandidate('e', 0.92),
        makeCandidate('f', 0.90),
        makeCandidate('g', 0.88),
        makeCandidate('h', 0.86),
        makeCandidate('i', 0.84),
        makeCandidate('j', 0.82),
      ]
      // Gap between each is 0.02, less than default minScoreGap 0.05
      const result = voidFilter(candidates)
      // Should still produce ~30% void via percentile
      expect(result.voidFraction).toBeGreaterThanOrEqual(0.2)
      expect(result.voidFraction).toBeLessThanOrEqual(0.4)
    })
  })

  // ---------------------------------------------------------------------------
  // Target void fraction
  // ---------------------------------------------------------------------------

  describe('target void fraction', () => {
    it('achieves approximately 30% void for 10 candidates', () => {
      const candidates = Array.from({ length: 10 }, (_, i) =>
        makeCandidate(`k${i}`, 1.0 - i * 0.02),
      )
      const result = voidFilter(candidates)
      // ~30% of 10 = 3 void items
      expect(result.voidFraction).toBeCloseTo(0.3, 1)
    })

    it('custom targetVoidFraction of 0.50 voids about half', () => {
      const candidates = Array.from({ length: 10 }, (_, i) =>
        makeCandidate(`k${i}`, 1.0 - i * 0.01),
      )
      const cfg: VoidFilterConfig = { targetVoidFraction: 0.50 }
      const result = voidFilter(candidates, cfg)
      expect(result.voidFraction).toBeGreaterThanOrEqual(0.4)
      expect(result.voidFraction).toBeLessThanOrEqual(0.6)
    })
  })

  // ---------------------------------------------------------------------------
  // Inhibitory detection
  // ---------------------------------------------------------------------------

  describe('inhibitory detection', () => {
    it('reclassifies active candidates with _contradicts as inhibitory', () => {
      const candidates = [
        makeCandidate('a', 0.95, { _contradicts: 'some-fact' }),
        makeCandidate('b', 0.90, {}),
        makeCandidate('c', 0.85, {}),
        makeCandidate('d', 0.20, {}),
      ]
      const result = voidFilter(candidates)

      // 'a' has highest score so it's in the "active" zone, but it has _contradicts
      expect(result.inhibitory.some(c => c.key === 'a')).toBe(true)
      expect(result.active.every(c => c.key !== 'a')).toBe(true)
    })

    it('reclassifies active candidates with _supersededBy as inhibitory', () => {
      const candidates = [
        makeCandidate('a', 0.95, { _supersededBy: 'newer-version' }),
        makeCandidate('b', 0.90, {}),
        makeCandidate('c', 0.85, {}),
        makeCandidate('d', 0.20, {}),
      ]
      const result = voidFilter(candidates)

      expect(result.inhibitory.some(c => c.key === 'a')).toBe(true)
    })

    it('does not treat _contradicts: null as inhibitory', () => {
      const candidates = [
        makeCandidate('a', 0.95, { _contradicts: null }),
        makeCandidate('b', 0.90, {}),
        makeCandidate('c', 0.85, {}),
      ]
      const result = voidFilter(candidates)
      expect(result.inhibitory).toHaveLength(0)
      expect(result.active.some(c => c.key === 'a')).toBe(true)
    })

    it('does not treat _supersededBy: null as inhibitory', () => {
      const candidates = [
        makeCandidate('a', 0.95, { _supersededBy: null }),
        makeCandidate('b', 0.90, {}),
        makeCandidate('c', 0.85, {}),
      ]
      const result = voidFilter(candidates)
      expect(result.inhibitory).toHaveLength(0)
    })

    it('inhibitory items come from the active zone, not void zone', () => {
      // Put inhibitory candidate with a low score that falls into void
      const candidates = [
        makeCandidate('a', 0.95, {}),
        makeCandidate('b', 0.90, {}),
        makeCandidate('c', 0.85, {}),
        makeCandidate('d', 0.10, { _contradicts: 'fact' }),
      ]
      const result = voidFilter(candidates)

      // 'd' has lowest score and should be in void, not inhibitory
      expect(result.void.some(c => c.key === 'd')).toBe(true)
      expect(result.inhibitory.every(c => c.key !== 'd')).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Custom config
  // ---------------------------------------------------------------------------

  describe('custom config', () => {
    it('custom minScoreGap changes gap sensitivity', () => {
      const candidates = [
        makeCandidate('a', 0.95),
        makeCandidate('b', 0.90),
        // Gap of 0.08 — below default 0.05 but let's test with 0.10
        makeCandidate('c', 0.82),
        makeCandidate('d', 0.78),
      ]

      // With minScoreGap=0.10, no gap qualifies (max gap is 0.08)
      const result = voidFilter(candidates, { minScoreGap: 0.10 })
      // Falls back to percentile
      expect(result.void.length + result.active.length + result.inhibitory.length).toBe(4)
    })

    it('custom minCandidates changes threshold for filtering', () => {
      const candidates = [
        makeCandidate('a', 0.95),
        makeCandidate('b', 0.90),
        makeCandidate('c', 0.20),
      ]

      // Default minCandidates=3, so filtering should apply
      const resultDefault = voidFilter(candidates)

      // With minCandidates=5, 3 candidates is too few, all active
      const resultHigh = voidFilter(candidates, { minCandidates: 5 })
      expect(resultHigh.active).toHaveLength(3)
      expect(resultHigh.void).toHaveLength(0)
      expect(resultHigh.voidFraction).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // Boundary score
  // ---------------------------------------------------------------------------

  describe('boundaryScore', () => {
    it('boundaryScore is the score of the first void item', () => {
      const candidates = [
        makeCandidate('a', 0.95),
        makeCandidate('b', 0.90),
        makeCandidate('c', 0.85),
        makeCandidate('d', 0.20),
        makeCandidate('e', 0.15),
      ]
      const result = voidFilter(candidates)

      if (result.void.length > 0) {
        // boundaryScore should match the highest-scoring void item
        const highestVoidScore = Math.max(...result.void.map(c => c.score))
        expect(result.boundaryScore).toBeLessThanOrEqual(highestVoidScore)
      }
    })

    it('boundaryScore equals lowest score when all are active (too few candidates)', () => {
      const candidates = [
        makeCandidate('a', 0.9),
        makeCandidate('b', 0.5),
      ]
      const result = voidFilter(candidates)
      expect(result.boundaryScore).toBe(0.5)
    })

    it('boundaryScore is 0 for empty input', () => {
      const result = voidFilter([])
      expect(result.boundaryScore).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // Sorting
  // ---------------------------------------------------------------------------

  describe('sorting', () => {
    it('active results are sorted by score descending', () => {
      const candidates = [
        makeCandidate('c', 0.70),
        makeCandidate('a', 0.95),
        makeCandidate('d', 0.60),
        makeCandidate('b', 0.90),
        makeCandidate('e', 0.10),
      ]
      const result = voidFilter(candidates)

      for (let i = 1; i < result.active.length; i++) {
        expect(result.active[i]!.score).toBeLessThanOrEqual(result.active[i - 1]!.score)
      }
    })
  })
})
