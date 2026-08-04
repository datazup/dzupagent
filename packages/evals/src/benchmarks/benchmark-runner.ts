/**
 * ECO-179: Benchmark Runner — executes benchmark suites and compares results.
 */

import type {
  BenchmarkSuite,
  BenchmarkResult,
  BenchmarkComparison,
} from "./benchmark-types.js";
import type { EvalInput } from "../types.js";
import type { JudgeCriterion } from "../scorers/criteria.js";
import { createLLMJudge } from "../scorers/llm-judge-enhanced.js";
import { LlmJudgeScorer } from "../scorers/llm-judge-scorer.js";
import { STANDARD_CRITERIA } from "../scorers/criteria.js";
import { defaultLogger } from "@dzupagent/core";

/**
 * Emit one structured JSON log line for a judge-scoring failure/outage.
 *
 * ERR-C-21: an unreachable judge must never fail silently — it must be
 * logged so the outage is visible, instead of surfacing only as a bare
 * `0.0` score indistinguishable from a real regression.
 */
function logJudgeScoringError(operation: string, error: unknown): void {
  const err = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: "UnknownError", message: String(error), stack: undefined };

  defaultLogger.error(
    JSON.stringify({
      level: "error",
      timestamp: new Date().toISOString(),
      component: "@dzupagent/evals/benchmark-runner",
      operation,
      error: err,
    }),
  );
}

/**
 * Configuration for benchmark execution.
 */
export interface BenchmarkConfig {
  /** LLM function for judge scoring. Required when using 'llm-judge' scorers. */
  llm?: (prompt: string) => Promise<string>;
  /** Criteria for LLM judge evaluation. Defaults to STANDARD_CRITERIA. */
  judgeCriteria?: JudgeCriterion[];
  /** If true, fail when a scorer dependency is missing instead of heuristic fallback. */
  strict?: boolean;
}

/**
 * Create a benchmark config with LLM judge from a model.
 *
 * Usage: createBenchmarkWithJudge({ llm: myLlmFn })
 */
export function createBenchmarkWithJudge(base: {
  llm: (prompt: string) => Promise<string>;
  criteria?: JudgeCriterion[];
}): BenchmarkConfig {
  return {
    llm: base.llm,
    judgeCriteria: base.criteria ?? STANDARD_CRITERIA,
  };
}

/**
 * Run a benchmark suite against a target function.
 *
 * The target function receives an input string and returns an output string.
 * Each dataset entry is passed to the target, and the output is scored
 * against each scorer's configuration.
 *
 * When a BenchmarkConfig with an `llm` function is provided, 'llm-judge'
 * scorers will use the enhanced LLM judge for real scoring. Otherwise,
 * llm-judge falls back to a simple non-empty heuristic.
 */
export async function runBenchmark(
  suite: BenchmarkSuite,
  target: (input: string) => Promise<string>,
  config?: BenchmarkConfig,
): Promise<BenchmarkResult> {
  const scorerAccumulators = new Map<
    string,
    { total: number; count: number; unmeasuredCount: number }
  >();

  // Initialize accumulators for each scorer
  for (const scorer of suite.scorers) {
    scorerAccumulators.set(scorer.id, { total: 0, count: 0, unmeasuredCount: 0 });
  }

  // Run each dataset entry through the target
  for (const entry of suite.dataset) {
    const output = await target(entry.input);

    // Score the output against each scorer config
    for (const scorer of suite.scorers) {
      const { score, measured } = await computeScore(
        scorer.type,
        output,
        entry.input,
        entry.expectedOutput,
        config,
      );
      const acc = scorerAccumulators.get(scorer.id);
      if (acc) {
        if (measured) {
          acc.total += score;
          acc.count++;
        } else {
          // ERR-C-21: an unmeasured (errored/unreachable judge) sample must
          // not be folded into the average as if it were a real score.
          acc.unmeasuredCount++;
        }
      }
    }
  }

  // Compute average scores (over measured samples only)
  const scores: Record<string, number> = {};
  const regressions: string[] = [];

  for (const [scorerId, acc] of scorerAccumulators.entries()) {
    const avg = acc.count > 0 ? acc.total / acc.count : 0;
    scores[scorerId] = avg;

    // Only gate on the baseline threshold when there is at least one real
    // measurement. A scorer that never produced a real measurement (e.g. a
    // 100%-unreachable judge) must not be reported as a regression — that
    // would turn an outage into a CI-blocking false positive.
    const threshold = suite.baselineThresholds[scorerId];
    if (threshold !== undefined && acc.count > 0 && avg < threshold) {
      regressions.push(scorerId);
    }

    if (acc.unmeasuredCount > 0) {
      logJudgeScoringError(
        "runBenchmark.scoreEntry",
        new Error(
          `scorer "${scorerId}" produced ${acc.unmeasuredCount} unmeasured ` +
            `(errored/unreachable) sample(s) out of ${acc.count + acc.unmeasuredCount} total; ` +
            `excluded from the average and from regression gating`,
        ),
      );
    }
  }

  const passedBaseline = regressions.length === 0;

  return {
    suiteId: suite.id,
    timestamp: new Date().toISOString(),
    scores,
    passedBaseline,
    regressions,
  };
}

/**
 * Compare two benchmark results and identify improvements, regressions, and unchanged scorers.
 */
export function compareBenchmarks(
  current: BenchmarkResult,
  previous: BenchmarkResult,
): BenchmarkComparison {
  const improved: string[] = [];
  const regressed: string[] = [];
  const unchanged: string[] = [];

  // Collect all scorer IDs from both results
  const allScorerIds = new Set<string>([
    ...Object.keys(current.scores),
    ...Object.keys(previous.scores),
  ]);

  const EPSILON = 0.001;

  for (const scorerId of allScorerIds) {
    const currentScore = current.scores[scorerId] ?? 0;
    const previousScore = previous.scores[scorerId] ?? 0;
    const diff = currentScore - previousScore;

    if (diff > EPSILON) {
      improved.push(scorerId);
    } else if (diff < -EPSILON) {
      regressed.push(scorerId);
    } else {
      unchanged.push(scorerId);
    }
  }

  return { improved, regressed, unchanged };
}

/**
 * Score plus whether it reflects a real measurement.
 *
 * `measured: false` means the judge never actually produced a verdict (it
 * was unreachable, threw, or exhausted retries without a parseable
 * response). Such a score is a neutral placeholder, not evidence — callers
 * must exclude it from averages and regression gating rather than treating
 * it as a real 0.0 (or 0.5) result. See ERR-C-21.
 */
interface ComputedScore {
  score: number;
  measured: boolean;
}

function measuredScore(score: number): ComputedScore {
  return { score, measured: true };
}

/**
 * Score an output based on scorer type.
 *
 * - 'deterministic': keyword overlap between output and reference
 * - 'llm-judge': uses enhanced LLM judge when config.llm is provided,
 *                falls back to non-empty heuristic otherwise
 * - 'composite': average of deterministic + existence check
 * - 'custom': returns 1.0 if output is non-empty
 */
async function computeScore(
  type: string,
  output: string,
  input: string,
  reference: string | undefined,
  config?: BenchmarkConfig,
): Promise<ComputedScore> {
  switch (type) {
    case "deterministic": {
      if (!reference) return measuredScore(output.length > 0 ? 1.0 : 0.0);
      // Keyword overlap scoring
      const refWords = new Set(
        reference
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 2),
      );
      if (refWords.size === 0) return measuredScore(output.length > 0 ? 1.0 : 0.0);
      const outLower = output.toLowerCase();
      let matches = 0;
      for (const word of refWords) {
        if (outLower.includes(word)) matches++;
      }
      return measuredScore(matches / refWords.size);
    }
    case "llm-judge": {
      if (!config?.llm) {
        if (config?.strict) {
          // Safe-prefixed (BadRequest → 400): deliberate config-validation
          // guidance that the route-error sanitizer may forward to the client.
          throw new Error(
            "BadRequest: benchmark-runner: strict mode requires BenchmarkConfig.llm for llm-judge scorer",
          );
        }
        console.warn(
          "benchmark-runner: llm-judge scorer used without providing an llm function in BenchmarkConfig. " +
            "Falling back to non-empty heuristic. Pass { llm: yourLlmFn } to runBenchmark() for real scoring.",
        );
        return measuredScore(output.trim().length > 0 ? 0.5 : 0.0);
      }

      // Use 5-dimension LlmJudgeScorer when available, fall back to enhanced multi-criteria judge
      if (config.judgeCriteria) {
        // Custom criteria provided: use enhanced multi-criteria judge
        const judge = createLLMJudge({
          id: "benchmark-llm-judge",
          criteria: config.judgeCriteria,
          llm: config.llm,
          maxRetries: 1,
        });

        const evalInput: EvalInput = {
          input,
          output,
          reference,
        };

        try {
          const result = await judge.score(evalInput);
          // `measured` defaults to true (omitted = measured) per the
          // ScorerResult contract; the enhanced judge sets it to false when
          // every retry failed to produce a parseable verdict.
          return { score: result.aggregateScore, measured: result.measured ?? true };
        } catch (error) {
          logJudgeScoringError("computeScore.llm-judge.customCriteria", error);
          return { score: 0.0, measured: false };
        }
      }

      // Default: use 5-dimension LlmJudgeScorer
      const scorer = new LlmJudgeScorer({
        llm: config.llm,
        maxRetries: 1,
      });

      try {
        const result = await scorer.score(input, output, reference);
        return { score: result.overall, measured: result.measured };
      } catch (error) {
        logJudgeScoringError("computeScore.llm-judge.fiveDimension", error);
        return { score: 0.0, measured: false };
      }
    }
    case "composite": {
      const deterministic = await computeScore(
        "deterministic",
        output,
        input,
        reference,
        config,
      );
      const existenceScore = output.trim().length > 0 ? 1.0 : 0.0;
      return {
        score: (deterministic.score + existenceScore) / 2,
        measured: deterministic.measured,
      };
    }
    case "custom":
      return measuredScore(output.trim().length > 0 ? 1.0 : 0.0);
    default:
      return measuredScore(output.trim().length > 0 ? 1.0 : 0.0);
  }
}
