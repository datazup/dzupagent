/**
 * Core evaluation types shared between @dzupagent/evals and consumers such as
 * @dzupagent/server. Types only — no runtime code.
 *
 * Moved from @dzupagent/evals/src/types.ts as part of MC-A02 (server -> evals
 * layer inversion fix).
 */

/**
 * Vacuity discriminator for anything that reports a score.
 *
 * ## Why this is a shared contract rather than a per-package field
 *
 * A scorer that was constructed with nothing to check cannot fail: every
 * comparison loop inside it is empty, so it returns its top score having
 * examined no evidence. That value is an ABSENCE of evidence, not evidence of
 * correctness, and a consumer that averages it into an aggregate or counts it
 * toward a pass/fail gate reports an unrun suite as a green one.
 *
 * The same defect was found and fixed independently in `@dzupagent/evals`
 * (`ScorerResult.measured`) and `@dzupagent/subagents`
 * (`FanoutEvalResult.measured`). Those two packages are both Layer 2 and
 * `layerGraph.rules.allowSameLayerEdges` is `false`, so neither can import the
 * other and the second copy was written by hand from the first. Declaring the
 * field ONCE here — Layer 0, which any layer may depend on — is what stops the
 * two definitions drifting apart silently: a change to the contract or its
 * documented meaning now reaches both consumers through the compiler instead
 * of through someone remembering to copy it.
 *
 * ## The convention
 *
 * Omitted means measured. That keeps the common case free of ceremony, so only
 * a scorer that CAN be constructed with nothing to check needs to say so. It
 * also means the safe reading is `measured !== false` rather than
 * `measured === true`, which is what consumers should filter on.
 *
 * Consumers rolling results into a gate or a regression baseline MUST exclude
 * `measured: false` entries rather than counting them as clean passes, and a
 * suite in which nothing was measured must not report as passing.
 */
export interface Measurable {
  /**
   * Whether the producer actually inspected anything.
   *
   * `false` means it ran but had no evidence to examine. Omitted (the common
   * case) means it did. Never set this to `true` to mean "passed" — it
   * describes whether a measurement happened, not its outcome.
   */
  measured?: boolean | undefined
}

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
