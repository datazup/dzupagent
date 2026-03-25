import type { EvalCase, EvalRunResult, EvalScorer, EvalSuite } from './types.js';

/**
 * Runs an evaluation suite against a target function.
 */
export async function runEvalSuite(
  suite: EvalSuite,
  target: (input: string) => Promise<string>,
): Promise<EvalRunResult> {
  const passThreshold = suite.passThreshold ?? 0.7;
  const timestamp = new Date().toISOString();

  const results = await Promise.all(
    suite.cases.map(async (evalCase: EvalCase) => {
      const output = await target(evalCase.input);

      const scorerResults = await Promise.all(
        suite.scorers.map(async (scorer: EvalScorer) => {
          const result = await scorer.score(
            evalCase.input,
            output,
            evalCase.expectedOutput,
          );
          return { scorerName: scorer.name, result };
        }),
      );

      const aggregateScore =
        scorerResults.length > 0
          ? scorerResults.reduce((sum, sr) => sum + sr.result.score, 0) /
            scorerResults.length
          : 0;

      return {
        caseId: evalCase.id,
        scorerResults,
        aggregateScore,
        pass: aggregateScore >= passThreshold,
      };
    }),
  );

  const aggregateScore =
    results.length > 0
      ? results.reduce((sum, r) => sum + r.aggregateScore, 0) / results.length
      : 0;

  const passRate =
    results.length > 0
      ? results.filter((r) => r.pass).length / results.length
      : 0;

  return {
    suiteId: suite.name,
    timestamp,
    results,
    aggregateScore,
    passRate,
  };
}
