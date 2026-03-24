/**
 * Reciprocal Rank Fusion (RRF) to combine results from multiple retrieval methods.
 *
 * RRF score: score(d) = SUM(1 / (k + rank_i(d))) across all methods
 * Default k = 60 (standard RRF constant from Cormack et al. 2009)
 */

type SourceName = 'vector' | 'fts' | 'graph'

interface ScoredItem {
  key: string
  score: number
  value: Record<string, unknown>
}

export interface FusedResult {
  key: string
  score: number
  value: Record<string, unknown>
  /** Which methods contributed to this result */
  sources: SourceName[]
}

export function fusionSearch(
  results: {
    vector?: ScoredItem[]
    fts?: ScoredItem[]
    graph?: ScoredItem[]
  },
  options?: { k?: number; limit?: number },
): FusedResult[] {
  const k = options?.k ?? 60
  const limit = options?.limit ?? 10

  const fused = new Map<string, { score: number; value: Record<string, unknown>; sources: Set<SourceName> }>()

  const sources: [SourceName, ScoredItem[] | undefined][] = [
    ['vector', results.vector],
    ['fts', results.fts],
    ['graph', results.graph],
  ]

  for (const [sourceName, items] of sources) {
    if (!items) continue
    for (let rank = 0; rank < items.length; rank++) {
      const item = items[rank]
      if (!item) continue
      const rrfScore = 1 / (k + rank)
      const existing = fused.get(item.key)
      if (existing) {
        existing.score += rrfScore
        existing.sources.add(sourceName)
      } else {
        fused.set(item.key, {
          score: rrfScore,
          value: item.value,
          sources: new Set([sourceName]),
        })
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
    .slice(0, limit)
}
