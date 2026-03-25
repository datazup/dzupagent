/**
 * ECO-179: Benchmark Runner — executes benchmark suites and compares results.
 */

import type { BenchmarkSuite, BenchmarkResult, BenchmarkComparison } from './benchmark-types.js';

/**
 * Run a benchmark suite against a target function.
 *
 * The target function receives an input string and returns an output string.
 * Each dataset entry is passed to the target, and the output is scored
 * against each scorer's configuration.
 *
 * Scoring is deterministic: keyword matching checks if the output contains
 * expected keywords from the reference output.
 */
export async function runBenchmark(
  suite: BenchmarkSuite,
  target: (input: string) => Promise<string>,
): Promise<BenchmarkResult> {
  const scorerAccumulators = new Map<string, { total: number; count: number }>();

  // Initialize accumulators for each scorer
  for (const scorer of suite.scorers) {
    scorerAccumulators.set(scorer.id, { total: 0, count: 0 });
  }

  // Run each dataset entry through the target
  for (const entry of suite.dataset) {
    const output = await target(entry.input);

    // Score the output against each scorer config
    for (const scorer of suite.scorers) {
      const score = computeScore(scorer.type, output, entry.expectedOutput);
      const acc = scorerAccumulators.get(scorer.id);
      if (acc) {
        acc.total += score;
        acc.count++;
      }
    }
  }

  // Compute average scores
  const scores: Record<string, number> = {};
  const regressions: string[] = [];

  for (const [scorerId, acc] of scorerAccumulators.entries()) {
    const avg = acc.count > 0 ? acc.total / acc.count : 0;
    scores[scorerId] = avg;

    const threshold = suite.baselineThresholds[scorerId];
    if (threshold !== undefined && avg < threshold) {
      regressions.push(scorerId);
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
 * Simple scoring based on scorer type.
 * - 'deterministic': keyword overlap between output and reference
 * - 'llm-judge': returns 1.0 if output is non-empty, 0.0 otherwise (placeholder)
 * - 'composite': average of deterministic + existence check
 * - 'custom': returns 1.0 if output is non-empty
 */
function computeScore(
  type: string,
  output: string,
  reference: string | undefined,
): number {
  switch (type) {
    case 'deterministic': {
      if (!reference) return output.length > 0 ? 1.0 : 0.0;
      // Keyword overlap scoring
      const refWords = new Set(
        reference.toLowerCase().split(/\s+/).filter((w) => w.length > 2),
      );
      if (refWords.size === 0) return output.length > 0 ? 1.0 : 0.0;
      const outLower = output.toLowerCase();
      let matches = 0;
      for (const word of refWords) {
        if (outLower.includes(word)) matches++;
      }
      return matches / refWords.size;
    }
    case 'llm-judge':
      return output.trim().length > 0 ? 1.0 : 0.0;
    case 'composite': {
      const deterministicScore = computeScore('deterministic', output, reference);
      const existenceScore = output.trim().length > 0 ? 1.0 : 0.0;
      return (deterministicScore + existenceScore) / 2;
    }
    case 'custom':
      return output.trim().length > 0 ? 1.0 : 0.0;
    default:
      return output.trim().length > 0 ? 1.0 : 0.0;
  }
}
