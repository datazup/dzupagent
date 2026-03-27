/**
 * LearningDashboardService -- aggregates learning metrics from all
 * self-correction module stores into a structured format for API
 * consumption and frontend dashboards.
 *
 * Read-only: never writes to store. All operations are best-effort --
 * empty store or store errors produce zero/empty results.
 *
 * @module self-correction/learning-dashboard
 */

import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** High-level counts of learning artifacts. */
export interface LearningOverview {
  /** Total lessons stored */
  lessonCount: number
  /** Total rules stored */
  ruleCount: number
  /** Total acquired skills */
  skillCount: number
  /** Total trajectories recorded */
  trajectoryCount: number
  /** Total feedback records */
  feedbackCount: number
  /** Loaded skill pack IDs */
  loadedPacks: string[]
}

/** Quality trend across recent pipeline runs. */
export interface QualityTrend {
  /** Quality scores per run (last N runs) */
  scores: Array<{ runId: string; score: number; timestamp: string }>
  /** Average quality */
  average: number
  /** Trend direction */
  trend: 'improving' | 'stable' | 'declining'
  /** Improvement ratio from first window to last window */
  improvement: number
}

/** Cost trend across recent pipeline runs. */
export interface CostTrend {
  /** Cost per run (last N runs) */
  costs: Array<{ runId: string; costCents: number; timestamp: string }>
  /** Average cost */
  average: number
  /** Trend direction */
  trend: 'increasing' | 'stable' | 'decreasing'
}

/** Aggregated performance summary for a single pipeline node. */
export interface NodePerformanceSummary {
  nodeId: string
  avgQuality: number
  avgDurationMs: number
  errorRate: number
  runsTracked: number
}

/** Full dashboard payload combining all sections. */
export interface LearningDashboard {
  overview: LearningOverview
  qualityTrend: QualityTrend
  costTrend: CostTrend
  nodePerformance: NodePerformanceSummary[]
  topLessons: Array<{ summary: string; confidence: number; applyCount: number }>
  topRules: Array<{ content: string; confidence: number; successRate: number }>
  recentErrors: Array<{ nodeId: string; error: string; timestamp: string }>
}

/** Configuration for the LearningDashboardService. */
export interface DashboardServiceConfig {
  store: BaseStore
  namespace?: string[]
  /** Max items per section (default: 10) */
  maxItems?: number
  /** Max runs for trend analysis (default: 20) */
  maxTrendRuns?: number
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ITEMS = 10
const DEFAULT_MAX_TREND_RUNS = 20
/** Window size for trend comparison (first N vs last N). */
const TREND_WINDOW = 5

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function safeNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function computeTrendDirection(
  scores: number[],
  improvingLabel: string,
  decliningLabel: string,
  stableLabel: string,
): string {
  if (scores.length < 2) return stableLabel
  const window = Math.min(TREND_WINDOW, Math.floor(scores.length / 2))
  if (window === 0) return stableLabel

  const firstSlice = scores.slice(0, window)
  const lastSlice = scores.slice(-window)

  const firstAvg = firstSlice.reduce((a, b) => a + b, 0) / firstSlice.length
  const lastAvg = lastSlice.reduce((a, b) => a + b, 0) / lastSlice.length

  const diff = lastAvg - firstAvg
  const threshold = Math.max(firstAvg * 0.05, 0.01)

  if (diff > threshold) return improvingLabel
  if (diff < -threshold) return decliningLabel
  return stableLabel
}

// ---------------------------------------------------------------------------
// LearningDashboardService
// ---------------------------------------------------------------------------

export class LearningDashboardService {
  private readonly store: BaseStore
  private readonly ns: string[]
  private readonly maxItems: number
  private readonly maxTrendRuns: number

  constructor(config: DashboardServiceConfig) {
    this.store = config.store
    this.ns = config.namespace ?? []
    this.maxItems = config.maxItems ?? DEFAULT_MAX_ITEMS
    this.maxTrendRuns = config.maxTrendRuns ?? DEFAULT_MAX_TREND_RUNS
  }

  // -------------------------------------------------------------------------
  // Full dashboard
  // -------------------------------------------------------------------------

  /** Get the full dashboard data. Calls all sub-methods in parallel. */
  async getDashboard(): Promise<LearningDashboard> {
    const results = await Promise.allSettled([
      this.getOverview(),
      this.getQualityTrend(),
      this.getCostTrend(),
      this.getNodePerformance(),
      this.getTopLessons(),
      this.getTopRules(),
      this.getRecentErrors(),
    ])

    return {
      overview: results[0].status === 'fulfilled' ? results[0].value : emptyOverview(),
      qualityTrend: results[1].status === 'fulfilled' ? results[1].value : emptyQualityTrend(),
      costTrend: results[2].status === 'fulfilled' ? results[2].value : emptyCostTrend(),
      nodePerformance: results[3].status === 'fulfilled' ? results[3].value : [],
      topLessons: results[4].status === 'fulfilled' ? results[4].value : [],
      topRules: results[5].status === 'fulfilled' ? results[5].value : [],
      recentErrors: results[6].status === 'fulfilled' ? results[6].value : [],
    }
  }

  // -------------------------------------------------------------------------
  // Overview (lightweight)
  // -------------------------------------------------------------------------

  /** Get just the overview (lightweight). */
  async getOverview(): Promise<LearningOverview> {
    const [lessons, rules, skills, trajectories, feedback, packs] =
      await Promise.allSettled([
        this.countItems([...this.ns, 'lessons']),
        this.countItems([...this.ns, 'rules']),
        this.countItems([...this.ns, 'skills']),
        this.countItems([...this.ns, 'trajectories', 'runs']),
        this.countItems([...this.ns, 'feedback']),
        this.loadPackIds(),
      ])

    return {
      lessonCount: fulfilled(lessons, 0),
      ruleCount: fulfilled(rules, 0),
      skillCount: fulfilled(skills, 0),
      trajectoryCount: fulfilled(trajectories, 0),
      feedbackCount: fulfilled(feedback, 0),
      loadedPacks: fulfilled(packs, []),
    }
  }

  // -------------------------------------------------------------------------
  // Quality trend
  // -------------------------------------------------------------------------

  /** Get quality trend for last N runs. */
  async getQualityTrend(limit?: number): Promise<QualityTrend> {
    const maxRuns = limit ?? this.maxTrendRuns
    const trajectories = await this.loadTrajectories(maxRuns)

    if (trajectories.length === 0) return emptyQualityTrend()

    // Sort by timestamp ascending
    trajectories.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    const scores = trajectories.map((t) => ({
      runId: safeString(t.runId),
      score: safeNumber(t.overallScore),
      timestamp: safeString(t.timestamp),
    }))

    const numericScores = scores.map((s) => s.score)
    const average = numericScores.reduce((a, b) => a + b, 0) / numericScores.length

    const trend = computeTrendDirection(
      numericScores,
      'improving',
      'declining',
      'stable',
    ) as QualityTrend['trend']

    // Improvement: ratio change from first window average to last window average
    const window = Math.min(TREND_WINDOW, Math.floor(numericScores.length / 2)) || 1
    const firstAvg = numericScores.slice(0, window).reduce((a, b) => a + b, 0) / window
    const lastAvg = numericScores.slice(-window).reduce((a, b) => a + b, 0) / window
    const improvement = firstAvg > 0 ? (lastAvg - firstAvg) / firstAvg : 0

    return { scores, average, trend, improvement }
  }

  // -------------------------------------------------------------------------
  // Cost trend
  // -------------------------------------------------------------------------

  /** Get cost trend for last N runs. */
  async getCostTrend(limit?: number): Promise<CostTrend> {
    const maxRuns = limit ?? this.maxTrendRuns
    const trajectories = await this.loadTrajectories(maxRuns)

    if (trajectories.length === 0) return emptyCostTrend()

    // Sort by timestamp ascending
    trajectories.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    const costs = trajectories.map((t) => ({
      runId: safeString(t.runId),
      costCents: safeNumber(t.totalCostCents),
      timestamp: safeString(t.timestamp),
    }))

    const numericCosts = costs.map((c) => c.costCents)
    const average = numericCosts.reduce((a, b) => a + b, 0) / numericCosts.length

    // For cost: "increasing" is the opposite direction of "improving"
    const trend = computeTrendDirection(
      numericCosts,
      'increasing',
      'decreasing',
      'stable',
    ) as CostTrend['trend']

    return { costs, average, trend }
  }

  // -------------------------------------------------------------------------
  // Node performance
  // -------------------------------------------------------------------------

  /** Get per-node performance summaries. */
  async getNodePerformance(): Promise<NodePerformanceSummary[]> {
    const trajectories = await this.loadTrajectories(1000)

    // Accumulate per-node stats
    const nodeStats = new Map<
      string,
      { qualitySum: number; durationSum: number; errorSum: number; count: number }
    >()

    for (const traj of trajectories) {
      const steps = Array.isArray(traj.steps) ? (traj.steps as Record<string, unknown>[]) : []
      for (const step of steps) {
        const nodeId = safeString(step['nodeId'])
        if (!nodeId) continue

        const existing = nodeStats.get(nodeId) ?? {
          qualitySum: 0,
          durationSum: 0,
          errorSum: 0,
          count: 0,
        }

        existing.qualitySum += safeNumber(step['qualityScore'])
        existing.durationSum += safeNumber(step['durationMs'])
        existing.errorSum += safeNumber(step['errorCount'])
        existing.count += 1
        nodeStats.set(nodeId, existing)
      }
    }

    const summaries: NodePerformanceSummary[] = []
    for (const [nodeId, stats] of nodeStats) {
      summaries.push({
        nodeId,
        avgQuality: stats.count > 0 ? stats.qualitySum / stats.count : 0,
        avgDurationMs: stats.count > 0 ? stats.durationSum / stats.count : 0,
        errorRate: stats.count > 0 ? stats.errorSum / stats.count : 0,
        runsTracked: stats.count,
      })
    }

    // Sort by most-tracked first
    summaries.sort((a, b) => b.runsTracked - a.runsTracked)
    return summaries.slice(0, this.maxItems)
  }

  // -------------------------------------------------------------------------
  // Top lessons
  // -------------------------------------------------------------------------

  /** Get top lessons sorted by confidence descending. */
  async getTopLessons(): Promise<
    Array<{ summary: string; confidence: number; applyCount: number }>
  > {
    try {
      const ns = [...this.ns, 'lessons']
      const items = await this.store.search(ns, { limit: this.maxItems * 3 })

      const lessons = items.map((item) => {
        const v = item.value as Record<string, unknown>
        return {
          summary: safeString(v['summary'] || v['text']),
          confidence: safeNumber(v['confidence'], 0),
          applyCount: safeNumber(v['applyCount'], 0),
        }
      })

      lessons.sort((a, b) => b.confidence - a.confidence)
      return lessons.slice(0, this.maxItems)
    } catch {
      return []
    }
  }

  // -------------------------------------------------------------------------
  // Top rules
  // -------------------------------------------------------------------------

  /** Get top rules sorted by success rate descending. */
  async getTopRules(): Promise<
    Array<{ content: string; confidence: number; successRate: number }>
  > {
    try {
      const ns = [...this.ns, 'rules']
      const items = await this.store.search(ns, { limit: this.maxItems * 3 })

      const rules = items.map((item) => {
        const v = item.value as Record<string, unknown>
        return {
          content: safeString(v['content'] || v['text']),
          confidence: safeNumber(v['confidence'], 0),
          successRate: safeNumber(v['successRate'], 0),
        }
      })

      rules.sort((a, b) => b.successRate - a.successRate)
      return rules.slice(0, this.maxItems)
    } catch {
      return []
    }
  }

  // -------------------------------------------------------------------------
  // Recent errors
  // -------------------------------------------------------------------------

  /** Get recent errors. */
  async getRecentErrors(): Promise<
    Array<{ nodeId: string; error: string; timestamp: string }>
  > {
    try {
      const ns = [...this.ns, 'errors']
      const items = await this.store.search(ns, { limit: this.maxItems * 2 })

      const errors = items.map((item) => {
        const v = item.value as Record<string, unknown>
        return {
          nodeId: safeString(v['nodeId']),
          error: safeString(v['message'] || v['error'] || v['text']),
          timestamp: safeString(v['timestamp']),
        }
      })

      // Sort by timestamp descending (most recent first)
      errors.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      return errors.slice(0, this.maxItems)
    } catch {
      return []
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Count items in a namespace. Best-effort. */
  private async countItems(namespace: string[]): Promise<number> {
    try {
      const items = await this.store.search(namespace, { limit: 10_000 })
      return items.length
    } catch {
      return 0
    }
  }

  /** Load pack IDs from the packs_loaded namespace. */
  private async loadPackIds(): Promise<string[]> {
    try {
      const ns = [...this.ns, 'packs_loaded']
      const items = await this.store.search(ns, { limit: 1000 })
      return items.map((item) => {
        const v = item.value as Record<string, unknown>
        return safeString(v['packId'] || item.key)
      })
    } catch {
      return []
    }
  }

  /** Load trajectory records from the trajectories/runs namespace. */
  private async loadTrajectories(
    limit: number = this.maxTrendRuns,
  ): Promise<Array<Record<string, unknown>>> {
    try {
      const ns = [...this.ns, 'trajectories', 'runs']
      const items = await this.store.search(ns, { limit })
      return items.map((item) => item.value as Record<string, unknown>)
    } catch {
      return []
    }
  }
}

// ---------------------------------------------------------------------------
// Empty defaults
// ---------------------------------------------------------------------------

function emptyOverview(): LearningOverview {
  return {
    lessonCount: 0,
    ruleCount: 0,
    skillCount: 0,
    trajectoryCount: 0,
    feedbackCount: 0,
    loadedPacks: [],
  }
}

function emptyQualityTrend(): QualityTrend {
  return { scores: [], average: 0, trend: 'stable', improvement: 0 }
}

function emptyCostTrend(): CostTrend {
  return { costs: [], average: 0, trend: 'stable' }
}

function fulfilled<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === 'fulfilled' ? result.value : fallback
}
