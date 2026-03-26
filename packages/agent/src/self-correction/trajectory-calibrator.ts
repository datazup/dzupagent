/**
 * Trajectory Calibrator — step-level quality tracking across pipeline runs.
 *
 * Implements the STeCa concept (Step-Level Trajectory Calibration): records
 * quality scores at each pipeline step, compares against historical baselines,
 * and flags suboptimal performance for specific nodes.
 *
 * Usage:
 *   const calibrator = new TrajectoryCalibrator({ store })
 *   await calibrator.recordStep({ nodeId: 'gen_backend', runId, qualityScore: 0.9, ... })
 *   const result = await calibrator.detectSuboptimal('gen_backend', 0.6, 'feature_gen')
 *   if (result.isSuboptimal) console.warn(result.suggestion)
 *
 * @module self-correction/trajectory-calibrator
 */
import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single step-level quality measurement recorded during pipeline execution */
export interface StepReward {
  nodeId: string
  runId: string
  qualityScore: number
  durationMs: number
  tokenCost: number
  errorCount: number
  timestamp: Date
}

/** A complete trajectory recording for a full pipeline run */
export interface TrajectoryRecord {
  runId: string
  steps: StepReward[]
  overallScore: number
  taskType: string
  timestamp: Date
}

/** Result of comparing a step against historical baselines */
export interface SuboptimalResult {
  isSuboptimal: boolean
  baseline: number
  currentScore: number
  deviation: number
  suggestion?: string
}

/** Configuration for the TrajectoryCalibrator */
export interface TrajectoryCalibratorConfig {
  /** Store for persisting trajectory data */
  store: BaseStore
  /** Namespace prefix (default: ['trajectories']) */
  namespace?: string[]
  /** Min number of historical datapoints before comparing (default: 5) */
  minHistorySize?: number
  /** Threshold below baseline to flag as suboptimal (default: 0.85 = 15% below) */
  suboptimalThreshold?: number
  /** Max trajectories to keep per task type (default: 100) */
  maxTrajectories?: number
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function stepToRecord(step: StepReward): Record<string, unknown> {
  return {
    nodeId: step.nodeId,
    runId: step.runId,
    qualityScore: step.qualityScore,
    durationMs: step.durationMs,
    tokenCost: step.tokenCost,
    errorCount: step.errorCount,
    timestamp: step.timestamp.toISOString(),
    text: `step ${step.nodeId} run ${step.runId} score ${step.qualityScore}`,
  }
}

function recordToStep(value: Record<string, unknown>): StepReward | null {
  if (typeof value['nodeId'] !== 'string' || typeof value['runId'] !== 'string') {
    return null
  }
  return {
    nodeId: value['nodeId'] as string,
    runId: value['runId'] as string,
    qualityScore: typeof value['qualityScore'] === 'number' ? value['qualityScore'] : 0,
    durationMs: typeof value['durationMs'] === 'number' ? value['durationMs'] : 0,
    tokenCost: typeof value['tokenCost'] === 'number' ? value['tokenCost'] : 0,
    errorCount: typeof value['errorCount'] === 'number' ? value['errorCount'] : 0,
    timestamp: typeof value['timestamp'] === 'string'
      ? new Date(value['timestamp'])
      : new Date(),
  }
}

function trajectoryToRecord(trajectory: TrajectoryRecord): Record<string, unknown> {
  return {
    runId: trajectory.runId,
    steps: trajectory.steps.map(s => stepToRecord(s)),
    overallScore: trajectory.overallScore,
    taskType: trajectory.taskType,
    timestamp: trajectory.timestamp.toISOString(),
    text: `trajectory ${trajectory.runId} ${trajectory.taskType} score ${trajectory.overallScore}`,
  }
}

function recordToTrajectory(value: Record<string, unknown>): TrajectoryRecord | null {
  if (typeof value['runId'] !== 'string' || typeof value['taskType'] !== 'string') {
    return null
  }
  const rawSteps = Array.isArray(value['steps']) ? value['steps'] as Record<string, unknown>[] : []
  const steps: StepReward[] = []
  for (const raw of rawSteps) {
    const step = recordToStep(raw)
    if (step) steps.push(step)
  }
  return {
    runId: value['runId'] as string,
    steps,
    overallScore: typeof value['overallScore'] === 'number' ? value['overallScore'] : 0,
    taskType: value['taskType'] as string,
    timestamp: typeof value['timestamp'] === 'string'
      ? new Date(value['timestamp'])
      : new Date(),
  }
}

// ---------------------------------------------------------------------------
// TrajectoryCalibrator
// ---------------------------------------------------------------------------

export class TrajectoryCalibrator {
  private readonly store: BaseStore
  private readonly namespace: string[]
  private readonly minHistorySize: number
  private readonly suboptimalThreshold: number
  private readonly maxTrajectories: number

  constructor(config: TrajectoryCalibratorConfig) {
    this.store = config.store
    this.namespace = config.namespace ?? ['trajectories']
    this.minHistorySize = config.minHistorySize ?? 5
    this.suboptimalThreshold = config.suboptimalThreshold ?? 0.85
    this.maxTrajectories = config.maxTrajectories ?? 100
  }

  // ---------- Record step ---------------------------------------------------

  /**
   * Record a step-level quality measurement during pipeline execution.
   * Stored under namespace [...prefix, 'steps', nodeId] with a composite key.
   */
  async recordStep(step: StepReward): Promise<void> {
    const ns = [...this.namespace, 'steps', step.nodeId]
    const key = `${step.runId}:${step.nodeId}:${step.timestamp.getTime()}`
    await this.store.put(ns, key, stepToRecord(step))
  }

  // ---------- Detect suboptimal ---------------------------------------------

  /**
   * Compare a step's quality score against the historical baseline for
   * the given nodeId and taskType. Returns whether the score is suboptimal.
   *
   * If there are fewer than `minHistorySize` historical datapoints,
   * always returns `{ isSuboptimal: false }`.
   */
  async detectSuboptimal(
    nodeId: string,
    currentScore: number,
    taskType: string,
  ): Promise<SuboptimalResult> {
    const baseline = await this.getNodeBaseline(nodeId, taskType)

    if (baseline.count < this.minHistorySize) {
      return {
        isSuboptimal: false,
        baseline: baseline.average,
        currentScore,
        deviation: 0,
      }
    }

    const threshold = baseline.average * this.suboptimalThreshold
    const isSuboptimal = currentScore < threshold
    const deviation = baseline.average > 0
      ? Math.max(0, (baseline.average - currentScore) / baseline.average)
      : 0

    const result: SuboptimalResult = {
      isSuboptimal,
      baseline: baseline.average,
      currentScore,
      deviation,
    }

    if (isSuboptimal) {
      const pctBelow = Math.round(deviation * 100)
      result.suggestion =
        `Node "${nodeId}" scored ${currentScore.toFixed(2)} vs baseline ${baseline.average.toFixed(2)} (${pctBelow}% below average)`
    }

    return result
  }

  // ---------- Store trajectory -----------------------------------------------

  /**
   * Store a complete trajectory after a pipeline run finishes.
   * Prunes old trajectories for the same taskType if exceeding maxTrajectories.
   */
  async storeTrajectory(trajectory: TrajectoryRecord): Promise<void> {
    const ns = [...this.namespace, 'runs']
    await this.store.put(ns, trajectory.runId, trajectoryToRecord(trajectory))

    // Prune old trajectories for this task type
    await this.pruneTrajectories(trajectory.taskType)
  }

  // ---------- Get node baseline ----------------------------------------------

  /**
   * Get the historical average quality score for a specific node,
   * optionally filtered by taskType.
   */
  async getNodeBaseline(
    nodeId: string,
    taskType?: string,
  ): Promise<{ average: number; count: number }> {
    // Load step records for this node
    const stepNs = [...this.namespace, 'steps', nodeId]
    let steps: StepReward[]
    try {
      const items = await this.store.search(stepNs, { limit: 1000 })
      steps = []
      for (const item of items) {
        const step = recordToStep(item.value as Record<string, unknown>)
        if (step) steps.push(step)
      }
    } catch {
      return { average: 0, count: 0 }
    }

    // If taskType is provided, filter steps by checking trajectory records
    let filteredSteps = steps
    if (taskType) {
      const validRunIds = await this.getRunIdsForTaskType(taskType)
      if (validRunIds.size > 0) {
        filteredSteps = steps.filter(s => validRunIds.has(s.runId))
      }
    }

    if (filteredSteps.length === 0) {
      return { average: 0, count: 0 }
    }

    const sum = filteredSteps.reduce((acc, s) => acc + s.qualityScore, 0)
    return {
      average: sum / filteredSteps.length,
      count: filteredSteps.length,
    }
  }

  // ---------- Get all baselines ----------------------------------------------

  /**
   * Get all baselines for a task type: a map from nodeId to average score.
   */
  async getAllBaselines(
    taskType: string,
  ): Promise<Map<string, { average: number; count: number }>> {
    const result = new Map<string, { average: number; count: number }>()

    // Load all trajectories for this task type
    const trajectories = await this.loadTrajectories()
    const filtered = trajectories.filter(t => t.taskType === taskType)

    // Collect step scores per node
    const nodeScores = new Map<string, number[]>()
    for (const traj of filtered) {
      for (const step of traj.steps) {
        const existing = nodeScores.get(step.nodeId) ?? []
        existing.push(step.qualityScore)
        nodeScores.set(step.nodeId, existing)
      }
    }

    // Also check individual step records for nodes present in trajectories
    for (const [nodeId, scores] of nodeScores) {
      const sum = scores.reduce((a, b) => a + b, 0)
      result.set(nodeId, {
        average: sum / scores.length,
        count: scores.length,
      })
    }

    return result
  }

  // ---------- Clear ----------------------------------------------------------

  /**
   * Clear all trajectory data. Intended for testing.
   */
  async clear(): Promise<void> {
    // Clear runs
    try {
      const runNs = [...this.namespace, 'runs']
      const runs = await this.store.search(runNs, { limit: 1000 })
      for (const item of runs) {
        await this.store.delete(runNs, item.key)
      }
    } catch {
      // Best effort
    }

    // Clear steps — we need to enumerate all node namespaces
    // Since we cannot list namespaces, we load trajectories first to get node IDs
    try {
      const trajectories = await this.loadTrajectories()
      const nodeIds = new Set<string>()
      for (const traj of trajectories) {
        for (const step of traj.steps) {
          nodeIds.add(step.nodeId)
        }
      }
      for (const nodeId of nodeIds) {
        const stepNs = [...this.namespace, 'steps', nodeId]
        const items = await this.store.search(stepNs, { limit: 1000 })
        for (const item of items) {
          await this.store.delete(stepNs, item.key)
        }
      }
    } catch {
      // Best effort
    }
  }

  // ---------- Internal -------------------------------------------------------

  /**
   * Load all trajectory records from the store.
   */
  private async loadTrajectories(): Promise<TrajectoryRecord[]> {
    try {
      const ns = [...this.namespace, 'runs']
      const items = await this.store.search(ns, { limit: 1000 })
      const trajectories: TrajectoryRecord[] = []
      for (const item of items) {
        const traj = recordToTrajectory(item.value as Record<string, unknown>)
        if (traj) trajectories.push(traj)
      }
      return trajectories
    } catch {
      return []
    }
  }

  /**
   * Get run IDs belonging to a specific task type.
   */
  private async getRunIdsForTaskType(taskType: string): Promise<Set<string>> {
    const trajectories = await this.loadTrajectories()
    const ids = new Set<string>()
    for (const t of trajectories) {
      if (t.taskType === taskType) {
        ids.add(t.runId)
      }
    }
    return ids
  }

  /**
   * Prune old trajectories for a task type if exceeding maxTrajectories.
   */
  private async pruneTrajectories(taskType: string): Promise<void> {
    try {
      const trajectories = await this.loadTrajectories()
      const forType = trajectories
        .filter(t => t.taskType === taskType)
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

      if (forType.length <= this.maxTrajectories) return

      const toRemove = forType.slice(this.maxTrajectories)
      const ns = [...this.namespace, 'runs']
      for (const traj of toRemove) {
        await this.store.delete(ns, traj.runId)
      }
    } catch {
      // Best effort — pruning is non-critical
    }
  }
}
