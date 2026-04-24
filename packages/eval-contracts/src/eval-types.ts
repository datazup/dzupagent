/**
 * Core evaluation types shared between @dzupagent/evals and consumers such as
 * @dzupagent/server. Types only — no runtime code.
 *
 * Moved from @dzupagent/evals/src/types.ts as part of MC-A02 (server -> evals
 * layer inversion fix).
 */

/**
 * Result of a single evaluation scoring.
 */
export interface EvalResult {
  /** Score between 0.0 and 1.0 */
  score: number
  /** Whether this evaluation passed */
  pass: boolean
  /** Human-readable reasoning */
  reasoning: string
  /** Optional metadata */
  metadata?: Record<string, unknown> | undefined
}

/**
 * A scorer evaluates an output against optional reference.
 */
export interface EvalScorer {
  /** Unique name for this scorer */
  readonly name: string
  /** Score an output against optional reference */
  score(input: string, output: string, reference?: string): Promise<EvalResult>
}

/**
 * A single evaluation test case.
 */
export interface EvalCase {
  id: string
  input: string
  expectedOutput?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

/**
 * A suite of evaluation cases with associated scorers.
 */
export interface EvalSuite {
  name: string
  description?: string | undefined
  cases: EvalCase[]
  scorers: EvalScorer[]
  /** Pass threshold (default: 0.7) */
  passThreshold?: number | undefined
}

/**
 * Result of running a full evaluation suite.
 */
export interface EvalRunResult {
  suiteId: string
  timestamp: string
  results: Array<{
    caseId: string
    scorerResults: Array<{
      scorerName: string
      result: EvalResult
    }>
    aggregateScore: number
    pass: boolean
  }>
  aggregateScore: number
  passRate: number
}

/** Lifecycle status of a persisted eval run. */
export type EvalRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * A single entry in an evaluation dataset.
 * Neutral mirror of @dzupagent/evals EvalEntry.
 */
export interface EvalEntry {
  id: string
  input: string
  expectedOutput?: string | undefined
  tags?: string[] | undefined
  metadata?: Record<string, unknown> | undefined
}

/**
 * Dataset metadata for an evaluation dataset.
 */
export interface DatasetMetadata {
  name: string
  description?: string | undefined
  version?: string | undefined
  createdAt?: string | undefined
  totalEntries: number
  tags: string[]
}

/**
 * Structural type for EvalDataset-like consumers. Implementations live in
 * @dzupagent/evals (e.g. the `EvalDataset` class); consumers that only need
 * to read from a dataset can depend on this contract.
 */
export interface EvalDatasetLike {
  readonly metadata: DatasetMetadata
  entries(): readonly EvalEntry[]
  size(): number
}
