/**
 * EvalOrchestrator implementation — queue / lease / retry orchestration for
 * eval runs.
 *
 * Moved from @dzupagent/server (packages/server/src/services/eval-orchestrator.ts)
 * to @dzupagent/evals in MC-A02 to eliminate the server -> evals layer
 * inversion. Server consumes it via dependency injection through the
 * EvalOrchestratorLike contract in @dzupagent/eval-contracts.
 *
 * Decomposed in MC-026a: this file owns the in-memory queue, drain loop,
 * and lifecycle wiring while lease management, queue metrics, run
 * execution, store transitions, cost-cap enforcement, and recovery live in
 * dedicated modules.
 */

import type { MetricsCollector } from '@dzupagent/core/utils'
import type {
  EvalExecutionTarget,
  EvalOrchestratorLike,
  EvalQueueStats,
  EvalRunListFilter,
  EvalRunRecord,
  EvalRunStore,
  EvalSuite,
} from '@dzupagent/eval-contracts'
import {
  EvalExecutionUnavailableError,
  EvalRunInvalidStateError,
} from './eval-orchestrator-errors.js'
import { LeaseManager } from './eval-orchestrator-lease.js'
import { QueueMetricsTracker } from './eval-orchestrator-metrics.js'
import { RunExecutor } from './eval-orchestrator-runner.js'
import { buildRecoveryPatch, sortStaleRuns } from './eval-orchestrator-recovery.js'
import {
  isTerminalStatus,
  persistCancellation,
  persistQueuedRun,
  persistRetry,
} from './eval-orchestrator-transitions.js'

export interface EvalOrchestratorConfig {
  store: EvalRunStore
  executeTarget?: EvalExecutionTarget
  allowReadOnlyMode?: boolean
  concurrency?: number
  metrics?: MetricsCollector
  costCapCents?: number
  getAccumulatedCostCents?: () => number | Promise<number>
}

export class EvalOrchestrator implements EvalOrchestratorLike {
  private readonly pendingRunIds: string[] = []
  private readonly pendingRunSet = new Set<string>()
  private readonly activeRunControllers = new Map<string, AbortController>()
  private readonly concurrency: number
  private readonly lease: LeaseManager
  private readonly queueMetrics: QueueMetricsTracker
  private readonly runner: RunExecutor
  private readonly startupPromise: Promise<void>
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private draining = false

  constructor(private readonly config: EvalOrchestratorConfig) {
    if (!config.executeTarget && config.allowReadOnlyMode !== true) {
      throw new EvalExecutionUnavailableError(
        'Eval execution target is required unless allowReadOnlyMode is explicitly enabled',
      )
    }

    this.concurrency = Math.max(1, Math.floor(config.concurrency ?? 1))
    this.lease = new LeaseManager({ store: config.store })
    this.queueMetrics = new QueueMetricsTracker({
      ...(config.metrics ? { metrics: config.metrics } : {}),
      store: config.store,
      pendingRunIds: this.pendingRunIds,
      pendingRunSet: this.pendingRunSet,
      activeRunControllers: this.activeRunControllers,
    })
    this.runner = new RunExecutor({
      store: config.store,
      ownerId: this.lease.instanceId,
      queueMetrics: this.queueMetrics,
      costCap: config,
      getExecuteTarget: () => this.config.executeTarget,
    })
    this.startupPromise = this.reconcilePersistedRuns()
  }

  canExecute(): boolean {
    return typeof this.config.executeTarget === 'function'
  }

  async queueRun(input: {
    suite: EvalSuite
    metadata?: Record<string, unknown>
  }): Promise<EvalRunRecord> {
    await this.ensureReady()
    if (!this.config.executeTarget) {
      throw new EvalExecutionUnavailableError('Eval execution target is not configured')
    }

    const created = await persistQueuedRun(this.config.store, input)
    this.enqueueRun(created.id)
    await this.queueMetrics.track('enqueued', 'forge_eval_queue_enqueued_total')
    return created
  }

  async cancelRun(runId: string): Promise<EvalRunRecord> {
    await this.ensureReady()
    const run = await this.requireRun(runId)
    if (isTerminalStatus(run.status)) {
      throw new EvalRunInvalidStateError(`Cannot cancel eval run in ${run.status} state`)
    }

    this.removePendingRun(runId)
    this.activeRunControllers.get(runId)?.abort()

    const cancelled = await persistCancellation(this.config.store, run)
    await this.queueMetrics.track('cancelled', 'forge_eval_queue_cancelled_total')
    return cancelled
  }

  async retryRun(runId: string): Promise<EvalRunRecord> {
    await this.ensureReady()
    if (!this.config.executeTarget) {
      throw new EvalExecutionUnavailableError('Eval execution target is not configured')
    }

    const run = await this.requireRun(runId)
    if (run.status !== 'failed') {
      throw new EvalRunInvalidStateError(`Cannot retry eval run in ${run.status} state`)
    }

    const retried = await persistRetry(this.config.store, run)
    this.enqueueRun(runId)
    await this.queueMetrics.track('retried', 'forge_eval_queue_retried_total')
    await this.queueMetrics.track('requeued', 'forge_eval_queue_requeued_total')
    return retried
  }

  async getRun(runId: string): Promise<EvalRunRecord | null> {
    await this.ensureReady()
    return this.config.store.getRun(runId)
  }

  async listRuns(filter?: EvalRunListFilter): Promise<EvalRunRecord[]> {
    await this.ensureReady()
    return this.config.store.listRuns(filter)
  }

  async getQueueStats(): Promise<EvalQueueStats> {
    await this.ensureReady()
    return this.queueMetrics.buildQueueStats()
  }

  private async ensureReady(): Promise<void> {
    await this.startupPromise
  }

  private async reconcilePersistedRuns(): Promise<void> {
    const staleRuns = sortStaleRuns(await this.config.store.listAllRuns())

    for (const run of staleRuns) {
      if (run.status === 'running') {
        const currentLease = run.executionOwner
        if (currentLease && !this.lease.isExecutionLeaseExpired(currentLease)) continue

        const { patch } = buildRecoveryPatch(run)
        const updated = await this.config.store.updateRunIf(
          run.id,
          (current) => current.status === 'running'
            && (!current.executionOwner || this.lease.isExecutionLeaseExpired(current.executionOwner)),
          patch,
        )

        if (!updated) {
          const current = await this.config.store.getRun(run.id)
          if (current?.status === 'queued') this.enqueueRun(run.id)
          continue
        }

        await this.queueMetrics.track('recovered', 'forge_eval_queue_recovered_total')
        await this.queueMetrics.track('requeued', 'forge_eval_queue_requeued_total')
      }

      this.enqueueRun(run.id)
      await this.queueMetrics.refreshQueueMetrics()
    }
  }

  private enqueueRun(runId: string): void {
    if (this.pendingRunSet.has(runId) || this.activeRunControllers.has(runId)) return

    this.pendingRunSet.add(runId)
    this.pendingRunIds.push(runId)
    this.scheduleDrain()
  }

  private scheduleDrain(): void {
    if (this.drainTimer) return

    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      void this.drainQueue()
    }, 0)
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return

    this.draining = true
    try {
      while (this.activeRunControllers.size < this.concurrency) {
        const runId = this.pendingRunIds.shift()
        if (!runId) break

        this.pendingRunSet.delete(runId)
        const run = await this.config.store.getRun(runId)
        if (!run || run.status !== 'queued') continue

        this.startRun(runId)
      }
    } finally {
      this.draining = false
      if (this.pendingRunIds.length > 0 && this.activeRunControllers.size < this.concurrency) {
        this.scheduleDrain()
      }
    }
  }

  private startRun(runId: string): void {
    const abortController = new AbortController()
    this.activeRunControllers.set(runId, abortController)
    void this.beginRun(runId, abortController)
  }

  private async beginRun(runId: string, abortController: AbortController): Promise<void> {
    try {
      const claimedRun = await this.lease.claimRunForExecution(runId)
      if (!claimedRun) return

      this.lease.startLeaseRefresh(runId, abortController)
      await this.runner.execute(claimedRun, abortController)
    } finally {
      this.lease.stopLeaseRefresh(runId)
      this.activeRunControllers.delete(runId)
      this.scheduleDrain()
      void this.queueMetrics.refreshQueueMetrics()
    }
  }

  private async requireRun(runId: string): Promise<EvalRunRecord> {
    const run = await this.config.store.getRun(runId)
    if (!run) throw new Error(`Eval run "${runId}" not found`)
    return run
  }

  private removePendingRun(runId: string): boolean {
    if (!this.pendingRunSet.has(runId)) return false

    this.pendingRunSet.delete(runId)
    const index = this.pendingRunIds.findIndex((pendingRunId) => pendingRunId === runId)
    if (index >= 0) this.pendingRunIds.splice(index, 1)
    return true
  }
}
