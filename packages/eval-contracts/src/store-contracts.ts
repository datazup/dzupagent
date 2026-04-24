/**
 * Store contract types for eval + benchmark persistence. Implementations live
 * in @dzupagent/server (Postgres / in-memory); orchestrators live in
 * @dzupagent/evals. Both sides share these neutral interfaces via
 * @dzupagent/eval-contracts.
 *
 * All optional properties use the explicit `field?: T | undefined` pattern so
 * the shapes are equally assignable under both `exactOptionalPropertyTypes: true`
 * and `false` consumers.
 */

import type {
  BenchmarkComparison,
  BenchmarkResult,
} from './benchmark-types.js'
import type {
  EvalRunResult,
  EvalRunStatus,
  EvalSuite,
} from './eval-types.js'

// --- Eval run records ---

export interface EvalRunErrorRecord {
  code: string
  message: string
}

export interface EvalRunRecoveryRecord {
  previousStatus: 'running'
  previousStartedAt?: string | undefined
  recoveredAt: string
  reason: 'process-restart'
}

export interface EvalRunExecutionOwnershipRecord {
  ownerId: string
  claimedAt: string
  leaseExpiresAt: string
}

export interface EvalRunAttemptRecord {
  attempt: number
  status: EvalRunStatus
  queuedAt: string
  startedAt?: string | undefined
  completedAt?: string | undefined
  result?: EvalRunResult | undefined
  error?: EvalRunErrorRecord | undefined
  recovery?: EvalRunRecoveryRecord | undefined
}

export interface EvalRunRecord {
  id: string
  suiteId: string
  suite: EvalSuite
  status: EvalRunStatus
  createdAt: string
  queuedAt: string
  startedAt?: string | undefined
  completedAt?: string | undefined
  result?: EvalRunResult | undefined
  error?: EvalRunErrorRecord | undefined
  recovery?: EvalRunRecoveryRecord | undefined
  executionOwner?: EvalRunExecutionOwnershipRecord | undefined
  attemptHistory?: EvalRunAttemptRecord[] | undefined
  metadata?: Record<string, unknown> | undefined
  attempts: number
}

export interface EvalRunListFilter {
  suiteId?: string | undefined
  status?: EvalRunStatus | undefined
  limit?: number | undefined
}

export interface EvalRunStore {
  saveRun(run: EvalRunRecord): Promise<void>
  updateRun(runId: string, patch: Partial<EvalRunRecord>): Promise<void>
  updateRunIf(
    runId: string,
    predicate: (run: EvalRunRecord) => boolean,
    patch: Partial<EvalRunRecord>,
  ): Promise<boolean>
  getRun(runId: string): Promise<EvalRunRecord | null>
  listRuns(filter?: EvalRunListFilter): Promise<EvalRunRecord[]>
  listAllRuns(): Promise<EvalRunRecord[]>
}

// --- Benchmark records ---

export interface BenchmarkRunArtifactRecord {
  suiteVersion: string
  datasetHash: string
  promptConfigVersion: string
  buildSha: string
  modelProfile: string
}

export interface BenchmarkRunRecord {
  id: string
  suiteId: string
  targetId: string
  result: BenchmarkResult
  createdAt: string
  strict: boolean
  metadata?: Record<string, unknown> | undefined
  artifact?: BenchmarkRunArtifactRecord | undefined
}

export interface BenchmarkBaselineRecord {
  suiteId: string
  targetId: string
  runId: string
  result: BenchmarkResult
  updatedAt: string
}

export interface BenchmarkCompareRecord {
  currentRunId: string
  previousRunId: string
  comparison: BenchmarkComparison
  createdAt: string
}

export interface BenchmarkRunListFilter {
  suiteId?: string | undefined
  targetId?: string | undefined
  limit?: number | undefined
  cursor?: string | undefined
}

export interface BenchmarkRunListPage {
  data: BenchmarkRunRecord[]
  nextCursor: string | null
  hasMore: boolean
}

export interface BenchmarkRunStore {
  saveRun(run: BenchmarkRunRecord): Promise<void>
  getRun(runId: string): Promise<BenchmarkRunRecord | null>
  listRuns(filter?: BenchmarkRunListFilter): Promise<BenchmarkRunListPage>

  saveBaseline(baseline: BenchmarkBaselineRecord): Promise<void>
  getBaseline(suiteId: string, targetId: string): Promise<BenchmarkBaselineRecord | null>
  listBaselines(filter?: { suiteId?: string | undefined; targetId?: string | undefined }): Promise<BenchmarkBaselineRecord[]>
}
