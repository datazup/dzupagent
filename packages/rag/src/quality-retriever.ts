/**
 * QualityBoostedRetriever — Wrapper around HybridRetriever that applies
 * source-level quality boosting from an external quality map.
 *
 * Unlike HybridRetriever's built-in quality boosting (which only uses
 * chunk-embedded metadata), this retriever accepts an explicit
 * SourceQualityMap so callers can inject per-source quality scores
 * from any source (e.g., user ratings, freshness, authority scores).
 */

import type { HybridRetriever } from './retriever.js'
import type { RetrievalResult, RetrievalConfig, ScoredChunk } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Map of sourceId → quality score (0–1) */
export interface SourceQualityMap {
  [sourceId: string]: number
}

/** Configuration for the quality boost blending */
export interface QualityBoostConfig {
  /** Weight for chunk-level quality (default 0.6) */
  chunkWeight?: number
  /** Weight for source-level quality (default 0.4) */
  sourceWeight?: number
  /** Minimum score threshold — chunks below this are dropped (default 0.0) */
  minScore?: number
}

// ---------------------------------------------------------------------------
// QualityBoostedRetriever
// ---------------------------------------------------------------------------

/**
 * Wraps a HybridRetriever and re-scores results using an explicit
 * source quality map. The final score is:
 *
 *   score = rawScore × (chunkWeight × chunkQuality + sourceWeight × sourceQuality)
 *
 * After boosting, chunks below `minScore` are dropped and results are
 * re-sorted by descending score.
 */
export class QualityBoostedRetriever {
  private readonly chunkWeight: number
  private readonly sourceWeight: number
  private readonly minScore: number

  constructor(
    private readonly baseRetriever: HybridRetriever,
    config?: QualityBoostConfig,
  ) {
    this.chunkWeight = config?.chunkWeight ?? 0.6
    this.sourceWeight = config?.sourceWeight ?? 0.4
    this.minScore = config?.minScore ?? 0.0
  }

  /**
   * Retrieve and apply quality boosting.
   *
   * @param query - Natural language query
   * @param filter - Metadata filter for the underlying retriever
   * @param sourceQualities - Per-source quality scores (0–1)
   * @param options - Per-query overrides for retrieval config
   */
  async retrieve(
    query: string,
    filter: Record<string, unknown>,
    sourceQualities: SourceQualityMap,
    options?: Partial<RetrievalConfig>,
  ): Promise<RetrievalResult> {
    // Delegate to the base retriever (disable its built-in quality boosting
    // so we don't double-boost)
    const result = await this.baseRetriever.retrieve(query, filter, {
      ...options,
      qualityBoosting: false,
    })

    // Apply external quality boosting
    const boosted: ScoredChunk[] = result.chunks.map(chunk => {
      const sourceQuality = sourceQualities[chunk.sourceId] ?? 0.5
      const chunkQuality = chunk.qualityScore ?? 0.5
      const boost =
        this.chunkWeight * chunkQuality + this.sourceWeight * sourceQuality

      return {
        ...chunk,
        score: chunk.score * boost,
        qualityScore: chunkQuality,
      }
    })

    // Filter by minimum score and re-sort
    const filtered = boosted
      .filter(c => c.score >= this.minScore)
      .sort((a, b) => b.score - a.score)

    return {
      ...result,
      chunks: filtered,
    }
  }
}
