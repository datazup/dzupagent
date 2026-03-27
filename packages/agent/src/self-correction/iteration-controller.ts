/**
 * Adaptive iteration controller — cost-aware iteration with diminishing returns detection.
 *
 * Tracks quality improvement over iterations and decides whether further
 * iterations are likely to be worthwhile based on score trends, cost budget,
 * and plateau detection.
 */

/** Decision returned by the controller after each iteration */
export interface IterationDecision {
  /** Whether to continue iterating */
  shouldContinue: boolean
  /** Why this decision was made */
  reason:
    | 'continue'
    | 'target_met'
    | 'budget_exhausted'
    | 'no_improvement'
    | 'diminishing_returns'
    | 'cost_prohibitive'
  /** Estimated probability of improvement on next iteration (0-1) */
  improvementProbability: number
  /** Estimated remaining cost to reach target */
  estimatedCostToTarget: number
}

/** Configuration for the adaptive iteration controller */
export interface IterationControllerConfig {
  /** Target quality score (0-1, default: 0.8) */
  targetScore: number
  /** Max iterations (default: 5) */
  maxIterations: number
  /** Max total cost in cents (default: 100) */
  costBudgetCents: number
  /** Minimum improvement per iteration to continue (default: 0.02) */
  minImprovement: number
  /** Number of no-improvement iterations before stopping (default: 2) */
  plateauPatience: number
}

const DEFAULT_CONFIG: IterationControllerConfig = {
  targetScore: 0.8,
  maxIterations: 5,
  costBudgetCents: 100,
  minImprovement: 0.02,
  plateauPatience: 2,
}

export class AdaptiveIterationController {
  private readonly config: IterationControllerConfig
  private scores: number[] = []
  private costs: number[] = []

  constructor(config?: Partial<IterationControllerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Record a completed iteration with its score and cost, and decide whether to continue.
   */
  decide(score: number, costCents: number): IterationDecision {
    this.scores.push(score)
    this.costs.push(costCents)

    const totalCost = this.totalCostCents
    const improvementProbability = this.estimateImprovementProbability()
    const estimatedCostToTarget = this.estimateCostToTarget()

    // a. Target met
    if (score >= this.config.targetScore) {
      return {
        shouldContinue: false,
        reason: 'target_met',
        improvementProbability,
        estimatedCostToTarget: 0,
      }
    }

    // b. Max iterations
    if (this.scores.length >= this.config.maxIterations) {
      return {
        shouldContinue: false,
        reason: 'budget_exhausted',
        improvementProbability,
        estimatedCostToTarget,
      }
    }

    // c. Budget exhausted (95% threshold)
    if (totalCost >= this.config.costBudgetCents * 0.95) {
      return {
        shouldContinue: false,
        reason: 'budget_exhausted',
        improvementProbability,
        estimatedCostToTarget,
      }
    }

    // d. No improvement (plateau patience)
    if (this.isPlateaued()) {
      return {
        shouldContinue: false,
        reason: 'no_improvement',
        improvementProbability,
        estimatedCostToTarget,
      }
    }

    // e. Diminishing returns
    if (this.isDiminishing()) {
      return {
        shouldContinue: false,
        reason: 'diminishing_returns',
        improvementProbability,
        estimatedCostToTarget,
      }
    }

    // f. Cost-prohibitive
    const remainingBudget = this.config.costBudgetCents - totalCost
    if (estimatedCostToTarget > remainingBudget && this.scores.length >= 2) {
      return {
        shouldContinue: false,
        reason: 'cost_prohibitive',
        improvementProbability,
        estimatedCostToTarget,
      }
    }

    // g. Continue
    return {
      shouldContinue: true,
      reason: 'continue',
      improvementProbability,
      estimatedCostToTarget,
    }
  }

  /** Get current iteration number (0-based count of recorded iterations) */
  get currentIteration(): number {
    return this.scores.length
  }

  /** Get score history */
  get scoreHistory(): readonly number[] {
    return this.scores
  }

  /** Get cumulative cost */
  get totalCostCents(): number {
    return this.costs.reduce((sum, c) => sum + c, 0)
  }

  /** Get the best score achieved so far */
  get bestScore(): number {
    if (this.scores.length === 0) return 0
    return Math.max(...this.scores)
  }

  /** Reset for a new task */
  reset(): void {
    this.scores = []
    this.costs = []
  }

  // ---- Private helpers ----

  /** Check if scores have plateaued (no improvement across plateauPatience iterations) */
  private isPlateaued(): boolean {
    const { plateauPatience, minImprovement } = this.config
    if (this.scores.length < plateauPatience + 1) return false

    const recentScores = this.scores.slice(-(plateauPatience + 1))
    const baseline = recentScores[0]!

    // Check if ALL of the last `plateauPatience` scores failed to improve over the baseline
    for (let i = 1; i < recentScores.length; i++) {
      if (recentScores[i]! - baseline >= minImprovement) {
        return false
      }
    }
    return true
  }

  /** Check for diminishing returns: last delta < previous delta * 0.5 AND last delta < minImprovement */
  private isDiminishing(): boolean {
    if (this.scores.length < 3) return false

    const len = this.scores.length
    const lastDelta = this.scores[len - 1]! - this.scores[len - 2]!
    const prevDelta = this.scores[len - 2]! - this.scores[len - 3]!

    return prevDelta > 0 && lastDelta < prevDelta * 0.5 && lastDelta < this.config.minImprovement
  }

  /**
   * Estimate probability of improvement on next iteration.
   * Uses exponentially weighted recent deltas.
   */
  private estimateImprovementProbability(): number {
    if (this.scores.length < 2) return 0.5 // no data yet, neutral estimate

    const deltas: number[] = []
    for (let i = 1; i < this.scores.length; i++) {
      deltas.push(this.scores[i]! - this.scores[i - 1]!)
    }

    // Exponential weighting: more recent deltas matter more
    const alpha = 0.7
    let weightedSum = 0
    let weightTotal = 0
    for (let i = deltas.length - 1; i >= 0; i--) {
      const weight = Math.pow(alpha, deltas.length - 1 - i)
      weightedSum += deltas[i]! > 0 ? weight : 0
      weightTotal += weight
    }

    return Math.min(1, Math.max(0, weightedSum / weightTotal))
  }

  /**
   * Estimate remaining cost to reach target.
   * Formula: (targetScore - currentScore) / avgImprovementPerIteration * avgCostPerIteration
   */
  private estimateCostToTarget(): number {
    if (this.scores.length === 0) return Infinity

    const currentScore = this.scores[this.scores.length - 1]!
    const gap = this.config.targetScore - currentScore
    if (gap <= 0) return 0

    // Average improvement per iteration (only positive improvements)
    const deltas: number[] = []
    for (let i = 1; i < this.scores.length; i++) {
      deltas.push(this.scores[i]! - this.scores[i - 1]!)
    }

    const avgImprovement =
      deltas.length > 0 ? deltas.reduce((s, d) => s + d, 0) / deltas.length : 0

    if (avgImprovement <= 0) return Infinity

    const avgCost = this.totalCostCents / this.scores.length
    const estimatedIterations = gap / avgImprovement
    return estimatedIterations * avgCost
  }
}
