/**
 * Bid evaluation strategies for the contract-net protocol.
 *
 * Each strategy sorts bids from best to worst according to
 * a specific criterion or weighted combination.
 */
import type { BidEvaluationStrategy, ContractBid } from './contract-net-types.js'

/** Sort by lowest estimated cost first. */
export const lowestCostStrategy: BidEvaluationStrategy = {
  evaluate(bids: ContractBid[]): ContractBid[] {
    return [...bids].sort((a, b) => a.estimatedCostCents - b.estimatedCostCents)
  },
}

/** Sort by fastest estimated duration first. */
export const fastestStrategy: BidEvaluationStrategy = {
  evaluate(bids: ContractBid[]): ContractBid[] {
    return [...bids].sort((a, b) => a.estimatedDurationMs - b.estimatedDurationMs)
  },
}

/** Sort by highest quality estimate first. */
export const highestQualityStrategy: BidEvaluationStrategy = {
  evaluate(bids: ContractBid[]): ContractBid[] {
    return [...bids].sort((a, b) => b.qualityEstimate - a.qualityEstimate)
  },
}

/**
 * Weighted multi-criteria scoring strategy.
 *
 * Normalizes each criterion to a 0-1 range across all bids and computes
 * a weighted score. Bids are sorted by score descending (best first).
 *
 * - Cost: lower is better -> `1 - (cost / maxCost)`
 * - Speed: lower is better -> `1 - (duration / maxDuration)`
 * - Quality: higher is better -> used as-is
 *
 * Weights are normalized so they sum to 1.
 */
export function createWeightedStrategy(weights: {
  cost?: number
  speed?: number
  quality?: number
}): BidEvaluationStrategy {
  const rawCost = weights.cost ?? 0.4
  const rawSpeed = weights.speed ?? 0.3
  const rawQuality = weights.quality ?? 0.3
  const total = rawCost + rawSpeed + rawQuality

  const costWeight = total > 0 ? rawCost / total : 1 / 3
  const speedWeight = total > 0 ? rawSpeed / total : 1 / 3
  const qualityWeight = total > 0 ? rawQuality / total : 1 / 3

  return {
    evaluate(bids: ContractBid[]): ContractBid[] {
      if (bids.length === 0) return []
      if (bids.length === 1) return [...bids]

      const maxCost = Math.max(...bids.map(b => b.estimatedCostCents))
      const maxDuration = Math.max(...bids.map(b => b.estimatedDurationMs))

      const scored = bids.map(bid => {
        const normalizedCost = maxCost > 0
          ? 1 - bid.estimatedCostCents / maxCost
          : 1
        const normalizedSpeed = maxDuration > 0
          ? 1 - bid.estimatedDurationMs / maxDuration
          : 1
        const normalizedQuality = bid.qualityEstimate

        const score =
          costWeight * normalizedCost +
          speedWeight * normalizedSpeed +
          qualityWeight * normalizedQuality

        return { bid, score }
      })

      scored.sort((a, b) => b.score - a.score)
      return scored.map(s => s.bid)
    },
  }
}
