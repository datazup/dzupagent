/**
 * Pure helpers for working with EvalRunRecord attempt history.
 *
 * Extracted from eval-orchestrator.ts in MC-016. These helpers have no
 * dependency on orchestrator state and can be tested in isolation.
 */

import type {
  EvalRunAttemptRecord,
  EvalRunErrorRecord,
  EvalRunRecord,
} from '@dzupagent/eval-contracts'

export function createAbortError(): Error {
  return new DOMException('Eval run cancelled', 'AbortError')
}

export function toEvalRunError(error: unknown): EvalRunErrorRecord {
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

export function cloneAttemptRecord(attempt: EvalRunAttemptRecord): EvalRunAttemptRecord {
  return {
    ...attempt,
    recovery: attempt.recovery ? { ...attempt.recovery } : undefined,
    error: attempt.error ? { ...attempt.error } : undefined,
  }
}

export function createAttemptRecord(input: EvalRunAttemptRecord): EvalRunAttemptRecord {
  return cloneAttemptRecord(input)
}

export function getAttemptHistory(run: EvalRunRecord): EvalRunAttemptRecord[] {
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

export function getCurrentAttemptNumber(run: EvalRunRecord): number {
  const history = getAttemptHistory(run)
  return history[history.length - 1]?.attempt ?? Math.max(1, run.attempts)
}

export function updateAttemptHistory(
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

export function appendAttemptHistory(
  run: EvalRunRecord,
  attemptRecord: EvalRunAttemptRecord,
): EvalRunAttemptRecord[] {
  return [...getAttemptHistory(run), createAttemptRecord(attemptRecord)].sort((a, b) => a.attempt - b.attempt)
}
