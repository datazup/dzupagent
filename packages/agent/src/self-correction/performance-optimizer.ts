/**
 * Agent Performance Optimizer --- auto-tunes cost/quality tradeoffs per node
 * based on actual execution history.
 *
 * Tracks quality scores, costs, durations, and error rates per pipeline node,
 * then recommends model tier changes, reflection depth adjustments, token
 * budget multipliers, and quality thresholds.
 *
 * Pure statistics --- no LLM calls. In-memory primary with optional BaseStore
 * persistence.
 *
 * @module self-correction/performance-optimizer
 */
import type { BaseStore } from '@langchain/langgraph'
import type { ModelTier } from './specialist-registry.js'

export type { ModelTier }

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface OptimizationDecision {
  nodeId: string
  /** Recommended model tier */
  modelTier: ModelTier
  /** Recommended reflection depth (0-5) */
  reflectionDepth: number
  /** Recommended quality threshold */
  qualityThreshold: number
  /** Recommended token budget multiplier (0.5-2.0) */
  tokenBudgetMultiplier: number
  /** Reasoning for the recommendation */
  reasoning: string
  /** Confidence in this recommendation (0-1) */
  confidence: number
  /** When this decision was made */
  timestamp: Date
}

export interface PerformanceHistory {
  nodeId: string
  /** Recent quality scores */
  qualityScores: number[]
  /** Recent cost in cents */
  costs: number[]
  /** Recent durations in ms */
  durations: number[]
  /** Error count in recent window */
  errorCount: number
  /** Total runs tracked */
  totalRuns: number
}

export interface PerformanceOptimizerConfig {
  store?: BaseStore
  namespace?: string[]
  /** Window of recent runs to consider (default: 20) */
  historyWindow?: number
  /** Cost threshold in cents above which to try downgrading model (default: 100) */
  costThresholdCents?: number
  /** Quality threshold below which to try upgrading model (default: 0.6) */
  qualityUpgradeThreshold?: number
  /** Error rate above which to increase reflection (default: 0.3) */
  errorRateReflectionThreshold?: number
}

/** Internal record for a single execution. */
interface ExecutionRecord {
  qualityScore: number
  costCents: number
  durationMs: number
  hadError: boolean
  modelTier: ModelTier
  reflectionDepth: number
  timestamp: Date
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_HISTORY_WINDOW = 20
const DEFAULT_COST_THRESHOLD_CENTS = 100
const DEFAULT_QUALITY_UPGRADE_THRESHOLD = 0.6
const DEFAULT_ERROR_RATE_REFLECTION_THRESHOLD = 0.3

const MODEL_TIER_ORDER: ModelTier[] = ['fast', 'balanced', 'powerful']

const STORE_KEY = 'optimizer_state'

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function upgradeTier(tier: ModelTier): ModelTier {
  const idx = MODEL_TIER_ORDER.indexOf(tier)
  return MODEL_TIER_ORDER[Math.min(idx + 1, MODEL_TIER_ORDER.length - 1)] as ModelTier
}

function downgradeTier(tier: ModelTier): ModelTier {
  const idx = MODEL_TIER_ORDER.indexOf(tier)
  return MODEL_TIER_ORDER[Math.max(idx - 1, 0)] as ModelTier
}

/* ------------------------------------------------------------------ */
/*  Implementation                                                     */
/* ------------------------------------------------------------------ */

export class AgentPerformanceOptimizer {
  private readonly store?: BaseStore
  private readonly namespace: string[]
  private readonly historyWindow: number
  private readonly costThresholdCents: number
  private readonly qualityUpgradeThreshold: number
  private readonly errorRateReflectionThreshold: number

  /** Per-node sliding window of execution records. */
  private executions = new Map<string, ExecutionRecord[]>()

  constructor(config?: PerformanceOptimizerConfig) {
    this.store = config?.store
    this.namespace = config?.namespace ?? ['performance_optimizer']
    this.historyWindow = config?.historyWindow ?? DEFAULT_HISTORY_WINDOW
    this.costThresholdCents = config?.costThresholdCents ?? DEFAULT_COST_THRESHOLD_CENTS
    this.qualityUpgradeThreshold = config?.qualityUpgradeThreshold ?? DEFAULT_QUALITY_UPGRADE_THRESHOLD
    this.errorRateReflectionThreshold = config?.errorRateReflectionThreshold ?? DEFAULT_ERROR_RATE_REFLECTION_THRESHOLD
  }

  /* ---------------------------------------------------------------- */
  /*  Record                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Record a node execution for optimization tracking.
   */
  recordExecution(params: {
    nodeId: string
    qualityScore: number
    costCents: number
    durationMs: number
    hadError: boolean
    modelTier: ModelTier
    reflectionDepth: number
  }): void {
    const record: ExecutionRecord = {
      qualityScore: params.qualityScore,
      costCents: params.costCents,
      durationMs: params.durationMs,
      hadError: params.hadError,
      modelTier: params.modelTier,
      reflectionDepth: params.reflectionDepth,
      timestamp: new Date(),
    }

    const existing = this.executions.get(params.nodeId) ?? []
    existing.push(record)

    // Trim to sliding window
    if (existing.length > this.historyWindow) {
      existing.splice(0, existing.length - this.historyWindow)
    }

    this.executions.set(params.nodeId, existing)
  }

  /* ---------------------------------------------------------------- */
  /*  Recommend                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Get optimization recommendation for a node.
   */
  getRecommendation(nodeId: string): OptimizationDecision {
    const records = this.executions.get(nodeId) ?? []
    const totalRuns = records.length

    if (totalRuns === 0) {
      return this.defaultDecision(nodeId, totalRuns)
    }

    const qualityScores = records.map(r => r.qualityScore)
    const costs = records.map(r => r.costCents)
    const avgQuality = mean(qualityScores)
    const avgCost = mean(costs)
    const errorCount = records.filter(r => r.hadError).length
    const errorRate = errorCount / totalRuns

    // Determine current predominant model tier and reflection depth
    const currentTier = this.predominantTier(records)
    const currentReflection = this.predominantReflection(records)

    const reasons: string[] = []
    let recommendedTier = currentTier
    let recommendedReflection = currentReflection

    // --- Model tier ---
    if (avgQuality > 0.85 && avgCost > this.costThresholdCents) {
      const downgraded = downgradeTier(currentTier)
      if (downgraded !== currentTier) {
        recommendedTier = downgraded
        reasons.push(
          `Avg quality ${avgQuality.toFixed(2)} > 0.85 with avg cost ${avgCost.toFixed(0)}c > ${this.costThresholdCents}c: downgrade ${currentTier} -> ${downgraded}`,
        )
      }
    } else if (avgQuality < this.qualityUpgradeThreshold) {
      const upgraded = upgradeTier(currentTier)
      if (upgraded !== currentTier) {
        recommendedTier = upgraded
        reasons.push(
          `Avg quality ${avgQuality.toFixed(2)} < ${this.qualityUpgradeThreshold}: upgrade ${currentTier} -> ${upgraded}`,
        )
      }
    }

    // --- Reflection depth ---
    if (errorRate > this.errorRateReflectionThreshold) {
      recommendedReflection = Math.min(currentReflection + 1, 5)
      if (recommendedReflection !== currentReflection) {
        reasons.push(
          `Error rate ${(errorRate * 100).toFixed(0)}% > ${(this.errorRateReflectionThreshold * 100).toFixed(0)}%: increase reflection ${currentReflection} -> ${recommendedReflection}`,
        )
      }
    } else if (errorRate < 0.1 && currentReflection > 0) {
      recommendedReflection = currentReflection - 1
      reasons.push(
        `Error rate ${(errorRate * 100).toFixed(0)}% < 10%: decrease reflection ${currentReflection} -> ${recommendedReflection}`,
      )
    }

    // --- Token budget multiplier ---
    // We approximate budget usage from cost trends: if costs are consistently
    // low relative to the mean, we can shrink the budget. If high, expand.
    const tokenBudgetMultiplier = this.computeTokenBudgetMultiplier(records)
    if (tokenBudgetMultiplier < 1.0) {
      reasons.push(
        `Runs consistently use low budget: multiplier ${tokenBudgetMultiplier.toFixed(2)}`,
      )
    } else if (tokenBudgetMultiplier > 1.0) {
      reasons.push(
        `Runs consistently use high budget: multiplier ${tokenBudgetMultiplier.toFixed(2)}`,
      )
    }

    // --- Quality threshold ---
    const qualityThreshold = avgQuality > 0 ? avgQuality * 0.95 : 0.5

    if (reasons.length === 0) {
      reasons.push('Performance within normal range; no changes recommended')
    }

    const confidence = Math.min(totalRuns / this.historyWindow, 1.0)

    return {
      nodeId,
      modelTier: recommendedTier,
      reflectionDepth: recommendedReflection,
      qualityThreshold,
      tokenBudgetMultiplier,
      reasoning: reasons.join('. '),
      confidence,
      timestamp: new Date(),
    }
  }

  /* ---------------------------------------------------------------- */
  /*  History                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Get performance history for a node.
   */
  getHistory(nodeId: string): PerformanceHistory {
    const records = this.executions.get(nodeId) ?? []
    return {
      nodeId,
      qualityScores: records.map(r => r.qualityScore),
      costs: records.map(r => r.costCents),
      durations: records.map(r => r.durationMs),
      errorCount: records.filter(r => r.hadError).length,
      totalRuns: records.length,
    }
  }

  /**
   * Get recommendations for all tracked nodes.
   */
  getAllRecommendations(): Map<string, OptimizationDecision> {
    const result = new Map<string, OptimizationDecision>()
    for (const nodeId of this.executions.keys()) {
      result.set(nodeId, this.getRecommendation(nodeId))
    }
    return result
  }

  /* ---------------------------------------------------------------- */
  /*  Reset                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Reset all tracking data.
   */
  reset(): void {
    this.executions.clear()
  }

  /* ---------------------------------------------------------------- */
  /*  Persistence                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Persist current state to store (if configured).
   */
  async persist(): Promise<void> {
    if (!this.store) return

    const serialized: Record<string, unknown> = {}
    for (const [nodeId, records] of this.executions) {
      serialized[nodeId] = records.map(r => ({
        qualityScore: r.qualityScore,
        costCents: r.costCents,
        durationMs: r.durationMs,
        hadError: r.hadError,
        modelTier: r.modelTier,
        reflectionDepth: r.reflectionDepth,
        timestamp: r.timestamp.toISOString(),
      }))
    }

    await this.store.put(this.namespace, STORE_KEY, {
      executions: serialized,
      text: 'performance optimizer state',
    })
  }

  /**
   * Load state from store (if configured).
   */
  async load(): Promise<void> {
    if (!this.store) return

    try {
      const item = await this.store.get(this.namespace, STORE_KEY)
      if (!item?.value) return

      const value = item.value as Record<string, unknown>
      const executionsRaw = value['executions'] as Record<string, unknown> | undefined
      if (!executionsRaw || typeof executionsRaw !== 'object') return

      this.executions.clear()

      for (const [nodeId, rawRecords] of Object.entries(executionsRaw)) {
        if (!Array.isArray(rawRecords)) continue
        const records: ExecutionRecord[] = []
        for (const raw of rawRecords as Record<string, unknown>[]) {
          records.push({
            qualityScore: typeof raw['qualityScore'] === 'number' ? raw['qualityScore'] : 0,
            costCents: typeof raw['costCents'] === 'number' ? raw['costCents'] : 0,
            durationMs: typeof raw['durationMs'] === 'number' ? raw['durationMs'] : 0,
            hadError: raw['hadError'] === true,
            modelTier: this.isValidTier(raw['modelTier']) ? raw['modelTier'] as ModelTier : 'balanced',
            reflectionDepth: typeof raw['reflectionDepth'] === 'number' ? raw['reflectionDepth'] : 0,
            timestamp: typeof raw['timestamp'] === 'string' ? new Date(raw['timestamp']) : new Date(),
          })
        }
        this.executions.set(nodeId, records)
      }
    } catch {
      // Store may not have data yet --- that is fine
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Private helpers                                                  */
  /* ---------------------------------------------------------------- */

  private defaultDecision(nodeId: string, totalRuns: number): OptimizationDecision {
    return {
      nodeId,
      modelTier: 'balanced',
      reflectionDepth: 1,
      qualityThreshold: 0.5,
      tokenBudgetMultiplier: 1.0,
      reasoning: 'No execution history; using defaults',
      confidence: Math.min(totalRuns / this.historyWindow, 1.0),
      timestamp: new Date(),
    }
  }

  /**
   * Find the most frequently used model tier in recent records.
   */
  private predominantTier(records: ExecutionRecord[]): ModelTier {
    const counts = new Map<ModelTier, number>()
    for (const r of records) {
      counts.set(r.modelTier, (counts.get(r.modelTier) ?? 0) + 1)
    }
    let best: ModelTier = 'balanced'
    let bestCount = 0
    for (const [tier, count] of counts) {
      if (count > bestCount) {
        best = tier
        bestCount = count
      }
    }
    return best
  }

  /**
   * Find the most frequently used reflection depth in recent records.
   */
  private predominantReflection(records: ExecutionRecord[]): number {
    const counts = new Map<number, number>()
    for (const r of records) {
      counts.set(r.reflectionDepth, (counts.get(r.reflectionDepth) ?? 0) + 1)
    }
    let best = 1
    let bestCount = 0
    for (const [depth, count] of counts) {
      if (count > bestCount) {
        best = depth
        bestCount = count
      }
    }
    return best
  }

  /**
   * Compute token budget multiplier based on cost usage patterns.
   *
   * Uses the ratio of recent costs to the average: if consistently below 50%
   * of average, shrink; if consistently above 90%, expand.
   */
  private computeTokenBudgetMultiplier(records: ExecutionRecord[]): number {
    if (records.length < 3) return 1.0

    const costs = records.map(r => r.costCents)
    const avg = mean(costs)
    if (avg === 0) return 1.0

    // Look at the last few records to determine trend
    const recentCount = Math.min(5, records.length)
    const recentCosts = costs.slice(-recentCount)
    const recentAvg = mean(recentCosts)

    const ratio = recentAvg / avg

    if (ratio < 0.5) {
      // Consistently using less than half --- shrink budget
      return clamp(0.7, 0.5, 2.0)
    } else if (ratio > 1.1) {
      // Recent costs trending upward (>10% above overall average) --- expand budget
      return clamp(1.3, 0.5, 2.0)
    }

    return 1.0
  }

  private isValidTier(value: unknown): value is ModelTier {
    return value === 'fast' || value === 'balanced' || value === 'powerful'
  }
}
