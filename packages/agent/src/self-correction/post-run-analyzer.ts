/**
 * Post-Run Analyzer — orchestrates consolidation after each pipeline run.
 *
 * After a feature generation pipeline completes (success or failure), this
 * module extracts all learnings and stores them for future runs. It is the
 * CAPTURE+CONSOLIDATE phase of the self-learning loop.
 *
 * Uses `BaseStore` from `@langchain/langgraph` directly (not LessonPipeline
 * or RuleEngine) to avoid circular dependencies while writing to the same
 * namespace formats those modules read from.
 *
 * All operations are best-effort — `analyze()` will never throw.
 *
 * @module self-correction/post-run-analyzer
 */

import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Analysis of a completed pipeline run. */
export interface RunAnalysis {
  runId: string
  /** Per-node quality scores */
  nodeScores: Map<string, number>
  /** Errors that occurred and their resolutions */
  errors: Array<{
    nodeId: string
    error: string
    resolved: boolean
    resolution?: string
    fixAttempt?: number
  }>
  /** Overall quality score (0-1) */
  overallScore: number
  /** Total cost in cents */
  totalCostCents: number
  /** Total duration in ms */
  totalDurationMs: number
  /** Task type (e.g., 'crud', 'auth', 'dashboard') */
  taskType: string
  /** Risk class */
  riskClass: 'critical' | 'sensitive' | 'standard' | 'cosmetic'
  /** Whether the run was approved by user */
  approved: boolean
  /** User feedback (if rejected) */
  feedback?: string
}

/** Result of analyzing a pipeline run. */
export interface AnalysisResult {
  /** Lessons extracted from this run */
  lessonsCreated: number
  /** Rules generated from errors */
  rulesCreated: number
  /** Whether trajectory was stored (only for high-quality runs) */
  trajectoryStored: boolean
  /** Suboptimal nodes detected */
  suboptimalNodes: string[]
  /** Summary for logging */
  summary: string
}

/** Configuration for the PostRunAnalyzer. */
export interface PostRunAnalyzerConfig {
  /** Store for persisting analysis data and lessons */
  store: BaseStore
  /** Namespace prefix (default: ['post_run']) */
  namespace?: string[]
}

/** A persisted analysis history entry. */
export interface AnalysisHistoryEntry {
  runId: string
  result: AnalysisResult
  timestamp: Date
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum overall score to store a trajectory */
const TRAJECTORY_THRESHOLD = 0.7

/** Minimum overall score to extract success patterns */
const SUCCESS_PATTERN_THRESHOLD = 0.85

/** Minimum node score to be considered a "high-scoring" node */
const HIGH_NODE_SCORE_THRESHOLD = 0.9

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function analysisResultToRecord(
  runId: string,
  result: AnalysisResult,
): Record<string, unknown> {
  return {
    runId,
    lessonsCreated: result.lessonsCreated,
    rulesCreated: result.rulesCreated,
    trajectoryStored: result.trajectoryStored,
    suboptimalNodes: result.suboptimalNodes,
    summary: result.summary,
    timestamp: new Date().toISOString(),
    text: `analysis ${runId} lessons=${result.lessonsCreated} rules=${result.rulesCreated}`,
  }
}

function recordToHistoryEntry(value: Record<string, unknown>): AnalysisHistoryEntry | null {
  if (typeof value['runId'] !== 'string') return null
  return {
    runId: value['runId'] as string,
    result: {
      lessonsCreated: typeof value['lessonsCreated'] === 'number' ? value['lessonsCreated'] : 0,
      rulesCreated: typeof value['rulesCreated'] === 'number' ? value['rulesCreated'] : 0,
      trajectoryStored: typeof value['trajectoryStored'] === 'boolean' ? value['trajectoryStored'] : false,
      suboptimalNodes: Array.isArray(value['suboptimalNodes']) ? value['suboptimalNodes'] as string[] : [],
      summary: typeof value['summary'] === 'string' ? value['summary'] : '',
    },
    timestamp: typeof value['timestamp'] === 'string'
      ? new Date(value['timestamp'])
      : new Date(),
  }
}

// ---------------------------------------------------------------------------
// PostRunAnalyzer
// ---------------------------------------------------------------------------

export class PostRunAnalyzer {
  private readonly store: BaseStore
  private readonly namespace: string[]

  constructor(config: PostRunAnalyzerConfig) {
    this.store = config.store
    this.namespace = config.namespace ?? ['post_run']
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Analyze a completed pipeline run and extract all learnings.
   * This is the main entry point — call after pipeline completes.
   *
   * Best-effort: never throws.
   */
  async analyze(run: RunAnalysis): Promise<AnalysisResult> {
    let lessonsCreated = 0
    let rulesCreated = 0
    let trajectoryStored = false
    const suboptimalNodes: string[] = []

    // (a) Store trajectory if high quality
    try {
      if (run.overallScore > TRAJECTORY_THRESHOLD) {
        await this.storeTrajectory(run)
        trajectoryStored = true
      }
    } catch {
      // best-effort
    }

    // (b) Extract lessons from resolved errors
    try {
      const errorLessons = await this.extractErrorLessons(run)
      lessonsCreated += errorLessons
    } catch {
      // best-effort
    }

    // (c) Extract success patterns from high-quality runs
    try {
      if (run.overallScore > SUCCESS_PATTERN_THRESHOLD) {
        const successLessons = await this.extractSuccessPatterns(run)
        lessonsCreated += successLessons
      }
    } catch {
      // best-effort
    }

    // (d) Generate rules from resolved errors
    try {
      const rules = await this.generateRulesFromErrors(run)
      rulesCreated += rules
    } catch {
      // best-effort
    }

    // (e) Detect suboptimal nodes
    try {
      const detected = await this.detectSuboptimalNodes(run)
      suboptimalNodes.push(...detected)
    } catch {
      // best-effort
    }

    const result: AnalysisResult = {
      lessonsCreated,
      rulesCreated,
      trajectoryStored,
      suboptimalNodes,
      summary: '', // filled below
    }

    // (g) Build summary string
    result.summary = this.buildSummary(run, result)

    // (f) Store analysis result for history
    try {
      await this.storeAnalysis(run.runId, result)
    } catch {
      // best-effort
    }

    return result
  }

  /**
   * Get analysis history for recent runs.
   */
  async getRecentAnalyses(limit = 10): Promise<AnalysisHistoryEntry[]> {
    try {
      const ns = [...this.namespace, 'history']
      const items = await this.store.search(ns, { limit: limit * 2 })
      const entries: AnalysisHistoryEntry[] = []
      for (const item of items) {
        const entry = recordToHistoryEntry(item.value as Record<string, unknown>)
        if (entry) entries.push(entry)
      }
      // Sort by timestamp descending
      entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      return entries.slice(0, limit)
    } catch {
      return []
    }
  }

  // -------------------------------------------------------------------------
  // Internal — trajectory storage
  // -------------------------------------------------------------------------

  /**
   * Store the full node scores as a trajectory record for future baseline
   * calculations. Only called for runs with overallScore > 0.7.
   */
  private async storeTrajectory(run: RunAnalysis): Promise<void> {
    const ns = [...this.namespace, 'trajectories']
    const steps: Record<string, unknown>[] = []
    for (const [nodeId, score] of run.nodeScores) {
      steps.push({
        nodeId,
        runId: run.runId,
        qualityScore: score,
        timestamp: new Date().toISOString(),
      })
    }
    await this.store.put(ns, run.runId, {
      runId: run.runId,
      steps,
      overallScore: run.overallScore,
      taskType: run.taskType,
      riskClass: run.riskClass,
      approved: run.approved,
      timestamp: new Date().toISOString(),
      text: `trajectory ${run.runId} ${run.taskType} score=${run.overallScore}`,
    })
  }

  // -------------------------------------------------------------------------
  // Internal — error lesson extraction
  // -------------------------------------------------------------------------

  /**
   * For each resolved error, create an error_resolution lesson.
   * Returns the count of lessons created.
   */
  private async extractErrorLessons(run: RunAnalysis): Promise<number> {
    const ns = [...this.namespace, 'lessons']
    let count = 0

    for (const err of run.errors) {
      if (!err.resolved || !err.resolution) continue

      const key = `lesson_err_${run.runId}_${err.nodeId}_${count}`
      await this.store.put(ns, key, {
        type: 'error_resolution',
        runId: run.runId,
        nodeId: err.nodeId,
        taskType: run.taskType,
        riskClass: run.riskClass,
        error: err.error,
        resolution: err.resolution,
        fixAttempt: err.fixAttempt ?? 1,
        timestamp: new Date().toISOString(),
        text: `error_resolution node=${err.nodeId} error="${err.error}" resolution="${err.resolution}"`,
      })
      count++
    }

    return count
  }

  // -------------------------------------------------------------------------
  // Internal — success pattern extraction
  // -------------------------------------------------------------------------

  /**
   * For high-quality runs (overallScore > 0.85), extract success patterns
   * from nodes that scored exceptionally well (>= 0.9).
   */
  private async extractSuccessPatterns(run: RunAnalysis): Promise<number> {
    const ns = [...this.namespace, 'lessons']
    let count = 0

    for (const [nodeId, score] of run.nodeScores) {
      if (score < HIGH_NODE_SCORE_THRESHOLD) continue

      const key = `lesson_success_${run.runId}_${nodeId}`
      await this.store.put(ns, key, {
        type: 'successful_pattern',
        runId: run.runId,
        nodeId,
        taskType: run.taskType,
        riskClass: run.riskClass,
        score,
        approved: run.approved,
        timestamp: new Date().toISOString(),
        text: `successful_pattern node=${nodeId} taskType=${run.taskType} score=${score}`,
      })
      count++
    }

    return count
  }

  // -------------------------------------------------------------------------
  // Internal — rule generation from errors
  // -------------------------------------------------------------------------

  /**
   * For each resolved error, create a rule that can be used to prevent
   * or quickly recover from similar errors in the future.
   */
  private async generateRulesFromErrors(run: RunAnalysis): Promise<number> {
    const ns = [...this.namespace, 'rules']
    let count = 0

    for (const err of run.errors) {
      if (!err.resolved || !err.resolution) continue

      const key = `rule_${run.runId}_${err.nodeId}_${count}`
      await this.store.put(ns, key, {
        type: 'error_prevention',
        runId: run.runId,
        nodeId: err.nodeId,
        taskType: run.taskType,
        riskClass: run.riskClass,
        errorPattern: err.error,
        resolution: err.resolution,
        fixAttempt: err.fixAttempt ?? 1,
        timestamp: new Date().toISOString(),
        text: `rule node=${err.nodeId} when="${err.error}" then="${err.resolution}"`,
      })
      count++
    }

    return count
  }

  // -------------------------------------------------------------------------
  // Internal — suboptimal node detection
  // -------------------------------------------------------------------------

  /**
   * Compare each node's score against the simple average from stored
   * trajectories for the same task type. A node is suboptimal if its
   * score is more than 15% below the baseline average.
   */
  private async detectSuboptimalNodes(run: RunAnalysis): Promise<string[]> {
    const baselines = await this.loadBaselines(run.taskType)
    const suboptimal: string[] = []

    for (const [nodeId, score] of run.nodeScores) {
      const baseline = baselines.get(nodeId)
      if (baseline === undefined || baseline.count < 3) continue

      const threshold = baseline.average * 0.85
      if (score < threshold) {
        suboptimal.push(nodeId)
      }
    }

    return suboptimal
  }

  /**
   * Load baseline averages per node from stored trajectories.
   */
  private async loadBaselines(
    taskType: string,
  ): Promise<Map<string, { average: number; count: number }>> {
    const result = new Map<string, { average: number; count: number }>()

    try {
      const ns = [...this.namespace, 'trajectories']
      const items = await this.store.search(ns, { limit: 1000 })

      // Accumulate scores per node
      const nodeScores = new Map<string, number[]>()

      for (const item of items) {
        const value = item.value as Record<string, unknown>
        if (value['taskType'] !== taskType) continue

        const steps = Array.isArray(value['steps']) ? value['steps'] as Record<string, unknown>[] : []
        for (const step of steps) {
          const nodeId = step['nodeId'] as string
          const score = step['qualityScore'] as number
          if (typeof nodeId !== 'string' || typeof score !== 'number') continue

          const existing = nodeScores.get(nodeId) ?? []
          existing.push(score)
          nodeScores.set(nodeId, existing)
        }
      }

      for (const [nodeId, scores] of nodeScores) {
        const sum = scores.reduce((a, b) => a + b, 0)
        result.set(nodeId, {
          average: sum / scores.length,
          count: scores.length,
        })
      }
    } catch {
      // best-effort
    }

    return result
  }

  // -------------------------------------------------------------------------
  // Internal — analysis persistence
  // -------------------------------------------------------------------------

  private async storeAnalysis(runId: string, result: AnalysisResult): Promise<void> {
    const ns = [...this.namespace, 'history']
    await this.store.put(ns, runId, analysisResultToRecord(runId, result))
  }

  // -------------------------------------------------------------------------
  // Internal — summary builder
  // -------------------------------------------------------------------------

  private buildSummary(run: RunAnalysis, result: AnalysisResult): string {
    const lines: string[] = []
    lines.push(`## Post-Run Analysis: ${run.runId}`)
    lines.push('')
    lines.push(`- **Task type:** ${run.taskType}`)
    lines.push(`- **Risk class:** ${run.riskClass}`)
    lines.push(`- **Overall score:** ${run.overallScore.toFixed(2)}`)
    lines.push(`- **Approved:** ${run.approved ? 'yes' : 'no'}`)
    lines.push(`- **Cost:** ${run.totalCostCents}c | **Duration:** ${run.totalDurationMs}ms`)
    lines.push('')

    if (result.trajectoryStored) {
      lines.push(`- Trajectory stored (score > ${TRAJECTORY_THRESHOLD})`)
    } else {
      lines.push(`- Trajectory NOT stored (score <= ${TRAJECTORY_THRESHOLD})`)
    }

    lines.push(`- Lessons created: ${result.lessonsCreated}`)
    lines.push(`- Rules created: ${result.rulesCreated}`)

    if (result.suboptimalNodes.length > 0) {
      lines.push(`- Suboptimal nodes: ${result.suboptimalNodes.join(', ')}`)
    }

    if (run.errors.length > 0) {
      lines.push('')
      lines.push(`### Errors (${run.errors.length})`)
      for (const err of run.errors) {
        const status = err.resolved ? 'RESOLVED' : 'UNRESOLVED'
        lines.push(`- [${status}] ${err.nodeId}: ${err.error}`)
      }
    }

    if (run.feedback) {
      lines.push('')
      lines.push(`### User Feedback`)
      lines.push(run.feedback)
    }

    return lines.join('\n')
  }
}
