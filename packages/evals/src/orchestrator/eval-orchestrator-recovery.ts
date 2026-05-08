/**
 * Recovery helpers for EvalOrchestrator startup reconciliation.
 *
 * Extracted from eval-orchestrator-impl.ts in MC-026a. Encapsulates the
 * pure logic for ordering stale runs and building the recovery payload
 * applied to a run that was claimed by a now-dead instance.
 */

import type {
  EvalRunRecord,
  EvalRunRecoveryRecord,
} from '@dzupagent/eval-contracts'
import {
  appendAttemptHistory,
  createAttemptRecord,
  getCurrentAttemptNumber,
  updateAttemptHistory,
} from './eval-orchestrator-attempts.js'

export function sortStaleRuns(runs: ReadonlyArray<EvalRunRecord>): EvalRunRecord[] {
  return runs
    .filter((run) => run.status === 'queued' || run.status === 'running')
    .sort((a, b) => {
      const queuedOrder = a.queuedAt.localeCompare(b.queuedAt)
      if (queuedOrder !== 0) return queuedOrder

      const createdOrder = a.createdAt.localeCompare(b.createdAt)
      if (createdOrder !== 0) return createdOrder

      return a.id.localeCompare(b.id)
    })
}

export interface RecoveryPatch {
  status: 'queued'
  attempts: number
  queuedAt: string
  startedAt: undefined
  recovery: EvalRunRecoveryRecord
  executionOwner: undefined
  attemptHistory: ReturnType<typeof appendAttemptHistory>
  metadata: Record<string, unknown>
}

export function buildRecoveryPatch(run: EvalRunRecord): {
  patch: RecoveryPatch
  recovery: EvalRunRecoveryRecord
} {
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

  return {
    patch: {
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
    recovery,
  }
}
