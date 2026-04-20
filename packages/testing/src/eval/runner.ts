import type {
  EvalCase,
  EvalCaseResult,
  EvalRunResult,
  EvalScorer,
  EvalSuite,
} from './types.js';

/**
 * runEvalSuite — executes an EvalSuite and returns a typed EvalRunResult.
 *
 * Each case is run sequentially through the target, then all scorers are
 * applied concurrently per case.  aggregate score is the mean scorer score.
 * A case passes when its aggregate score >= suite.passThreshold (default 0.7).
 */
export async function runEvalSuite(suite: EvalSuite): Promise<EvalRunResult> {
  const passThreshold = suite.passThreshold ?? 0.7;
  const caseResults: EvalCaseResult[] = [];

  for (const evalCase of suite.cases) {
    const output = await runTarget(suite, evalCase);
    const scorerScores = await runScorers(suite.scorers, evalCase, output);

    const aggregateScore =
      scorerScores.length > 0
        ? scorerScores.reduce((sum, s) => sum + s.score.score, 0) / scorerScores.length
        : 0;

    caseResults.push({
      caseId: evalCase.id,
      input: evalCase.input,
      output,
      scorerScores,
      aggregateScore,
      pass: aggregateScore >= passThreshold,
    });
  }

  const overallAggregate =
    caseResults.length > 0
      ? caseResults.reduce((sum, r) => sum + r.aggregateScore, 0) / caseResults.length
      : 0;

  const passCount = caseResults.filter((r) => r.pass).length;
  const passRate = caseResults.length > 0 ? passCount / caseResults.length : 0;

  return {
    suiteName: suite.name,
    timestamp: new Date().toISOString(),
    cases: caseResults,
    aggregateScore: overallAggregate,
    passRate,
    allPassed: passRate === 1.0,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runTarget(suite: EvalSuite, evalCase: EvalCase): Promise<string> {
  try {
    return await suite.target(evalCase.input);
  } catch (err) {
    return `[target error: ${String(err)}]`;
  }
}

async function runScorers(
  scorers: EvalScorer[],
  evalCase: EvalCase,
  output: string,
): Promise<EvalCaseResult['scorerScores']> {
  return Promise.all(
    scorers.map(async (scorer) => {
      const score = await scorer.score(evalCase.input, output, evalCase.expected);
      return { scorerId: scorer.id, score };
    }),
  );
}
