/**
 * Execution-lease management for EvalOrchestrator.
 *
 * Encapsulates the per-instance owner identity, lease duration / refresh
 * cadence, and the timer registry that keeps a claimed eval run's lease
 * alive. Extracted from eval-orchestrator-impl.ts in MC-026a so the
 * orchestrator class focuses on queue coordination.
 */

import { randomUUID } from 'node:crypto'
import type {
  EvalRunExecutionOwnershipRecord,
  EvalRunRecord,
  EvalRunStore,
} from '@dzupagent/eval-contracts'
import { getCurrentAttemptNumber, updateAttemptHistory } from './eval-orchestrator-attempts.js'

export interface LeaseManagerConfig {
  store: EvalRunStore
  leaseDurationMs?: number
  leaseRefreshIntervalMs?: number
}

const DEFAULT_LEASE_DURATION_MS = 30_000
const DEFAULT_LEASE_REFRESH_INTERVAL_MS = 10_000

export class LeaseManager {
  readonly instanceId: string = randomUUID()
  private readonly store: EvalRunStore
  private readonly leaseDurationMs: number
  private readonly leaseRefreshIntervalMs: number
  private readonly activeLeaseRefreshTimers = new Map<string, ReturnType<typeof setInterval>>()

  constructor(config: LeaseManagerConfig) {
    this.store = config.store
    this.leaseDurationMs = config.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS
    this.leaseRefreshIntervalMs = config.leaseRefreshIntervalMs ?? DEFAULT_LEASE_REFRESH_INTERVAL_MS
  }

  isExecutionLeaseExpired(owner: EvalRunExecutionOwnershipRecord, nowMs = Date.now()): boolean {
    const leaseExpiresAtMs = Date.parse(owner.leaseExpiresAt)
    return !Number.isFinite(leaseExpiresAtMs) || leaseExpiresAtMs <= nowMs
  }

  createLeaseExpiry(startedAt = new Date().toISOString()): string {
    return new Date(Date.parse(startedAt) + this.leaseDurationMs).toISOString()
  }

  createExecutionOwner(claimedAt: string, leaseExpiresAt: string): EvalRunExecutionOwnershipRecord {
    return {
      ownerId: this.instanceId,
      claimedAt,
      leaseExpiresAt,
    }
  }

  async claimRunForExecution(runId: string): Promise<EvalRunRecord | null> {
    const queuedRun = await this.store.getRun(runId)
    if (!queuedRun || queuedRun.status !== 'queued') {
      return null
    }

    if (queuedRun.executionOwner && !this.isExecutionLeaseExpired(queuedRun.executionOwner)) {
      return null
    }

    const startedAt = new Date().toISOString()
    const leaseExpiresAt = this.createLeaseExpiry(startedAt)
    const attempt = getCurrentAttemptNumber(queuedRun)

    const claimed = await this.store.updateRunIf(runId, (current) => {
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

    return this.store.getRun(runId)
  }

  startLeaseRefresh(runId: string, abortController: AbortController): void {
    if (this.activeLeaseRefreshTimers.has(runId)) {
      return
    }

    const timer = setInterval(() => {
      void this.refreshExecutionLease(runId, abortController)
    }, this.leaseRefreshIntervalMs)

    this.activeLeaseRefreshTimers.set(runId, timer)
  }

  stopLeaseRefresh(runId: string): void {
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

    const run = await this.store.getRun(runId)
    if (!run || run.status !== 'running' || run.executionOwner?.ownerId !== this.instanceId) {
      abortController.abort()
      this.stopLeaseRefresh(runId)
      return
    }

    const claimedAt = run.executionOwner.claimedAt
    const leaseExpiresAt = this.createLeaseExpiry()
    const refreshed = await this.store.updateRunIf(runId, (current) => {
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
}
