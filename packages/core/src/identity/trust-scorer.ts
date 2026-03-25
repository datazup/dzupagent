/**
 * Trust scoring for agent identities.
 *
 * Computes a composite trust score from reliability, performance,
 * cost-predictability, delegation-compliance, and recency signals.
 */

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** Raw trust signals collected for an agent. */
export interface TrustSignals {
  /** Total outcomes recorded. */
  totalOutcomes: number
  /** Successful outcomes. */
  successfulOutcomes: number
  /** Average response time in ms. */
  avgResponseTimeMs: number
  /** Target response time in ms (for performance scoring). */
  targetResponseTimeMs: number
  /** Actual costs vs estimated costs (ratio, 1.0 = exact match). */
  costAccuracyRatio: number
  /** Number of delegation constraint violations. */
  constraintViolations: number
  /** Total delegations received. */
  totalDelegations: number
  /** Timestamp of most recent outcome. */
  lastOutcomeAt: Date
}

// ---------------------------------------------------------------------------
// Score breakdown
// ---------------------------------------------------------------------------

/** Breakdown of the trust score by dimension. */
export interface TrustScoreBreakdown {
  /** Success rate (0-1), weight 0.35. */
  reliability: number
  /** Response-time score (0-1), weight 0.20. */
  performance: number
  /** Cost accuracy score (0-1), weight 0.15. */
  costPredictability: number
  /** Delegation constraint compliance (0-1), weight 0.15. */
  delegationCompliance: number
  /** Recency decay score (0-1), weight 0.15. */
  recency: number
  /** Weighted total (0-1). */
  total: number
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for the trust scorer. */
export interface TrustScorerConfig {
  /** Minimum outcomes before scoring (below this, score defaults to 0.5). */
  minSampleSize?: number
  /** Half-life for recency decay in ms (default: 7 days). */
  recencyHalfLifeMs?: number
  /** Callback for significant score changes. */
  onScoreChanged?: (agentId: string, previousScore: number, newScore: number) => void
  /** Threshold for "significant" change (default: 0.05). */
  significanceThreshold?: number
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Persistence interface for trust signals and scores. */
export interface TrustScoreStore {
  getSignals(agentId: string): Promise<TrustSignals | undefined>
  saveSignals(agentId: string, signals: TrustSignals): Promise<void>
  getScore(agentId: string): Promise<number | undefined>
  saveScore(agentId: string, score: number): Promise<void>
}

/** Simple in-memory implementation of TrustScoreStore. */
export class InMemoryTrustScoreStore implements TrustScoreStore {
  private readonly signals = new Map<string, TrustSignals>()
  private readonly scores = new Map<string, number>()

  async getSignals(agentId: string): Promise<TrustSignals | undefined> {
    return this.signals.get(agentId)
  }

  async saveSignals(agentId: string, signals: TrustSignals): Promise<void> {
    this.signals.set(agentId, signals)
  }

  async getScore(agentId: string): Promise<number | undefined> {
    return this.scores.get(agentId)
  }

  async saveScore(agentId: string, score: number): Promise<void> {
    this.scores.set(agentId, score)
  }
}

// ---------------------------------------------------------------------------
// Scorer interface
// ---------------------------------------------------------------------------

/** Public API for trust scoring. */
export interface TrustScorer {
  /** Calculate trust score from signals. */
  calculate(signals: TrustSignals): TrustScoreBreakdown

  /** Record an outcome and update score. */
  recordOutcome(
    agentId: string,
    outcome: {
      success: boolean
      responseTimeMs: number
      estimatedCostCents?: number
      actualCostCents?: number
      constraintViolation?: boolean
    },
  ): Promise<TrustScoreBreakdown>

  /** Get current trust score for an agent. */
  getScore(agentId: string): Promise<number>

  /** Get min trust across a delegation chain. */
  getChainTrust(chain: { tokens: Array<{ delegatee: string }> }): Promise<number>
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

const WEIGHT_RELIABILITY = 0.35
const WEIGHT_PERFORMANCE = 0.20
const WEIGHT_COST = 0.15
const WEIGHT_DELEGATION = 0.15
const WEIGHT_RECENCY = 0.15

const DEFAULT_MIN_SAMPLE_SIZE = 5
const DEFAULT_RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const DEFAULT_SIGNIFICANCE_THRESHOLD = 0.05
const DEFAULT_SCORE = 0.5

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a TrustScorer instance. */
export function createTrustScorer(
  config?: TrustScorerConfig & { store?: TrustScoreStore },
): TrustScorer {
  const minSampleSize = config?.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE
  const halfLifeMs = config?.recencyHalfLifeMs ?? DEFAULT_RECENCY_HALF_LIFE_MS
  const significanceThreshold = config?.significanceThreshold ?? DEFAULT_SIGNIFICANCE_THRESHOLD
  const onScoreChanged = config?.onScoreChanged
  const store: TrustScoreStore = config?.store ?? new InMemoryTrustScoreStore()

  function calculate(signals: TrustSignals): TrustScoreBreakdown {
    if (signals.totalOutcomes < minSampleSize) {
      return {
        reliability: DEFAULT_SCORE,
        performance: DEFAULT_SCORE,
        costPredictability: DEFAULT_SCORE,
        delegationCompliance: DEFAULT_SCORE,
        recency: DEFAULT_SCORE,
        total: DEFAULT_SCORE,
      }
    }

    const reliability =
      signals.totalOutcomes > 0
        ? signals.successfulOutcomes / signals.totalOutcomes
        : 0

    const performance =
      signals.avgResponseTimeMs > 0
        ? Math.min(1.0, signals.targetResponseTimeMs / signals.avgResponseTimeMs)
        : 1.0

    const costPredictability = 1.0 - Math.min(1.0, Math.abs(signals.costAccuracyRatio - 1.0))

    const delegationDenominator = Math.max(1, signals.totalDelegations)
    const delegationCompliance = 1.0 - signals.constraintViolations / delegationDenominator

    const timeSinceLastOutcome = Date.now() - signals.lastOutcomeAt.getTime()
    const recency = Math.pow(2, -(timeSinceLastOutcome / halfLifeMs))

    const total =
      reliability * WEIGHT_RELIABILITY +
      performance * WEIGHT_PERFORMANCE +
      costPredictability * WEIGHT_COST +
      delegationCompliance * WEIGHT_DELEGATION +
      recency * WEIGHT_RECENCY

    return {
      reliability,
      performance,
      costPredictability,
      delegationCompliance,
      recency,
      total,
    }
  }

  async function recordOutcome(
    agentId: string,
    outcome: {
      success: boolean
      responseTimeMs: number
      estimatedCostCents?: number
      actualCostCents?: number
      constraintViolation?: boolean
    },
  ): Promise<TrustScoreBreakdown> {
    const existing = await store.getSignals(agentId)
    const now = new Date()

    let signals: TrustSignals

    if (existing) {
      const newTotal = existing.totalOutcomes + 1
      const newSuccessful = existing.successfulOutcomes + (outcome.success ? 1 : 0)

      // Running average for response time
      const newAvgResponseTime =
        (existing.avgResponseTimeMs * existing.totalOutcomes + outcome.responseTimeMs) / newTotal

      // Update cost accuracy ratio if cost data provided
      let newCostRatio = existing.costAccuracyRatio
      if (
        outcome.estimatedCostCents !== undefined &&
        outcome.actualCostCents !== undefined &&
        outcome.estimatedCostCents > 0
      ) {
        const thisRatio = outcome.actualCostCents / outcome.estimatedCostCents
        // Running average of cost ratio
        newCostRatio =
          (existing.costAccuracyRatio * existing.totalOutcomes + thisRatio) / newTotal
      }

      const newViolations =
        existing.constraintViolations + (outcome.constraintViolation ? 1 : 0)
      const newDelegations =
        existing.totalDelegations + (outcome.constraintViolation !== undefined ? 1 : 0)

      signals = {
        totalOutcomes: newTotal,
        successfulOutcomes: newSuccessful,
        avgResponseTimeMs: newAvgResponseTime,
        targetResponseTimeMs: existing.targetResponseTimeMs,
        costAccuracyRatio: newCostRatio,
        constraintViolations: newViolations,
        totalDelegations: newDelegations,
        lastOutcomeAt: now,
      }
    } else {
      const costRatio =
        outcome.estimatedCostCents !== undefined &&
        outcome.actualCostCents !== undefined &&
        outcome.estimatedCostCents > 0
          ? outcome.actualCostCents / outcome.estimatedCostCents
          : 1.0

      signals = {
        totalOutcomes: 1,
        successfulOutcomes: outcome.success ? 1 : 0,
        avgResponseTimeMs: outcome.responseTimeMs,
        targetResponseTimeMs: outcome.responseTimeMs, // default target = first response time
        costAccuracyRatio: costRatio,
        constraintViolations: outcome.constraintViolation ? 1 : 0,
        totalDelegations: outcome.constraintViolation !== undefined ? 1 : 0,
        lastOutcomeAt: now,
      }
    }

    await store.saveSignals(agentId, signals)

    const breakdown = calculate(signals)
    const previousScore = (await store.getScore(agentId)) ?? DEFAULT_SCORE

    await store.saveScore(agentId, breakdown.total)

    if (
      onScoreChanged &&
      Math.abs(breakdown.total - previousScore) >= significanceThreshold
    ) {
      onScoreChanged(agentId, previousScore, breakdown.total)
    }

    return breakdown
  }

  async function getScore(agentId: string): Promise<number> {
    const stored = await store.getScore(agentId)
    return stored ?? DEFAULT_SCORE
  }

  async function getChainTrust(chain: {
    tokens: Array<{ delegatee: string }>
  }): Promise<number> {
    if (chain.tokens.length === 0) {
      return DEFAULT_SCORE
    }

    let minScore = Infinity
    for (const token of chain.tokens) {
      const score = await getScore(token.delegatee)
      if (score < minScore) {
        minScore = score
      }
    }
    return minScore
  }

  return {
    calculate,
    recordOutcome,
    getScore,
    getChainTrust,
  }
}
