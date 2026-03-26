/**
 * Strategy Selector — adapts fix strategy based on historical success rates.
 *
 * The feature generator uses a 3-tier fix escalation: targeted -> contextual ->
 * regenerative. By default the system always starts at targeted and escalates
 * linearly. This module examines historical outcome data so the system can
 * skip strategies that have consistently low success rates and jump directly
 * to the strategy most likely to succeed.
 *
 * Uses `BaseStore` from `@langchain/langgraph` for persistence.
 * Pure statistics — no LLM calls.
 *
 * @module self-correction/strategy-selector
 */

import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three fix escalation tiers. */
export type FixStrategy = 'targeted' | 'contextual' | 'regenerative'

/** Aggregated success rate for a single strategy. */
export interface StrategyRate {
  attempts: number
  successes: number
  rate: number
}

/** Recommendation returned by {@link StrategySelector.recommend}. */
export interface StrategyRecommendation {
  /** Recommended starting strategy. */
  strategy: FixStrategy
  /** Confidence in this recommendation (0-1). */
  confidence: number
  /** Why this strategy was recommended. */
  reasoning: string
  /** Historical success rates for each strategy. */
  historicalRates: Record<FixStrategy, StrategyRate>
  /** Whether to escalate the model (use more expensive model). */
  escalateModel: boolean
  /** Suggested max fix attempts. */
  suggestedMaxAttempts: number
}

/** Configuration for the {@link StrategySelector}. */
export interface StrategySelectorConfig {
  /** BaseStore for persisting outcome records. */
  store: BaseStore
  /** Namespace prefix (default: `['strategy-selector']`). */
  namespace?: string[]
  /** Minimum historical data points before making recommendations (default: 3). */
  minDataPoints?: number
  /** Success rate threshold below which a strategy is skipped (default: 0.2). */
  skipThreshold?: number
  /** Success rate threshold above which a strategy is actively recommended (default: 0.6). */
  recommendThreshold?: number
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Shape of a persisted outcome record. */
interface OutcomeRecord {
  errorType: string
  nodeId: string
  strategy: FixStrategy
  success: boolean
  timestamp: string
}

/** Ordered escalation path. */
const STRATEGY_ORDER: readonly FixStrategy[] = [
  'targeted',
  'contextual',
  'regenerative',
] as const

/** Maximum outcome records retained per nodeId + errorType combination. */
const MAX_OUTCOMES = 50

// ---------------------------------------------------------------------------
// StrategySelector
// ---------------------------------------------------------------------------

/**
 * Examines historical fix-attempt outcomes to recommend which escalation
 * strategy to start with for a given error type at a given pipeline node.
 */
export class StrategySelector {
  private readonly store: BaseStore
  private readonly namespace: string[]
  private readonly minDataPoints: number
  private readonly skipThreshold: number
  private readonly recommendThreshold: number

  constructor(config: StrategySelectorConfig) {
    this.store = config.store
    this.namespace = config.namespace ?? ['strategy-selector']
    this.minDataPoints = config.minDataPoints ?? 3
    this.skipThreshold = config.skipThreshold ?? 0.2
    this.recommendThreshold = config.recommendThreshold ?? 0.6
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Get a strategy recommendation for a given error context.
   */
  async recommend(params: {
    errorType: string
    nodeId: string
    errorMessage?: string
  }): Promise<StrategyRecommendation> {
    const { errorType, nodeId } = params
    const rates = await this.getHistoricalRates(nodeId, errorType)
    const totalAttempts = rates.targeted.attempts + rates.contextual.attempts + rates.regenerative.attempts

    // Insufficient data — return default
    if (totalAttempts < this.minDataPoints) {
      return {
        strategy: 'targeted',
        confidence: 0.3,
        reasoning: `Insufficient historical data (${totalAttempts}/${this.minDataPoints} data points). Defaulting to targeted strategy.`,
        historicalRates: rates,
        escalateModel: false,
        suggestedMaxAttempts: 3,
      }
    }

    // Walk the escalation order and find the best strategy
    let recommended: FixStrategy = 'targeted'
    const reasons: string[] = []

    // Check if targeted should be skipped
    if (
      rates.targeted.attempts >= this.minDataPoints &&
      rates.targeted.rate < this.skipThreshold
    ) {
      reasons.push(
        `Skipping targeted: ${(rates.targeted.rate * 100).toFixed(0)}% success rate (${rates.targeted.successes}/${rates.targeted.attempts}) below ${(this.skipThreshold * 100).toFixed(0)}% threshold.`,
      )
      recommended = 'contextual'

      // Check if contextual should also be skipped
      if (
        rates.contextual.attempts >= this.minDataPoints &&
        rates.contextual.rate < this.skipThreshold
      ) {
        reasons.push(
          `Skipping contextual: ${(rates.contextual.rate * 100).toFixed(0)}% success rate (${rates.contextual.successes}/${rates.contextual.attempts}) below ${(this.skipThreshold * 100).toFixed(0)}% threshold.`,
        )
        recommended = 'regenerative'
      }
    }

    // Check if regenerative is strongly recommended (high rate)
    if (
      rates.regenerative.attempts >= this.minDataPoints &&
      rates.regenerative.rate > this.recommendThreshold
    ) {
      // Only override if current recommendation is not already regenerative
      // or if regenerative is clearly superior
      if (recommended !== 'regenerative') {
        const currentRate = rates[recommended].rate
        if (rates.regenerative.rate > currentRate + 0.2) {
          reasons.push(
            `Regenerative has ${(rates.regenerative.rate * 100).toFixed(0)}% success rate, significantly better than ${recommended} at ${(currentRate * 100).toFixed(0)}%.`,
          )
          recommended = 'regenerative'
        }
      }
    }

    // If we haven't added any reasons, explain the default pick
    if (reasons.length === 0) {
      const rate = rates[recommended]
      reasons.push(
        `Starting with ${recommended}: ${(rate.rate * 100).toFixed(0)}% success rate (${rate.successes}/${rate.attempts}).`,
      )
    }

    // Model escalation: recommend if going straight to regenerative
    const escalateModel = recommended === 'regenerative'

    // Confidence: based on how much data we have and how clear the signal is
    const confidence = this.computeConfidence(rates, recommended)

    // Suggested max attempts: high overall success rate needs fewer attempts
    const suggestedMaxAttempts = this.computeSuggestedAttempts(rates)

    return {
      strategy: recommended,
      confidence,
      reasoning: reasons.join(' '),
      historicalRates: rates,
      escalateModel,
      suggestedMaxAttempts,
    }
  }

  /**
   * Record a fix attempt outcome for future learning.
   */
  async recordOutcome(params: {
    errorType: string
    nodeId: string
    strategy: FixStrategy
    success: boolean
  }): Promise<void> {
    const { errorType, nodeId, strategy, success } = params
    const ns = [...this.namespace, 'outcomes', nodeId, errorType]
    const key = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const record: OutcomeRecord = {
      errorType,
      nodeId,
      strategy,
      success,
      timestamp: new Date().toISOString(),
    }

    await this.store.put(ns, key, record as unknown as Record<string, unknown>)

    // Prune old records if over the limit
    await this.pruneOutcomes(ns)
  }

  /**
   * Get historical success rates for all strategies at a node.
   */
  async getHistoricalRates(
    nodeId: string,
    errorType?: string,
  ): Promise<Record<FixStrategy, StrategyRate>> {
    const empty: Record<FixStrategy, StrategyRate> = {
      targeted: { attempts: 0, successes: 0, rate: 0 },
      contextual: { attempts: 0, successes: 0, rate: 0 },
      regenerative: { attempts: 0, successes: 0, rate: 0 },
    }

    const outcomes = await this.loadOutcomes(nodeId, errorType)

    for (const outcome of outcomes) {
      const strat = outcome.strategy
      if (!STRATEGY_ORDER.includes(strat)) continue

      empty[strat].attempts++
      if (outcome.success) {
        empty[strat].successes++
      }
    }

    // Compute rates
    for (const strat of STRATEGY_ORDER) {
      const entry = empty[strat]
      entry.rate = entry.attempts > 0 ? entry.successes / entry.attempts : 0
    }

    return empty
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Load outcome records from the store for a given nodeId (and optional errorType).
   */
  private async loadOutcomes(
    nodeId: string,
    errorType?: string,
  ): Promise<OutcomeRecord[]> {
    if (errorType) {
      // Specific error type — load from the exact namespace
      const ns = [...this.namespace, 'outcomes', nodeId, errorType]
      return this.loadOutcomesFromNs(ns)
    }

    // No error type specified — we would need to enumerate all error types.
    // Since BaseStore doesn't support namespace listing, we search the
    // node-level namespace. For now, we return an empty set when no errorType
    // is given and the store doesn't support namespace enumeration.
    // Callers should always provide errorType for meaningful results.
    return []
  }

  private async loadOutcomesFromNs(ns: string[]): Promise<OutcomeRecord[]> {
    try {
      const items = await this.store.search(ns, { limit: MAX_OUTCOMES })
      const outcomes: OutcomeRecord[] = []

      for (const item of items) {
        const value = item.value as unknown as OutcomeRecord
        if (!value.strategy || typeof value.success !== 'boolean') continue
        outcomes.push(value)
      }

      return outcomes
    } catch {
      return []
    }
  }

  /**
   * Prune outcomes in a namespace to keep at most MAX_OUTCOMES entries.
   * Removes the oldest entries (by timestamp) first.
   */
  private async pruneOutcomes(ns: string[]): Promise<void> {
    try {
      const items = await this.store.search(ns, { limit: MAX_OUTCOMES + 20 })
      if (items.length <= MAX_OUTCOMES) return

      // Sort by timestamp ascending (oldest first)
      const sorted = [...items].sort((a, b) => {
        const aTs = (a.value as unknown as OutcomeRecord).timestamp ?? ''
        const bTs = (b.value as unknown as OutcomeRecord).timestamp ?? ''
        return aTs < bTs ? -1 : aTs > bTs ? 1 : 0
      })

      const toRemove = sorted.slice(0, sorted.length - MAX_OUTCOMES)
      for (const item of toRemove) {
        await this.store.delete(ns, item.key)
      }
    } catch {
      // Pruning is best-effort
    }
  }

  /**
   * Compute confidence based on data volume and signal clarity.
   */
  private computeConfidence(
    rates: Record<FixStrategy, StrategyRate>,
    recommended: FixStrategy,
  ): number {
    const recRate = rates[recommended]
    const totalAttempts =
      rates.targeted.attempts + rates.contextual.attempts + rates.regenerative.attempts

    // Base confidence from data volume (more data = higher confidence)
    const volumeFactor = Math.min(totalAttempts / 20, 1) // max out at 20 data points

    // Signal clarity: how far is the recommended strategy's rate from the skip threshold?
    const clarityFactor =
      recRate.attempts > 0 ? Math.min(recRate.rate / this.recommendThreshold, 1) : 0.3

    // Combine (weighted average)
    const confidence = 0.4 * volumeFactor + 0.6 * clarityFactor

    return Math.round(confidence * 100) / 100
  }

  /**
   * Compute suggested max attempts based on overall success rates.
   * High overall success -> fewer attempts needed (min 1, max 5).
   */
  private computeSuggestedAttempts(
    rates: Record<FixStrategy, StrategyRate>,
  ): number {
    const totalAttempts =
      rates.targeted.attempts + rates.contextual.attempts + rates.regenerative.attempts
    const totalSuccesses =
      rates.targeted.successes + rates.contextual.successes + rates.regenerative.successes
    const overallRate = totalAttempts > 0 ? totalSuccesses / totalAttempts : 0.5

    // High success rate -> fewer attempts (2), low rate -> more attempts (5)
    if (overallRate >= 0.8) return 2
    if (overallRate >= 0.6) return 3
    if (overallRate >= 0.4) return 4
    return 5
  }
}
