/**
 * EvalOrchestrator — queue / lease / retry orchestration for eval runs.
 *
 * Moved from @dzupagent/server (packages/server/src/services/eval-orchestrator.ts)
 * to @dzupagent/evals in MC-A02 to eliminate the server -> evals layer
 * inversion. Server consumes it via dependency injection through the
 * EvalOrchestratorLike contract in @dzupagent/eval-contracts.
 */

import { randomUUID } from 'node:crypto'
import type { MetricsCollector } from '@dzupagent/core'
import type {
  EvalExecutionContext,
  EvalExecutionTarget,
  EvalOrchestratorLike,
  EvalQueueStats,
  EvalRunAttemptRecord,
  EvalRunErrorRecord,
  EvalRunExecutionOwnershipRecord,
  EvalRunListFilter,
  EvalRunRecord,
  EvalRunRecoveryRecord,
  EvalRunStore,
  EvalSuite,
} from '@dzupagent/eval-contracts'
import { runEvalSuite } from '../eval-runner.js'

export type {
  EvalExecutionContext,
  EvalExecutionTarget,
  EvalQueueStats,
} from '@dzupagent/eval-contracts'

export interface EvalOrchestratorConfig {
  store: EvalRunStore
  executeTarget?: EvalExecutionTarget
  allowReadOnlyMode?: boolean
  concurrency?: number
  metrics?: MetricsCollector
}

export class EvalExecutionUnavailableError extends Error {
  readonly code = 'EVAL_EXECUTION_UNAVAILABLE'

  constructor(message: string) {
    super(message)
    this.name = 'EvalExecutionUnavailableError'
  }
}

export class EvalRunInvalidStateError extends Error {
  readonly code = 'INVALID_STATE'

  constructor(message: string) {
    super(message)
    this.name = 'EvalRunInvalidStateError'
  }
}

export class EvalOrchestrator implements EvalOrchestratorLike {
  private readonly pendingRunIds: string[] = []
  private readonly pendingRunSet = new Set<string>()
  private readonly activeRunControllers = new Map<string, AbortController>()
  private readonly activeLeaseRefreshTimers = new Map<string, ReturnType<typeof setInterval>>()
  private readonly concurrency: number
  private readonly metrics: MetricsCollector | undefined
  private readonly instanceId = randomUUID()
  private readonly leaseDurationMs = 30_000
  private readonly leaseRefreshIntervalMs = 10_000
  private readonly queueCounters = {
    enqueued: 0,
    started: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    retried: 0,
    recovered: 0,
    requeued: 0,
  }
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
    this.metrics = config.metrics
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

    const runId = randomUUID()
    const timestamp = new Date().toISOString()
    const run: EvalRunRecord = {
      id: runId,
      suiteId: input.suite.name,
      suite: input.suite,
      status: 'queued',
      createdAt: timestamp,
      queuedAt: timestamp,
      attempts: 1,
      attemptHistory: [
        createAttemptRecord({
          attempt: 1,
          status: 'queued',
          queuedAt: timestamp,
        }),
      ],
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }

    await this.config.store.saveRun(run)
    this.enqueueRun(runId)
    this.queueCounters.enqueued += 1
    this.recordQueueEvent('forge_eval_queue_enqueued_total')
    await this.refreshQueueMetrics()

    const createdRun = await this.config.store.getRun(runId)
    if (!createdRun) {
      throw new Error(`Eval run "${runId}" missing after enqueue`)
    }

    return createdRun
  }

  async cancelRun(runId: string): Promise<EvalRunRecord> {
    await this.ensureReady()
    const run = await this.requireRun(runId)
    if (this.isTerminal(run.status)) {
      throw new EvalRunInvalidStateError(`Cannot cancel eval run in ${run.status} state`)
    }

    const attempt = getCurrentAttemptNumber(run)
    this.removePendingRun(runId)
    this.activeRunControllers.get(runId)?.abort()

    const completedAt = new Date().toISOString()
    const updated = await this.config.store.updateRunIf(
      runId,
      (current) => !this.isTerminal(current.status),
      {
        status: 'cancelled',
        completedAt,
        executionOwner: undefined,
        attempts: Math.max(run.attempts, attempt),
        attemptHistory: updateAttemptHistory(run, attempt, {
          status: 'cancelled',
          completedAt,
        }),
      },
    )

    if (!updated) {
      const cancelledRun = await this.config.store.getRun(runId)
      if (!cancelledRun) {
        throw new Error(`Eval run "${runId}" missing after cancellation`)
      }
      throw new EvalRunInvalidStateError(`Cannot cancel eval run in ${cancelledRun.status} state`)
    }

    const cancelledRun = await this.config.store.getRun(runId)
    if (!cancelledRun) {
      throw new Error(`Eval run "${runId}" missing after cancellation`)
    }

    this.queueCounters.cancelled += 1
    this.recordQueueEvent('forge_eval_queue_cancelled_total')
    await this.refreshQueueMetrics()

    return cancelledRun
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

    const queuedAt = new Date().toISOString()
    const nextAttempt = getCurrentAttemptNumber(run) + 1
    const updated = await this.config.store.updateRunIf(runId, (current) => current.status === 'failed', {
      status: 'queued',
      queuedAt,
      startedAt: undefined,
      completedAt: undefined,
      result: undefined,
      error: undefined,
      executionOwner: undefined,
      attempts: nextAttempt,
      attemptHistory: appendAttemptHistory(run, createAttemptRecord({
        attempt: nextAttempt,
        status: 'queued',
        queuedAt,
      })),
    })

    if (!updated) {
      throw new EvalRunInvalidStateError(`Cannot retry eval run in ${run.status} state`)
    }

    this.enqueueRun(runId)
    this.queueCounters.retried += 1
    this.queueCounters.requeued += 1
    this.recordQueueEvent('forge_eval_queue_retried_total')
    this.recordQueueEvent('forge_eval_queue_requeued_total')
    await this.refreshQueueMetrics()

    const retriedRun = await this.config.store.getRun(runId)
    if (!retriedRun) {
      throw new Error(`Eval run "${runId}" missing after retry`)
    }

    return retriedRun
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
    return this.buildQueueStats()
  }

  private async ensureReady(): Promise<void> {
    await this.startupPromise
  }

  private async reconcilePersistedRuns(): Promise<void> {
    const runs = await this.config.store.listAllRuns()
    const staleRuns = runs
      .filter((run) => run.status === 'queued' || run.status === 'running')
      .sort((a, b) => {
        const queuedOrder = a.queuedAt.localeCompare(b.queuedAt)
        if (queuedOrder !== 0) return queuedOrder

        const createdOrder = a.createdAt.localeCompare(b.createdAt)
        if (createdOrder !== 0) return createdOrder

        return a.id.localeCompare(b.id)
      })

    for (const run of staleRuns) {
      if (run.status === 'running') {
        const currentLease = run.executionOwner
        if (currentLease && !this.isExecutionLeaseExpired(currentLease)) {
          continue
        }

        const recovery: EvalRunRecoveryRecord = {
          previousStatus: 'running',
          previousStartedAt: run.startedAt,
          recoveredAt: new Date().toISOString(),
          reason: 'process-restart',
        }
        const recoveredAt = recovery.recoveredAt
        const currentAttempt = getCurrentAttemptNumber(run)
        const nextAttempt = currentAttempt + 1
        const interruptedAttemptHistory = updateAttemptHistory(run, currentAttempt, {
          status: 'cancelled',
          completedAt: recoveredAt,
          recovery,
        })

        const updated = await this.config.store.updateRunIf(
          run.id,
          (current) => {
            return current.status === 'running'
              && (!current.executionOwner || this.isExecutionLeaseExpired(current.executionOwner))
          },
          {
            status: 'queued',
            attempts: nextAttempt,
            queuedAt: recoveredAt,
            startedAt: undefined,
            recovery,
            executionOwner: undefined,
            attemptHistory: appendAttemptHistory({
              ...run,
              attemptHistory: interruptedAttemptHistory,
            }, createAttemptRecord({
              attempt: nextAttempt,
              status: 'queued',
              queuedAt: recoveredAt,
              recovery,
            })),
            metadata: {
              ...(run.metadata ?? {}),
              recovery,
            },
          },
        )

        if (!updated) {
          const current = await this.config.store.getRun(run.id)
          if (current?.status === 'queued') {
            this.enqueueRun(run.id)
          }
          continue
        }

        this.queueCounters.recovered += 1
        this.queueCounters.requeued += 1
        this.recordQueueEvent('forge_eval_queue_recovered_total')
        this.recordQueueEvent('forge_eval_queue_requeued_total')
        await this.refreshQueueMetrics()
      }

      this.enqueueRun(run.id)
      await this.refreshQueueMetrics()
    }
  }

  private enqueueRun(runId: string): void {
    if (this.pendingRunSet.has(runId) || this.activeRunControllers.has(runId)) {
      return
    }

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
        if (!runId) {
          break
        }

        this.pendingRunSet.delete(runId)
        const run = await this.config.store.getRun(runId)
        if (!run || run.status !== 'queued') {
          continue
        }

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
      const claimedRun = await this.claimRunForExecution(runId)
      if (!claimedRun) {
        return
      }

      this.startLeaseRefresh(runId, abortController)
      await this.executeRun(claimedRun, abortController)
    } finally {
      this.stopLeaseRefresh(runId)
      this.activeRunControllers.delete(runId)
      this.scheduleDrain()
      void this.refreshQueueMetrics()
    }
  }

  private async executeRun(run: EvalRunRecord, abortController: AbortController): Promise<void> {
    if (abortController.signal.aborted) {
      return
    }

    if (run.status !== 'running') {
      return
    }

    const startedAt = run.startedAt ?? new Date().toISOString()
    const attempt = getCurrentAttemptNumber(run)

    this.queueCounters.started += 1
    this.recordQueueEvent('forge_eval_queue_started_total')
    this.recordQueueHistogram('forge_eval_queue_wait_ms', Date.parse(startedAt) - Date.parse(run.queuedAt))
    await this.refreshQueueMetrics()

    try {
      const result = await runEvalSuite(
        run.suite,
        async (input: string) => {
          if (abortController.signal.aborted) {
            throw createAbortError()
          }

          if (!this.config.executeTarget) {
            throw new EvalExecutionUnavailableError('Eval execution target is not configured')
          }

          const ctx: EvalExecutionContext = {
            suiteId: run.suiteId,
            runId: run.id,
            attempt,
            metadata: run.metadata,
            signal: abortController.signal,
          }
          return this.config.executeTarget(input, ctx)
        },
      )
      const completedAt = new Date().toISOString()
      const currentRun = await this.config.store.getRun(run.id)

      const completed = await this.config.store.updateRunIf(run.id, (current) => {
        return current.status === 'running'
          && current.executionOwner?.ownerId === this.instanceId
          && !abortController.signal.aborted
      }, {
        status: 'completed',
        result,
        completedAt,
        executionOwner: undefined,
        attempts: Math.max(run.attempts, attempt),
        attemptHistory: updateAttemptHistory(currentRun ?? run, attempt, {
          status: 'completed',
          completedAt,
          result,
        }),
      })
      if (!completed) {
        return
      }

      this.queueCounters.completed += 1
      this.recordQueueEvent('forge_eval_queue_completed_total')
      await this.refreshQueueMetrics()
    } catch (error) {
      const completedAt = new Date().toISOString()
      const failure = toEvalRunError(error)
      const currentRun = await this.config.store.getRun(run.id)
      const failed = await this.config.store.updateRunIf(run.id, (current) => {
        return current.status === 'running'
          && current.executionOwner?.ownerId === this.instanceId
          && !abortController.signal.aborted
      }, {
        status: 'failed',
        error: failure,
        completedAt,
        executionOwner: undefined,
        attempts: Math.max(run.attempts, attempt),
        attemptHistory: updateAttemptHistory(currentRun ?? run, attempt, {
          status: 'failed',
          completedAt,
          error: failure,
        }),
      })

      if (!failed) {
        return
      }

      this.queueCounters.failed += 1
      this.recordQueueEvent('forge_eval_queue_failed_total')
      await this.refreshQueueMetrics()
    }
  }

  private async claimRunForExecution(runId: string): Promise<EvalRunRecord | null> {
    const queuedRun = await this.config.store.getRun(runId)
    if (!queuedRun || queuedRun.status !== 'queued') {
      return null
    }

    if (queuedRun.executionOwner && !this.isExecutionLeaseExpired(queuedRun.executionOwner)) {
      return null
    }

    const startedAt = new Date().toISOString()
    const leaseExpiresAt = this.createLeaseExpiry(startedAt)
    const attempt = getCurrentAttemptNumber(queuedRun)

    const claimed = await this.config.store.updateRunIf(runId, (current) => {
      return current.status === 'queued'
        && (!current.executionOwner || this.isExecutionLeaseExpired(current.executionOwner))
    }, {
      status: 'running',
      startedAt,
      attempts: Math.max(queuedRun.attempts, attempt),
      executionOwner: this.createExecutionOwner(startedAt, leaseExpiresAt),
      attemptHistory: updateAttemptHistory(queuedRun, attempt, {
        status: 'running',
        startedAt,
      }),
    })

    if (!claimed) {
      return null
    }

    return this.config.store.getRun(runId)
  }

  private async requireRun(runId: string): Promise<EvalRunRecord> {
    const run = await this.config.store.getRun(runId)
    if (!run) {
      throw new Error(`Eval run "${runId}" not found`)
    }

    return run
  }

  private removePendingRun(runId: string): boolean {
    if (!this.pendingRunSet.has(runId)) {
      return false
    }

    this.pendingRunSet.delete(runId)
    const index = this.pendingRunIds.findIndex((pendingRunId) => pendingRunId === runId)
    if (index >= 0) {
      this.pendingRunIds.splice(index, 1)
    }
    return true
  }

  private async buildQueueStats(): Promise<EvalQueueStats> {
    let oldestPendingAgeMs: number | null = null
    const now = Date.now()

    for (const runId of this.pendingRunIds) {
      const run = await this.config.store.getRun(runId)
      if (!run || run.status !== 'queued') {
        continue
      }

      const queuedAtMs = Date.parse(run.queuedAt)
      if (!Number.isFinite(queuedAtMs)) {
        continue
      }

      oldestPendingAgeMs = Math.max(0, now - queuedAtMs)
      break
    }

    return {
      pending: this.pendingRunSet.size,
      active: this.activeRunControllers.size,
      oldestPendingAgeMs,
      ...this.queueCounters,
    }
  }

  private async refreshQueueMetrics(): Promise<void> {
    if (!this.metrics) return

    const stats = await this.buildQueueStats()
    this.metrics.gauge('forge_eval_queue_pending', stats.pending)
    this.metrics.gauge('forge_eval_queue_active', stats.active)
    this.metrics.gauge('forge_eval_queue_oldest_pending_age_ms', stats.oldestPendingAgeMs ?? 0)
  }

  private recordQueueEvent(metricName: string): void {
    this.metrics?.increment(metricName)
  }

  private recordQueueHistogram(metricName: string, value: number): void {
    if (!this.metrics) return
    if (!Number.isFinite(value) || value < 0) return
    this.metrics.observe(metricName, value)
  }

  private isTerminal(status: EvalRunRecord['status']): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled'
  }

  private startLeaseRefresh(runId: string, abortController: AbortController): void {
    if (this.activeLeaseRefreshTimers.has(runId)) {
      return
    }

    const timer = setInterval(() => {
      void this.refreshExecutionLease(runId, abortController)
    }, this.leaseRefreshIntervalMs)

    this.activeLeaseRefreshTimers.set(runId, timer)
  }

  private stopLeaseRefresh(runId: string): void {
    const timer = this.activeLeaseRefreshTimers.get(runId)
    if (timer) {
      clearInterval(timer)
      this.activeLeaseRefreshTimers.delete(runId)
    }
  }

  private async refreshExecutionLease(runId: string, abortController: AbortController): Promise<void> {
    if (abortController.signal.aborted) {
      return
    }

    const run = await this.config.store.getRun(runId)
    if (!run || run.status !== 'running' || run.executionOwner?.ownerId !== this.instanceId) {
      abortController.abort()
      this.stopLeaseRefresh(runId)
      return
    }

    const claimedAt = run.executionOwner.claimedAt
    const leaseExpiresAt = this.createLeaseExpiry()
    const refreshed = await this.config.store.updateRunIf(runId, (current) => {
      return current.status === 'running'
        && current.executionOwner?.ownerId === this.instanceId
    }, {
      executionOwner: this.createExecutionOwner(claimedAt, leaseExpiresAt),
    })

    if (!refreshed) {
      abortController.abort()
      this.stopLeaseRefresh(runId)
    }
  }

  private createExecutionOwner(claimedAt: string, leaseExpiresAt: string): EvalRunExecutionOwnershipRecord {
    return {
      ownerId: this.instanceId,
      claimedAt,
      leaseExpiresAt,
    }
  }

  private createLeaseExpiry(startedAt = new Date().toISOString()): string {
    return new Date(Date.parse(startedAt) + this.leaseDurationMs).toISOString()
  }

  private isExecutionLeaseExpired(owner: EvalRunExecutionOwnershipRecord, nowMs = Date.now()): boolean {
    const leaseExpiresAtMs = Date.parse(owner.leaseExpiresAt)
    return !Number.isFinite(leaseExpiresAtMs) || leaseExpiresAtMs <= nowMs
  }
}

function createAbortError(): Error {
  return new DOMException('Eval run cancelled', 'AbortError')
}

function toEvalRunError(error: unknown): EvalRunErrorRecord {
  if (error instanceof Error) {
    return {
      code: error.name || 'EVAL_RUN_FAILED',
      message: error.message,
    }
  }

  return {
    code: 'EVAL_RUN_FAILED',
    message: String(error),
  }
}

function cloneAttemptRecord(attempt: EvalRunAttemptRecord): EvalRunAttemptRecord {
  return {
    ...attempt,
    recovery: attempt.recovery ? { ...attempt.recovery } : undefined,
    error: attempt.error ? { ...attempt.error } : undefined,
  }
}

function createAttemptRecord(input: EvalRunAttemptRecord): EvalRunAttemptRecord {
  return cloneAttemptRecord(input)
}

function getAttemptHistory(run: EvalRunRecord): EvalRunAttemptRecord[] {
  if (run.attemptHistory && run.attemptHistory.length > 0) {
    return run.attemptHistory.map(cloneAttemptRecord)
  }

  const attempt = Math.max(1, run.attempts)
  return [createAttemptRecord({
    attempt,
    status: run.status,
    queuedAt: run.queuedAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.result ? { result: run.result } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.recovery ? { recovery: run.recovery } : {}),
  })]
}

function getCurrentAttemptNumber(run: EvalRunRecord): number {
  const history = getAttemptHistory(run)
  return history[history.length - 1]?.attempt ?? Math.max(1, run.attempts)
}

function updateAttemptHistory(
  run: EvalRunRecord,
  attemptNumber: number,
  patch: Partial<EvalRunAttemptRecord>,
): EvalRunAttemptRecord[] {
  const history = getAttemptHistory(run)
  const index = history.findIndex((attempt) => attempt.attempt === attemptNumber)
  const updatedAttempt = createAttemptRecord({
    attempt: attemptNumber,
    status: patch.status ?? history[index]?.status ?? run.status,
    queuedAt: patch.queuedAt ?? history[index]?.queuedAt ?? run.queuedAt,
    ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : history[index]?.startedAt !== undefined ? { startedAt: history[index]!.startedAt } : {}),
    ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : history[index]?.completedAt !== undefined ? { completedAt: history[index]!.completedAt } : {}),
    ...(patch.result !== undefined ? { result: patch.result } : history[index]?.result !== undefined ? { result: history[index]!.result } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : history[index]?.error !== undefined ? { error: history[index]!.error } : {}),
    ...(patch.recovery !== undefined ? { recovery: patch.recovery } : history[index]?.recovery !== undefined ? { recovery: history[index]!.recovery } : {}),
  })

  if (index >= 0) {
    history[index] = updatedAttempt
  } else {
    history.push(updatedAttempt)
  }

  return history.sort((a, b) => a.attempt - b.attempt)
}

function appendAttemptHistory(
  run: EvalRunRecord,
  attemptRecord: EvalRunAttemptRecord,
): EvalRunAttemptRecord[] {
  return [...getAttemptHistory(run), createAttemptRecord(attemptRecord)].sort((a, b) => a.attempt - b.attempt)
}
