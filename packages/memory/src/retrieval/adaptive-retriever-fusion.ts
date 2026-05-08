/**
 * Weighted Reciprocal-Rank Fusion (RRF) used by the adaptive retriever.
 *
 * Extracted from `adaptive-retriever.ts` to keep the main file focused
 * on coordinating retrieval rather than implementing fusion arithmetic.
 */

import type { FusedResult } from './rrf-fusion.js';
import type { RetrievalWeights, ScoredItem, SourceName } from './adaptive-retriever-types.js';

/**
 * Weighted RRF fusion: score(d) = SUM(weight_i * (1 / (k + rank_i(d))))
 */
export function weightedFusion(
  results: Partial<Record<SourceName, ScoredItem[]>>,
  weights: RetrievalWeights,
  options: { k: number; limit: number },
): FusedResult[] {
  const { k, limit } = options;

  const fused = new Map<
    string,
    { score: number; value: Record<string, unknown>; sources: Set<SourceName> }
  >();

  const sources: [SourceName, ScoredItem[] | undefined][] = [
    ['vector', results.vector],
    ['fts', results.fts],
    ['graph', results.graph],
  ];

  for (const [sourceName, items] of sources) {
    if (!items) continue;
    const weight = weights[sourceName];
    for (let rank = 0; rank < items.length; rank++) {
      const item = items[rank];
      if (!item) continue;
      const rrfScore = weight * (1 / (k + rank));
      const existing = fused.get(item.key);
      if (existing) {
        existing.score += rrfScore;
        existing.sources.add(sourceName);
      } else {
        fused.set(item.key, {
          score: rrfScore,
          value: item.value,
          sources: new Set([sourceName]),
        });
      }
    }
  }

  return Array.from(fused.entries())
    .map(([key, data]) => ({
      key,
      score: data.score,
      value: data.value,
      sources: Array.from(data.sources),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Redistribute weights from missing sources proportionally to available ones.
 *
 * Ensures that when a provider is unavailable (or has failed at runtime), its
 * weight is split across the remaining providers in proportion to their existing
 * weights. If all available weights are zero, distributes equally.
 */
export function redistributeWeights(
  original: RetrievalWeights,
  available: SourceName[],
): RetrievalWeights {
  const allSources: SourceName[] = ['vector', 'fts', 'graph'];

  // If all sources available, return original
  if (available.length === allSources.length) {
    return { ...original };
  }

  const availableTotal = available.reduce((sum, s) => sum + original[s], 0);

  // Avoid division by zero: if all available weights are 0, distribute equally
  if (availableTotal === 0) {
    const equal = 1 / available.length;
    const result: RetrievalWeights = { vector: 0, fts: 0, graph: 0 };
    for (const s of available) {
      result[s] = equal;
    }
    return result;
  }

  // Scale available weights so they sum to 1
  const scale = 1 / availableTotal;
  const result: RetrievalWeights = { vector: 0, fts: 0, graph: 0 };
  for (const s of available) {
    result[s] = original[s] * scale;
  }
  return result;
}
