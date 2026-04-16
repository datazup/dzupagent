/**
 * Evidence Quality Scorer — evaluates research output by evidence quality.
 *
 * Scores claims against their supporting sources to assess:
 * - Coverage: fraction of claims with at least one source
 * - Corroboration: fraction of claims with two or more sources
 * - Source reliability: weighted average of source reliability ratings
 *
 * Composite score: (coverage * 0.4) + (corroboration * 0.3) + (reliabilityScore * 0.3)
 */

import type { Scorer, ScorerConfig, ScorerResult } from '../types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Reliability rating for a source. */
export type SourceReliability = 'high' | 'medium' | 'low'

/** A source with optional metadata. */
export interface EvidenceSource {
  url?: string | undefined
  title?: string | undefined
  reliability?: SourceReliability | undefined
  publishedAt?: string | undefined
}

/** Mapping of a claim to its supporting source indices. */
export interface ClaimSourceMapping {
  claim: string
  sourceIndices: number[]
}

/** Input for the evidence quality scorer. */
export interface EvidenceQualityInput {
  /** Array of claim strings made in the output */
  claims: string[]
  /** Array of source objects with metadata */
  sources: EvidenceSource[]
  /**
   * Optional: claim-to-source mapping.
   * If not provided, all claims are treated as supported by all sources.
   */
  claimsWithSources?: ClaimSourceMapping[] | undefined
}

/** Detailed result from the evidence quality scorer. */
export interface EvidenceQualityResult {
  /** Composite score 0-1 */
  score: number
  /** Confidence level derived from the composite score */
  confidence: 'high' | 'medium' | 'low'
  /** Fraction of claims with at least 1 source (0-1) */
  coverage: number
  /** Fraction of claims with 2+ sources (0-1) */
  corroboration: number
  /** Total number of claims */
  claimCount: number
  /** Number of claims with 2+ sources */
  corroboratedCount: number
  /** Number of claims with exactly 1 source */
  singleSourceCount: number
  /** Number of claims with 0 sources */
  unsupportedCount: number
  /** Distribution of source reliability ratings */
  sourceReliabilityDistribution: {
    high: number
    medium: number
    low: number
    unknown: number
  }
  /** Human-readable summary */
  details: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Weights for the composite score formula. */
const WEIGHT_COVERAGE = 0.4
const WEIGHT_CORROBORATION = 0.3
const WEIGHT_RELIABILITY = 0.3

/** Numeric values for reliability levels. */
const RELIABILITY_SCORES: Record<string, number> = {
  high: 1.0,
  medium: 0.6,
  low: 0.2,
}
const RELIABILITY_UNKNOWN = 0.4

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

/**
 * Evidence Quality Scorer — scores research output by evidence quality.
 *
 * Usage:
 * ```typescript
 * const scorer = new EvidenceQualityScorer()
 * const result = await scorer.score({
 *   input: 'Research query',
 *   output: 'Research output text',
 *   metadata: {
 *     evidence: {
 *       claims: ['Claim A', 'Claim B'],
 *       sources: [{ url: 'https://...', reliability: 'high' }],
 *       claimsWithSources: [
 *         { claim: 'Claim A', sourceIndices: [0] },
 *         { claim: 'Claim B', sourceIndices: [] },
 *       ],
 *     },
 *   },
 * })
 * ```
 */
export class EvidenceQualityScorer implements Scorer {
  readonly config: ScorerConfig = {
    id: 'evidence_quality',
    name: 'evidence-quality',
    description: 'Scores research output by evidence coverage, corroboration, and source reliability',
    type: 'deterministic',
  }

  async score(input: {
    input: string
    output: string
    metadata?: Record<string, unknown> | undefined
  }): Promise<ScorerResult> {
    const startTime = Date.now()
    const evidence = this.extractEvidenceInput(input.metadata)

    if (!evidence) {
      return {
        scorerId: this.config.id,
        scores: [{
          criterion: 'evidence-quality',
          score: 0,
          reasoning: 'No evidence metadata provided in input.metadata.evidence',
        }],
        aggregateScore: 0,
        passed: false,
        durationMs: Date.now() - startTime,
      }
    }

    const result = computeEvidenceQuality(evidence)

    return {
      scorerId: this.config.id,
      scores: [
        { criterion: 'coverage', score: result.coverage, reasoning: `${(result.coverage * 100).toFixed(0)}% of claims have at least one source` },
        { criterion: 'corroboration', score: result.corroboration, reasoning: `${(result.corroboration * 100).toFixed(0)}% of claims have 2+ sources` },
        { criterion: 'reliability', score: result.score, reasoning: `Source reliability distribution: ${JSON.stringify(result.sourceReliabilityDistribution)}` },
      ],
      aggregateScore: result.score,
      passed: result.confidence !== 'low',
      durationMs: Date.now() - startTime,
    }
  }

  /**
   * Extract EvidenceQualityInput from scorer metadata.
   */
  private extractEvidenceInput(
    metadata: Record<string, unknown> | undefined,
  ): EvidenceQualityInput | undefined {
    if (!metadata) return undefined
    const evidence = metadata['evidence']
    if (!evidence || typeof evidence !== 'object') return undefined

    const ev = evidence as Record<string, unknown>
    if (!Array.isArray(ev['claims']) || !Array.isArray(ev['sources'])) {
      return undefined
    }

    return {
      claims: ev['claims'] as string[],
      sources: ev['sources'] as EvidenceSource[],
      claimsWithSources: Array.isArray(ev['claimsWithSources'])
        ? ev['claimsWithSources'] as ClaimSourceMapping[]
        : undefined,
    }
  }
}

// ---------------------------------------------------------------------------
// Pure computation
// ---------------------------------------------------------------------------

/**
 * Compute evidence quality metrics from claims and sources.
 * Exported for direct use in tests and pipelines.
 */
export function computeEvidenceQuality(
  input: EvidenceQualityInput,
): EvidenceQualityResult {
  const { claims, sources, claimsWithSources } = input

  // Edge case: no claims
  if (claims.length === 0) {
    return {
      score: 0,
      confidence: 'low',
      coverage: 0,
      corroboration: 0,
      claimCount: 0,
      corroboratedCount: 0,
      singleSourceCount: 0,
      unsupportedCount: 0,
      sourceReliabilityDistribution: { high: 0, medium: 0, low: 0, unknown: 0 },
      details: 'No claims to evaluate',
    }
  }

  // Build per-claim source counts
  const claimSourceCounts = buildClaimSourceCounts(claims, sources, claimsWithSources)

  // Count categories
  let unsupportedCount = 0
  let singleSourceCount = 0
  let corroboratedCount = 0

  for (const count of claimSourceCounts) {
    if (count === 0) unsupportedCount++
    else if (count === 1) singleSourceCount++
    else corroboratedCount++
  }

  const claimCount = claims.length
  const supportedCount = claimCount - unsupportedCount

  // Coverage: fraction of claims with >= 1 source
  const coverage = supportedCount / claimCount

  // Corroboration: fraction of claims with >= 2 sources
  const corroboration = corroboratedCount / claimCount

  // Source reliability score
  const distribution = computeReliabilityDistribution(sources)
  const reliabilityScore = computeReliabilityScore(sources)

  // Composite score
  const score = (coverage * WEIGHT_COVERAGE)
    + (corroboration * WEIGHT_CORROBORATION)
    + (reliabilityScore * WEIGHT_RELIABILITY)

  // Confidence level
  const confidence = score >= 0.7 ? 'high' : score >= 0.4 ? 'medium' : 'low'

  const details = [
    `${claimCount} claims: ${supportedCount} supported, ${unsupportedCount} unsupported, ${corroboratedCount} corroborated`,
    `Coverage: ${(coverage * 100).toFixed(0)}%, Corroboration: ${(corroboration * 100).toFixed(0)}%`,
    `Source reliability: high=${distribution.high}, medium=${distribution.medium}, low=${distribution.low}, unknown=${distribution.unknown}`,
    `Composite score: ${score.toFixed(3)} (confidence: ${confidence})`,
  ].join('. ')

  return {
    score,
    confidence,
    coverage,
    corroboration,
    claimCount,
    corroboratedCount,
    singleSourceCount,
    unsupportedCount,
    sourceReliabilityDistribution: distribution,
    details,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build an array of source counts per claim.
 * When claimsWithSources is not provided, all claims are treated as
 * supported by all sources.
 */
function buildClaimSourceCounts(
  claims: string[],
  sources: EvidenceSource[],
  claimsWithSources: ClaimSourceMapping[] | undefined,
): number[] {
  if (!claimsWithSources) {
    // No mapping: all claims supported by all sources
    return claims.map(() => sources.length)
  }

  // Build a map from claim text to source count
  const mappingByClaim = new Map<string, number>()
  for (const mapping of claimsWithSources) {
    // Only count valid source indices
    const validCount = mapping.sourceIndices.filter(
      idx => idx >= 0 && idx < sources.length,
    ).length
    mappingByClaim.set(mapping.claim, validCount)
  }

  // For each claim, look up its source count (0 if not in the mapping)
  return claims.map(claim => mappingByClaim.get(claim) ?? 0)
}

/**
 * Compute the reliability distribution of sources.
 */
function computeReliabilityDistribution(
  sources: EvidenceSource[],
): { high: number; medium: number; low: number; unknown: number } {
  const dist = { high: 0, medium: 0, low: 0, unknown: 0 }
  for (const source of sources) {
    const rel = source.reliability
    if (rel === 'high' || rel === 'medium' || rel === 'low') {
      dist[rel]++
    } else {
      dist.unknown++
    }
  }
  return dist
}

/**
 * Compute the weighted average reliability score across all sources.
 * Returns 0 when there are no sources.
 */
function computeReliabilityScore(sources: EvidenceSource[]): number {
  if (sources.length === 0) return 0

  let total = 0
  for (const source of sources) {
    const rel = source.reliability
    total += RELIABILITY_SCORES[rel ?? ''] ?? RELIABILITY_UNKNOWN
  }

  return total / sources.length
}
