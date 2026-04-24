/**
 * As of MC-A02 the record and store interfaces are canonically defined in
 * @dzupagent/eval-contracts. This module re-exports them so existing
 * downstream imports (e.g. `from '../persistence/eval-run-store.js'`) keep
 * working, and keeps the `InMemoryEvalRunStore` implementation that the
 * server uses in tests and dev.
 */
export type {
  EvalRunStatus,
  EvalRunErrorRecord,
  EvalRunRecoveryRecord,
  EvalRunExecutionOwnershipRecord,
  EvalRunAttemptRecord,
  EvalRunRecord,
  EvalRunListFilter,
  EvalRunStore,
} from '@dzupagent/eval-contracts'

import type {
  EvalRunAttemptRecord,
  EvalRunListFilter,
  EvalRunRecord,
  EvalRunStore,
} from '@dzupagent/eval-contracts'

function hasOwnProperty<T extends object>(obj: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function assignRunPatch<T extends keyof EvalRunRecord>(
  target: EvalRunRecord,
  patch: Partial<EvalRunRecord>,
  key: T,
): void {
  if (hasOwnProperty(patch, key)) {
    target[key] = patch[key] as EvalRunRecord[T]
  }
}

function mergeRun(existing: EvalRunRecord, patch: Partial<EvalRunRecord>): EvalRunRecord {
  const updated: EvalRunRecord = { ...existing }

  assignRunPatch(updated, patch, 'suiteId')
  assignRunPatch(updated, patch, 'suite')
  assignRunPatch(updated, patch, 'status')
  assignRunPatch(updated, patch, 'createdAt')
  assignRunPatch(updated, patch, 'queuedAt')
  assignRunPatch(updated, patch, 'startedAt')
  assignRunPatch(updated, patch, 'completedAt')
  assignRunPatch(updated, patch, 'result')
  assignRunPatch(updated, patch, 'error')
  assignRunPatch(updated, patch, 'recovery')
  assignRunPatch(updated, patch, 'executionOwner')
  assignRunPatch(updated, patch, 'attemptHistory')
  assignRunPatch(updated, patch, 'metadata')
  assignRunPatch(updated, patch, 'attempts')

  return updated
}

function cloneAttemptRecord(attempt: EvalRunAttemptRecord): EvalRunAttemptRecord {
  return {
    ...attempt,
    recovery: attempt.recovery ? { ...attempt.recovery } : undefined,
    error: attempt.error ? { ...attempt.error } : undefined,
  }
}

function cloneRunRecord(run: EvalRunRecord): EvalRunRecord {
  return {
    ...run,
    metadata: run.metadata ? { ...run.metadata } : undefined,
    recovery: run.recovery ? { ...run.recovery } : undefined,
    executionOwner: run.executionOwner ? { ...run.executionOwner } : undefined,
    attemptHistory: run.attemptHistory?.map(cloneAttemptRecord),
  }
}

export class InMemoryEvalRunStore implements EvalRunStore {
  private readonly runs = new Map<string, EvalRunRecord>()

  async saveRun(run: EvalRunRecord): Promise<void> {
    this.runs.set(run.id, cloneRunRecord(run))
  }

  async updateRun(runId: string, patch: Partial<EvalRunRecord>): Promise<void> {
    const existing = this.runs.get(runId)
    if (!existing) {
      throw new Error(`Eval run "${runId}" not found`)
    }

    this.runs.set(runId, cloneRunRecord(mergeRun(existing, patch)))
  }

  async updateRunIf(
    runId: string,
    predicate: (run: EvalRunRecord) => boolean,
    patch: Partial<EvalRunRecord>,
  ): Promise<boolean> {
    const existing = this.runs.get(runId)
    if (!existing) {
      throw new Error(`Eval run "${runId}" not found`)
    }

    if (!predicate(existing)) {
      return false
    }

    this.runs.set(runId, cloneRunRecord(mergeRun(existing, patch)))
    return true
  }

  async getRun(runId: string): Promise<EvalRunRecord | null> {
    const run = this.runs.get(runId)
    return run ? cloneRunRecord(run) : null
  }

  async listRuns(filter?: EvalRunListFilter): Promise<EvalRunRecord[]> {
    const limit = this.normalizeLimit(filter?.limit)
    return Array.from(this.runs.values())
      .filter((run) => filter?.suiteId === undefined || run.suiteId === filter.suiteId)
      .filter((run) => filter?.status === undefined || run.status === filter.status)
      .sort((a, b) => {
        const queuedOrder = b.queuedAt.localeCompare(a.queuedAt)
        if (queuedOrder !== 0) return queuedOrder

        const createdOrder = b.createdAt.localeCompare(a.createdAt)
        if (createdOrder !== 0) return createdOrder

        return b.id.localeCompare(a.id)
      })
      .slice(0, limit)
      .map((run) => cloneRunRecord(run))
  }

  async listAllRuns(): Promise<EvalRunRecord[]> {
    return Array.from(this.runs.values()).map((run) => cloneRunRecord(run))
  }

  private normalizeLimit(limit: number | undefined): number {
    if (limit === undefined) return 50
    if (!Number.isFinite(limit) || limit <= 0) return 50
    return Math.min(250, Math.floor(limit))
  }
}
