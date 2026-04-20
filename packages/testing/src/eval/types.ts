/**
 * Eval framework types for packages/testing.
 *
 * Deliberately minimal: three scorer implementations + a suite runner.
 * The LLM-judge scorer depends on @anthropic-ai/sdk injected at call-time
 * so that the module has no hard runtime dep on the SDK.
 */

/** Score returned by any Scorer.  score is always in [0, 1]. */
export interface EvalScore {
  /** Normalised value in [0, 1]. */
  score: number;
  /** True when score meets the suite's passThreshold. */
  pass: boolean;
  /** Human-readable explanation of the score. */
  reasoning: string;
}

/** A scorer evaluates one (input, output, expected?) triple. */
export interface EvalScorer {
  readonly id: string;
  score(input: string, output: string, expected?: string): Promise<EvalScore>;
}

/** One test case inside an EvalSuite. */
export interface EvalCase {
  /** Stable identifier used in result keys. */
  id: string;
  /** The input fed to the target function. */
  input: string;
  /** Optional reference answer passed to scorers. */
  expected?: string;
}

/**
 * A suite wires together cases, a target function, and scorers.
 *
 *   target   — the function under evaluation (e.g. your LLM call)
 *   cases    — array of (id, input, expected?) triples
 *   scorers  — applied to every (input, actualOutput, expected)
 *   passThreshold — minimum aggregate score to mark a case as passing (default 0.7)
 */
export interface EvalSuite {
  name: string;
  target: (input: string) => Promise<string>;
  cases: EvalCase[];
  scorers: EvalScorer[];
  passThreshold?: number;
}

/** Per-case breakdown inside an EvalRunResult. */
export interface EvalCaseResult {
  caseId: string;
  input: string;
  output: string;
  scorerScores: Array<{ scorerId: string; score: EvalScore }>;
  /** Mean of all scorer scores for this case. */
  aggregateScore: number;
  pass: boolean;
}

/** Top-level result returned by runEvalSuite. */
export interface EvalRunResult {
  suiteName: string;
  timestamp: string;
  cases: EvalCaseResult[];
  /** Mean aggregate score across all cases. */
  aggregateScore: number;
  /** Fraction of cases that passed. */
  passRate: number;
  /** True when passRate === 1.0. */
  allPassed: boolean;
}
