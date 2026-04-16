import { describe, it, expect } from 'vitest'
import {
  EvidenceQualityScorer,
  computeEvidenceQuality,
} from '../scorers/evidence-quality-scorer.js'
import type {
  EvidenceQualityInput,
  EvidenceQualityResult,
} from '../scorers/evidence-quality-scorer.js'

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function quality(input: EvidenceQualityInput): EvidenceQualityResult {
  return computeEvidenceQuality(input)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EvidenceQualityScorer', () => {
  describe('computeEvidenceQuality (pure function)', () => {
    it('perfect coverage: all claims have 2+ high-reliability sources => score near 1.0, confidence high', () => {
      const result = quality({
        claims: ['Claim A', 'Claim B', 'Claim C'],
        sources: [
          { url: 'https://a.com', reliability: 'high' },
          { url: 'https://b.com', reliability: 'high' },
          { url: 'https://c.com', reliability: 'high' },
        ],
        claimsWithSources: [
          { claim: 'Claim A', sourceIndices: [0, 1] },
          { claim: 'Claim B', sourceIndices: [1, 2] },
          { claim: 'Claim C', sourceIndices: [0, 2] },
        ],
      })

      // coverage = 3/3 = 1.0, corroboration = 3/3 = 1.0, reliability = 1.0
      // score = (1.0 * 0.4) + (1.0 * 0.3) + (1.0 * 0.3) = 1.0
      expect(result.score).toBeCloseTo(1.0, 2)
      expect(result.confidence).toBe('high')
      expect(result.coverage).toBe(1.0)
      expect(result.corroboration).toBe(1.0)
      expect(result.corroboratedCount).toBe(3)
      expect(result.unsupportedCount).toBe(0)
      expect(result.singleSourceCount).toBe(0)
    })

    it('zero claims => score 0, coverage 0', () => {
      const result = quality({
        claims: [],
        sources: [{ url: 'https://a.com', reliability: 'high' }],
      })

      expect(result.score).toBe(0)
      expect(result.coverage).toBe(0)
      expect(result.corroboration).toBe(0)
      expect(result.claimCount).toBe(0)
      expect(result.confidence).toBe('low')
      expect(result.details).toContain('No claims')
    })

    it('all claims single-source => corroboration=0, coverage=1, score in [0.4, 0.7]', () => {
      const result = quality({
        claims: ['Claim A', 'Claim B'],
        sources: [
          { url: 'https://a.com', reliability: 'high' },
          { url: 'https://b.com', reliability: 'high' },
        ],
        claimsWithSources: [
          { claim: 'Claim A', sourceIndices: [0] },
          { claim: 'Claim B', sourceIndices: [1] },
        ],
      })

      expect(result.coverage).toBe(1.0)
      expect(result.corroboration).toBe(0)
      expect(result.singleSourceCount).toBe(2)
      expect(result.corroboratedCount).toBe(0)
      // score = (1.0 * 0.4) + (0 * 0.3) + (1.0 * 0.3) = 0.7
      expect(result.score).toBeGreaterThanOrEqual(0.4)
      expect(result.score).toBeLessThanOrEqual(0.7)
    })

    it('half claims unsupported => coverage=0.5', () => {
      const result = quality({
        claims: ['Supported A', 'Supported B', 'Unsupported C', 'Unsupported D'],
        sources: [
          { url: 'https://a.com', reliability: 'medium' },
        ],
        claimsWithSources: [
          { claim: 'Supported A', sourceIndices: [0] },
          { claim: 'Supported B', sourceIndices: [0] },
          { claim: 'Unsupported C', sourceIndices: [] },
          { claim: 'Unsupported D', sourceIndices: [] },
        ],
      })

      expect(result.coverage).toBe(0.5)
      expect(result.unsupportedCount).toBe(2)
      expect(result.claimCount).toBe(4)
    })

    it('low-reliability sources only => reliabilityScore low', () => {
      const result = quality({
        claims: ['Claim A'],
        sources: [
          { url: 'https://low1.com', reliability: 'low' },
          { url: 'https://low2.com', reliability: 'low' },
        ],
        claimsWithSources: [
          { claim: 'Claim A', sourceIndices: [0, 1] },
        ],
      })

      // coverage = 1.0, corroboration = 1.0, reliability = 0.2
      // score = (1.0 * 0.4) + (1.0 * 0.3) + (0.2 * 0.3) = 0.76
      expect(result.score).toBeCloseTo(0.76, 2)
      expect(result.sourceReliabilityDistribution.low).toBe(2)
      expect(result.sourceReliabilityDistribution.high).toBe(0)
    })

    it('mix of high/medium/low reliability => distribution computed correctly', () => {
      const result = quality({
        claims: ['Claim A'],
        sources: [
          { url: 'https://h.com', reliability: 'high' },
          { url: 'https://m.com', reliability: 'medium' },
          { url: 'https://l.com', reliability: 'low' },
          { url: 'https://u.com' }, // no reliability = unknown
        ],
        claimsWithSources: [
          { claim: 'Claim A', sourceIndices: [0, 1, 2, 3] },
        ],
      })

      expect(result.sourceReliabilityDistribution).toEqual({
        high: 1,
        medium: 1,
        low: 1,
        unknown: 1,
      })

      // reliability = (1.0 + 0.6 + 0.2 + 0.4) / 4 = 0.55
      // coverage = 1.0, corroboration = 1.0
      // score = (1.0 * 0.4) + (1.0 * 0.3) + (0.55 * 0.3) = 0.865
      expect(result.score).toBeCloseTo(0.865, 2)
    })

    it('no claimsWithSources provided => all claims treated as supported by all sources', () => {
      const result = quality({
        claims: ['Claim A', 'Claim B'],
        sources: [
          { url: 'https://a.com', reliability: 'high' },
          { url: 'https://b.com', reliability: 'high' },
          { url: 'https://c.com', reliability: 'high' },
        ],
        // No claimsWithSources
      })

      // All claims have 3 sources each
      expect(result.coverage).toBe(1.0)
      expect(result.corroboration).toBe(1.0)
      expect(result.unsupportedCount).toBe(0)
      expect(result.corroboratedCount).toBe(2)
    })

    it('empty sources array => coverage=0, score=0', () => {
      const result = quality({
        claims: ['Claim A', 'Claim B'],
        sources: [],
        // No mapping — with 0 sources, each claim maps to 0 sources
      })

      // With no claimsWithSources and 0 sources, each claim has 0 sources
      expect(result.coverage).toBe(0)
      expect(result.corroboration).toBe(0)
      expect(result.unsupportedCount).toBe(2)
      // reliability = 0 (no sources)
      // score = (0 * 0.4) + (0 * 0.3) + (0 * 0.3) = 0
      expect(result.score).toBe(0)
      expect(result.confidence).toBe('low')
    })
  })

  describe('EvidenceQualityScorer class', () => {
    it('returns ScorerResult from score() with evidence metadata', async () => {
      const scorer = new EvidenceQualityScorer()

      const result = await scorer.score({
        input: 'Research question',
        output: 'Research output with claims',
        metadata: {
          evidence: {
            claims: ['Claim A'],
            sources: [{ url: 'https://a.com', reliability: 'high' }],
            claimsWithSources: [{ claim: 'Claim A', sourceIndices: [0] }],
          },
        },
      })

      expect(result.scorerId).toBe('evidence_quality')
      expect(result.aggregateScore).toBeGreaterThan(0)
      expect(result.scores).toHaveLength(3)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('returns score=0 when no evidence metadata is provided', async () => {
      const scorer = new EvidenceQualityScorer()

      const result = await scorer.score({
        input: 'Some input',
        output: 'Some output',
      })

      expect(result.aggregateScore).toBe(0)
      expect(result.passed).toBe(false)
      expect(result.scores[0]!.reasoning).toContain('No evidence metadata')
    })

    it('has correct config', () => {
      const scorer = new EvidenceQualityScorer()
      expect(scorer.config.id).toBe('evidence_quality')
      expect(scorer.config.type).toBe('deterministic')
    })
  })
})
