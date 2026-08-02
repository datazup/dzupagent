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
 * Instead this module defines a small scorer contract that is *structurally*
 * compatible with the shared, runtime-free type contracts in
 * `@dzupagent/eval-contracts` (a Layer 0 leaf-primitives package any layer may
 * depend on): the field names of {@link FanoutEvalResult} mirror `EvalResult`
 * (score/pass/reasoning/metadata) and {@link FanoutScorerConfig} mirrors
 * `ScorerConfigLike` (id/name/description/type/threshold). A consumer that
 * sits above both packages (e.g. `@dzupagent/server`, or an app) can trivially
 * adapt a {@link FanoutEvalResult} into the generic eval-contracts shape
 * without this package ever importing `evals`.
 *
 * Where a contract is genuinely SHARED rather than merely parallel, it is
 * imported from `eval-contracts` instead of restated — {@link Measurable} is
 * the first such case. A hand-written mirror of a semantic contract has no
 * mechanism to keep the two copies honest; a Layer 0 import does.
 *
 * The three scorers under this directory score STRUCTURED objects (spawn
 * requests/decisions, resolved specs, fan-out reports/ledgers) rather than
 * the string-in/string-out shape `@dzupagent/evals`' `runBenchmark` assumes
 * — so `TInput` here is a domain object, not a prompt/completion string.
 */

import type { Measurable } from "@dzupagent/eval-contracts";

export type { Measurable };

/**
 * Mirrors `@dzupagent/eval-contracts`'s `EvalResult` field-for-field, and
 * extends its {@link Measurable} contract for the vacuity flag.
 *
 * `measured` is INHERITED rather than redeclared on purpose: the identical
 * flag exists on `@dzupagent/evals`' `ScorerResult`, and when both packages
 * declared it independently nothing could catch the two definitions drifting
 * apart. `Measurable` lives in Layer 0, which both may depend on, so the
 * contract and its documented meaning now have exactly one home.
 *
 * For a fanout scorer specifically, `measured: false` means the case declared
 * no items: every comparison loop was empty, so the scorer could not fail and
 * `score: 1` records an absence of evidence rather than evidence of
 * correctness. See {@link FanoutSuiteReport.measuredCount} for how the harness
 * excludes those.
 */
export interface FanoutEvalResult extends Measurable {
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
  /**
   * Mean score across MEASURED cases only.
   *
   * Vacuous cases are excluded rather than averaged in as 1.0, which would
   * let zero-evidence cases inflate a suite's headline number. `0` when
   * nothing was measured.
   */
  aggregateScore: number;
  /** Number of cases whose result.pass was true (includes vacuous passes). */
  passCount: number;
  totalCount: number;
  /**
   * Number of cases that actually checked something, i.e. whose result did
   * not set `measured: false`. `totalCount - measuredCount` is the vacuous
   * count.
   */
  measuredCount: number;
  /**
   * True iff every case passed AND at least one case actually measured
   * something.
   *
   * A suite of nothing but vacuous cases is not a green suite — it is an
   * unrun one, and reporting it as `allPassed` is the failure this field
   * exists to prevent.
   */
  allPassed: boolean;
}
