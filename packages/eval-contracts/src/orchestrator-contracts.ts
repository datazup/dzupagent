/**
 * Orchestrator structural contracts. Concrete implementations live in
 * @dzupagent/evals; the server consumes them through these interfaces so it
 * does not need a runtime dependency on @dzupagent/evals.
 */

import type { BenchmarkComparison, BenchmarkSuite } from './benchmark-types.js'
import type { EvalSuite } from './eval-types.js'
import type {
  BenchmarkBaselineRecord,
  BenchmarkRunListFilter,
  BenchmarkRunListPage,
  BenchmarkRunRecord,
  BenchmarkRunArtifactRecord,
  EvalRunListFilter,
  EvalRunRecord,
} from './store-contracts.js'

// --- Eval orchestrator ---

export interface EvalExecutionContext {
  suiteId: string
  runId: string
  attempt: number
  metadata?: Record<string, unknown> | undefined
  signal: AbortSignal
}

export type EvalExecutionTarget = (
  input: string,
  context?: EvalExecutionContext,
) => Promise<string> | string

export interface EvalQueueStats {
  pending: number
  active: number
  oldestPendingAgeMs: number | null
  enqueued: number
  started: number
  completed: number
  failed: number
  cancelled: number
  retried: number
  recovered: number
  requeued: number
}

/**
 * Structural interface for an eval orchestrator. Allows @dzupagent/server to
 * accept an orchestrator via dependency injection without a runtime import of
 * @dzupagent/evals.
 */
export interface EvalOrchestratorLike {
  canExecute(): boolean
  queueRun(input: {
    suite: EvalSuite
    metadata?: Record<string, unknown> | undefined
  }): Promise<EvalRunRecord>
  cancelRun(runId: string): Promise<EvalRunRecord>
  retryRun(runId: string): Promise<EvalRunRecord>
  getRun(runId: string): Promise<EvalRunRecord | null>
  listRuns(filter?: EvalRunListFilter): Promise<EvalRunRecord[]>
  getQueueStats(): Promise<EvalQueueStats>
}

// --- Benchmark orchestrator ---

export interface BenchmarkRunSuiteInput {
  suiteId: string
  targetId: string
  strict?: boolean | undefined
  metadata?: Record<string, unknown> | undefined
  artifact?: BenchmarkRunArtifactRecord | undefined
}

export interface BenchmarkCompareResult {
  currentRun: BenchmarkRunRecord
  previousRun: BenchmarkRunRecord
  comparison: BenchmarkComparison
}

export interface BenchmarkOrchestratorLike {
  runSuite(input: BenchmarkRunSuiteInput): Promise<BenchmarkRunRecord>
  getRun(runId: string): Promise<BenchmarkRunRecord | null>
  listRuns(filter?: BenchmarkRunListFilter): Promise<BenchmarkRunListPage>
  compareRuns(currentRunId: string, previousRunId: string): Promise<BenchmarkCompareResult>
  setBaseline(input: {
    suiteId: string
    targetId: string
    runId: string
  }): Promise<BenchmarkBaselineRecord>
  getBaseline(suiteId: string, targetId: string): Promise<BenchmarkBaselineRecord | null>
  listBaselines(filter?: { suiteId?: string | undefined; targetId?: string | undefined }): Promise<BenchmarkBaselineRecord[]>
}

/**
 * Factory config accepted by the benchmark orchestrator. Exposed here so the
 * server route layer and @dzupagent/evals implementation can share a shape.
 */
export interface BenchmarkOrchestratorConfigLike {
  suites: Record<string, BenchmarkSuite>
  executeTarget: (
    targetId: string,
    input: string,
    metadata?: Record<string, unknown> | undefined,
  ) => Promise<string>
  allowNonStrictExecution?: boolean | undefined
}
