/**
 * RunManager -- Lifecycle tracking for adapter runs.
 *
 * Creates, tracks, and reports on individual agent execution runs.
 * Optionally emits events to a DzupEventBus and provides an
 * async-generator wrapper (`trackRun`) that automatically updates
 * run state from adapter events.
 */

import crypto from 'node:crypto'

import type { DzupEventBus, RunStatus } from '@dzupagent/core'

import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentFailedEvent,
  AgentInput,
  AgentStartedEvent,
  TaskDescriptor,
  TokenUsage,
} from '../types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { RunStatus }

export interface AdapterRun {
  runId: string
  workflowId?: string | undefined
  providerId?: AdapterProviderId | undefined
  status: RunStatus
  input: AgentInput
  task?: TaskDescriptor | undefined
  result?: string | undefined
  error?: string | undefined
  createdAt: Date
  startedAt?: Date | undefined
  completedAt?: Date | undefined
  durationMs?: number | undefined
  usage?: TokenUsage | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface RunStats {
  totalRuns: number
  byStatus: Partial<Record<RunStatus, number>>
  avgDurationMs: number
  successRate: number
  byProvider: Record<string, { runs: number; avgDurationMs: number; successRate: number }>
}

export interface RunManagerConfig {
  eventBus?: DzupEventBus | undefined
  /** Max completed runs to keep in memory. Default 1000 */
  maxCompletedRuns?: number | undefined
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_COMPLETED_RUNS = 1000

// ---------------------------------------------------------------------------
// RunManager
// ---------------------------------------------------------------------------

export class RunManager {
  private readonly runs = new Map<string, AdapterRun>()
  private readonly eventBus: DzupEventBus | undefined
  private readonly maxCompletedRuns: number

  constructor(config?: RunManagerConfig) {
    this.eventBus = config?.eventBus
    this.maxCompletedRuns = config?.maxCompletedRuns ?? DEFAULT_MAX_COMPLETED_RUNS
  }

  // -----------------------------------------------------------------------
  // Run lifecycle
  // -----------------------------------------------------------------------

  /** Create a new run in 'pending' status. */
  createRun(input: AgentInput, task?: TaskDescriptor): AdapterRun {
    const run: AdapterRun = {
      runId: crypto.randomUUID(),
      status: 'pending',
      input,
      task,
      createdAt: new Date(),
    }

    this.runs.set(run.runId, run)
    this.emitRunEvent(run)
    return run
  }

  /** Transition a run to 'executing'. */
  startRun(runId: string, providerId: AdapterProviderId): void {
    const run = this.requireRun(runId)
    run.status = 'executing'
    run.providerId = providerId
    run.startedAt = new Date()
    this.emitRunEvent(run)
  }

  /** Transition a run to 'completed'. */
  completeRun(runId: string, result: string, usage?: TokenUsage): void {
    const run = this.requireRun(runId)
    const now = new Date()

    run.status = 'completed'
    run.result = result
    run.completedAt = now
    run.usage = usage

    if (run.startedAt) {
      run.durationMs = now.getTime() - run.startedAt.getTime()
    }

    this.emitRunEvent(run)
  }

  /** Transition a run to 'failed'. */
  failRun(runId: string, error: string): void {
    const run = this.requireRun(runId)
    const now = new Date()

    run.status = 'failed'
    run.error = error
    run.completedAt = now

    if (run.startedAt) {
      run.durationMs = now.getTime() - run.startedAt.getTime()
    }

    this.emitRunEvent(run)
  }

  /** Transition a run to 'cancelled'. */
  cancelRun(runId: string): void {
    const run = this.requireRun(runId)
    const now = new Date()

    run.status = 'cancelled'
    run.completedAt = now

    if (run.startedAt) {
      run.durationMs = now.getTime() - run.startedAt.getTime()
    }

    this.emitRunEvent(run)
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /** Get a run by ID. */
  getRun(runId: string): AdapterRun | undefined {
    return this.runs.get(runId)
  }

  /** List runs, optionally filtered by status. */
  listRuns(status?: RunStatus): AdapterRun[] {
    const results: AdapterRun[] = []
    for (const run of this.runs.values()) {
      if (status === undefined || run.status === status) {
        results.push(run)
      }
    }
    return results
  }

  /** Compute aggregate statistics across all tracked runs. */
  getStats(): RunStats {
    const byStatus: Partial<Record<RunStatus, number>> = {}

    const providerMap = new Map<
      string,
      { runs: number; totalDuration: number; successes: number }
    >()

    let totalDuration = 0
    let runsWithDuration = 0
    let totalRuns = 0
    let completedCount = 0
    let terminalCount = 0

    for (const run of this.runs.values()) {
      totalRuns++
      byStatus[run.status] = (byStatus[run.status] ?? 0) + 1

      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
        terminalCount++
      }

      if (run.status === 'completed') {
        completedCount++
      }

      if (run.durationMs !== undefined) {
        totalDuration += run.durationMs
        runsWithDuration++
      }

      if (run.providerId) {
        let entry = providerMap.get(run.providerId)
        if (!entry) {
          entry = { runs: 0, totalDuration: 0, successes: 0 }
          providerMap.set(run.providerId, entry)
        }
        entry.runs++
        if (run.durationMs !== undefined) {
          entry.totalDuration += run.durationMs
        }
        if (run.status === 'completed') {
          entry.successes++
        }
      }
    }

    const byProvider: Record<string, { runs: number; avgDurationMs: number; successRate: number }> =
      {}
    for (const [providerId, entry] of providerMap) {
      byProvider[providerId] = {
        runs: entry.runs,
        avgDurationMs: entry.runs > 0 ? entry.totalDuration / entry.runs : 0,
        successRate: entry.runs > 0 ? entry.successes / entry.runs : 0,
      }
    }

    return {
      totalRuns,
      byStatus,
      avgDurationMs: runsWithDuration > 0 ? totalDuration / runsWithDuration : 0,
      successRate: terminalCount > 0 ? completedCount / terminalCount : 0,
      byProvider,
    }
  }

  // -----------------------------------------------------------------------
  // Maintenance
  // -----------------------------------------------------------------------

  /**
   * Prune old completed/failed/cancelled runs that exceed `maxCompletedRuns`.
   * Removes the oldest terminal runs first.
   * Returns the number of runs pruned.
   */
  prune(): number {
    const terminalRuns: AdapterRun[] = []
    for (const run of this.runs.values()) {
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
        terminalRuns.push(run)
      }
    }

    if (terminalRuns.length <= this.maxCompletedRuns) {
      return 0
    }

    // Sort oldest first by completedAt (or createdAt as fallback)
    terminalRuns.sort((a, b) => {
      const aTime = (a.completedAt ?? a.createdAt).getTime()
      const bTime = (b.completedAt ?? b.createdAt).getTime()
      return aTime - bTime
    })

    const toRemove = terminalRuns.length - this.maxCompletedRuns
    let removed = 0

    for (let i = 0; i < toRemove; i++) {
      const run = terminalRuns[i]
      if (run) {
        this.runs.delete(run.runId)
        removed++
      }
    }

    return removed
  }

  // -----------------------------------------------------------------------
  // Async generator wrapper
  // -----------------------------------------------------------------------

  /**
   * Wrap an async generator of AgentEvents with automatic run tracking.
   *
   * - On `adapter:started`: marks the run as executing
   * - On `adapter:completed`: marks the run as completed
   * - On `adapter:failed`: marks the run as failed
   * - All events are yielded unchanged
   */
  async *trackRun(
    runId: string,
    source: AsyncGenerator<AgentEvent>,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    try {
      for await (const event of source) {
        switch (event.type) {
          case 'adapter:started': {
            const started = event as AgentStartedEvent
            this.startRun(runId, started.providerId)
            break
          }
          case 'adapter:completed': {
            const completed = event as AgentCompletedEvent
            this.completeRun(runId, completed.result, completed.usage)
            break
          }
          case 'adapter:failed': {
            const failed = event as AgentFailedEvent
            this.failRun(runId, failed.error)
            break
          }
        }

        yield event
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.failRun(runId, message)
      throw err
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private requireRun(runId: string): AdapterRun {
    const run = this.runs.get(runId)
    if (!run) {
      throw new Error(`Run "${runId}" not found.`)
    }
    return run
  }

  /**
   * Emit a run lifecycle event on the event bus (if configured).
   * Uses the same cast pattern as WorkflowCheckpointer for forward-compatible event types.
   */
  private emitRunEvent(run: AdapterRun): void {
    if (!this.eventBus) return

    const event = {
      type: `adapter:run_${run.status}` as const,
      runId: run.runId,
      providerId: run.providerId,
      status: run.status,
    }

    this.eventBus.emit(event as unknown as Parameters<DzupEventBus['emit']>[0])
  }
}
