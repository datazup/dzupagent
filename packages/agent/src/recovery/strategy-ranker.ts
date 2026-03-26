/**
 * Strategy ranker — scores and ranks recovery strategies based on
 * confidence, risk, cost, and attempt history.
 *
 * @module recovery/strategy-ranker
 */

import type {
  RecoveryStrategy,
  RiskLevel,
} from './recovery-types.js'

// ---------------------------------------------------------------------------
// Ranking configuration
// ---------------------------------------------------------------------------

/** Weights used to compute a composite score for ranking strategies. */
export interface RankingWeights {
  /** Weight for strategy confidence (default: 0.5). */
  confidence: number
  /** Weight for inverse risk (default: 0.3). */
  risk: number
  /** Weight for inverse estimated steps / cost (default: 0.2). */
  cost: number
}

const DEFAULT_WEIGHTS: RankingWeights = {
  confidence: 0.5,
  risk: 0.3,
  cost: 0.2,
}

// ---------------------------------------------------------------------------
// Risk numeric mapping
// ---------------------------------------------------------------------------

const RISK_SCORES: Record<RiskLevel, number> = {
  low: 1.0,
  medium: 0.5,
  high: 0.1,
}

// ---------------------------------------------------------------------------
// StrategyRanker
// ---------------------------------------------------------------------------

export class StrategyRanker {
  private readonly weights: RankingWeights
  private readonly attemptedStrategies = new Set<string>()

  constructor(weights?: Partial<RankingWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights }
  }

  /**
   * Rank an array of strategies, returning them in descending score order.
   * Strategies that have already been attempted are penalized heavily.
   */
  rank(strategies: RecoveryStrategy[]): RecoveryStrategy[] {
    const scored = strategies.map(s => ({
      strategy: s,
      score: this.computeScore(s),
    }))

    scored.sort((a, b) => b.score - a.score)

    return scored.map(s => s.strategy)
  }

  /**
   * Compute the composite score for a single strategy.
   */
  computeScore(strategy: RecoveryStrategy): number {
    const confidenceScore = strategy.confidence * this.weights.confidence
    const riskScore = RISK_SCORES[strategy.risk] * this.weights.risk

    // Inverse cost: fewer steps = higher score. Cap at 10 steps.
    const maxSteps = 10
    const costScore = (1 - Math.min(strategy.estimatedSteps, maxSteps) / maxSteps) * this.weights.cost

    let total = confidenceScore + riskScore + costScore

    // Penalize already-attempted strategies
    if (this.attemptedStrategies.has(strategy.name)) {
      total *= 0.1
    }

    return Math.round(total * 1000) / 1000
  }

  /**
   * Select the best strategy from a ranked list.
   * Returns null if no strategies are available or all have been attempted.
   */
  selectBest(
    strategies: RecoveryStrategy[],
    minConfidence = 0,
  ): RecoveryStrategy | null {
    const ranked = this.rank(strategies)

    for (const strategy of ranked) {
      if (strategy.confidence >= minConfidence) {
        // Prefer strategies that haven't been attempted
        if (!this.attemptedStrategies.has(strategy.name)) {
          return strategy
        }
      }
    }

    // All non-attempted strategies are below threshold; return first unattempted
    for (const strategy of ranked) {
      if (!this.attemptedStrategies.has(strategy.name)) {
        return strategy
      }
    }

    return null
  }

  /**
   * Mark a strategy as attempted. Future rankings will penalize it.
   */
  markAttempted(strategyName: string): void {
    this.attemptedStrategies.add(strategyName)
  }

  /**
   * Check whether a strategy has already been attempted.
   */
  wasAttempted(strategyName: string): boolean {
    return this.attemptedStrategies.has(strategyName)
  }

  /**
   * Reset attempt tracking. Useful at session boundaries.
   */
  reset(): void {
    this.attemptedStrategies.clear()
  }
}
