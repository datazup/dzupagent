/**
 * Fanout eval harness — scorer/benchmark contract.
 *
 * Design note (why this is NOT a dependency on `@dzupagent/evals`):
 * `@dzupagent/evals` and `@dzupagent/subagents` are both Layer 2
 * ("domain") packages in config/architecture-boundaries.json's layerGraph,
 * and `layerGraph.rules.allowSameLayerEdges` is `false` — a same-layer edge
 * between two domain packages is a structural violation the repo's
 * `check-domain-boundaries.mjs` gate enforces. `subagents` therefore cannot
 * import `@dzupagent/evals` at runtime.
 *
 * Instead this module defines a small, dependency-free scorer contract that
 * is *structurally* compatible with the shared, runtime-free type contracts
 * in `@dzupagent/eval-contracts` (a Layer 0 leaf-primitives package any
 * layer may depend on): the field names of {@link FanoutEvalResult} mirror
 * `EvalResult` (score/pass/reasoning/metadata) and {@link FanoutScorerConfig}
 * mirrors `ScorerConfigLike` (id/name/description/type/threshold). A
 * consumer that sits above both packages (e.g. `@dzupagent/server`, or an
 * app) can trivially adapt a {@link FanoutScorerResult} into the generic
 * eval-contracts shape without this package ever importing `evals`.
 *
 * The three scorers under this directory score STRUCTURED objects (spawn
 * requests/decisions, resolved specs, fan-out reports/ledgers) rather than
 * the string-in/string-out shape `@dzupagent/evals`' `runBenchmark` assumes
 * — so `TInput` here is a domain object, not a prompt/completion string.
 */

/** Mirrors `@dzupagent/eval-contracts`'s `EvalResult` field-for-field. */
export interface FanoutEvalResult {
  /** Score between 0.0 and 1.0. */
  score: number;
  /** Whether this evaluation passed. */
  pass: boolean;
  /** Human-readable reasoning. */
  reasoning: string;
  /** Optional structured metadata (e.g. which invariant failed). */
  metadata?: Record<string, unknown> | undefined;
}

/** Mirrors `@dzupagent/eval-contracts`'s `ScorerConfigLike` field-for-field. */
export interface FanoutScorerConfig {
  id: string;
  name: string;
  description?: string | undefined;
  /** All fanout scorers are rule-based; kept as a literal (not a union) so
   * this contract never silently accepts an 'llm-judge' scorer — the three
   * eval areas here have machine-checkable ground truth and must stay
   * deterministic. */
  type: "deterministic";
  threshold?: number | undefined;
  version?: string | undefined;
}

/**
 * A fanout scorer evaluates one structured input (never a prompt string)
 * against a deterministic, rule-based invariant and returns a score.
 */
export interface FanoutScorer<TInput> {
  readonly config: FanoutScorerConfig;
  score(input: TInput): FanoutEvalResult | Promise<FanoutEvalResult>;
}

/** One scenario in a fanout eval suite: an input plus the scorer(s) to run over it. */
export interface FanoutEvalCase<TInput> {
  id: string;
  description: string;
  input: TInput;
  /** Tags for filtering/reporting (e.g. 'known-good', 'known-bad', 'scope-widening'). */
  tags?: string[] | undefined;
}

/** Per-case, per-scorer result row in a {@link FanoutSuiteReport}. */
export interface FanoutCaseScore {
  caseId: string;
  scorerId: string;
  result: FanoutEvalResult;
}

/** Aggregate report produced by running a suite of cases through a scorer. */
export interface FanoutSuiteReport {
  suiteId: string;
  scorerId: string;
  timestamp: string;
  scores: FanoutCaseScore[];
  /** Mean score across all cases. */
  aggregateScore: number;
  /** Number of cases whose result.pass was true. */
  passCount: number;
  totalCount: number;
  /** True iff every case passed. */
  allPassed: boolean;
}
