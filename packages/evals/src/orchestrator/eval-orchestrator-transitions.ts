/**
 * State-transition helpers for EvalOrchestrator.
 *
 * Encapsulates the store-mutation portions of queue/cancel/retry so the
 * orchestrator class focuses on queue coordination. Extracted from
 * eval-orchestrator-impl.ts in MC-026a.
 */

import { randomUUID } from 'node:crypto'
import type {
  EvalRunRecord,
  EvalRunStore,
  EvalSuite,
} from '@dzupagent/eval-contracts'
import {
  appendAttemptHistory,
  createAttemptRecord,
  getCurrentAttemptNumber,
  updateAttemptHistory,
} from './eval-orchestrator-attempts.js'
import { EvalRunInvalidStateError } from './eval-orchestrator-errors.js'

export function isTerminalStatus(status: EvalRunRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export interface QueueRunInput {
  suite: EvalSuite
  metadata?: Record<string, unknown>
}

export async function persistQueuedRun(
  store: EvalRunStore,
  input: QueueRunInput,
): Promise<EvalRunRecord> {
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
      createAttemptRecord({ attempt: 1, status: 'queued', queuedAt: timestamp }),
    ],
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }

  await store.saveRun(run)

  const created = await store.getRun(runId)
  if (!created) throw new Error(`Eval run "${runId}" missing after enqueue`)
  return created
}

export async function persistCancellation(
  store: EvalRunStore,
  run: EvalRunRecord,
): Promise<EvalRunRecord> {
  const attempt = getCurrentAttemptNumber(run)
  const completedAt = new Date().toISOString()
  const updated = await store.updateRunIf(
    run.id,
    (current) => !isTerminalStatus(current.status),
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
    const cancelledRun = await store.getRun(run.id)
    if (!cancelledRun) throw new Error(`Eval run "${run.id}" missing after cancellation`)
    throw new EvalRunInvalidStateError(`Cannot cancel eval run in ${cancelledRun.status} state`)
  }

  const cancelledRun = await store.getRun(run.id)
  if (!cancelledRun) throw new Error(`Eval run "${run.id}" missing after cancellation`)
  return cancelledRun
}

export async function persistRetry(
  store: EvalRunStore,
  run: EvalRunRecord,
): Promise<EvalRunRecord> {
  const queuedAt = new Date().toISOString()
  const nextAttempt = getCurrentAttemptNumber(run) + 1
  const updated = await store.updateRunIf(run.id, (current) => current.status === 'failed', {
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

  const retriedRun = await store.getRun(run.id)
  if (!retriedRun) throw new Error(`Eval run "${run.id}" missing after retry`)
  return retriedRun
}
