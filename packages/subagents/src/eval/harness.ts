import type {
  FanoutCaseScore,
  FanoutEvalCase,
  FanoutScorer,
  FanoutSuiteReport,
} from "./types.js";

/**
 * Run a fanout eval suite: score every case with the given scorer and
 * produce an aggregate {@link FanoutSuiteReport}.
 *
 * Mirrors the shape (and intent) of `@dzupagent/evals`' `runBenchmark`, but
 * over structured, domain-specific inputs instead of prompt/completion
 * strings — see the design note in `./types.ts` for why this lives here
 * rather than importing the generic runner directly.
 */
export async function runFanoutEvalSuite<TInput>(
  suiteId: string,
  cases: ReadonlyArray<FanoutEvalCase<TInput>>,
  scorer: FanoutScorer<TInput>
): Promise<FanoutSuiteReport> {
  const scores: FanoutCaseScore[] = [];
  for (const testCase of cases) {
    const result = await scorer.score(testCase.input);
    scores.push({ caseId: testCase.id, scorerId: scorer.config.id, result });
  }

  const totalCount = scores.length;
  const passCount = scores.filter((s) => s.result.pass).length;

  // Vacuous cases (measured === false) checked nothing, so their score is an
  // absence of evidence rather than a 1.0 worth averaging in. Exclude them
  // from the headline number and require at least one real measurement before
  // the suite may call itself green.
  const measured = scores.filter((s) => s.result.measured !== false);
  const measuredCount = measured.length;
  const aggregateScore =
    measuredCount === 0
      ? 0
      : measured.reduce((sum, s) => sum + s.result.score, 0) / measuredCount;

  return {
    suiteId,
    scorerId: scorer.config.id,
    timestamp: new Date().toISOString(),
    scores,
    aggregateScore,
    passCount,
    totalCount,
    measuredCount,
    allPassed: totalCount > 0 && passCount === totalCount && measuredCount > 0,
  };
}

/**
 * Run several scorers over the same case set, e.g. to compose a
 * spawn-decision + report-accuracy pass over identical fixtures.
 */
export async function runFanoutEvalSuites<TInput>(
  suiteId: string,
  cases: ReadonlyArray<FanoutEvalCase<TInput>>,
  scorers: ReadonlyArray<FanoutScorer<TInput>>
): Promise<FanoutSuiteReport[]> {
  const reports: FanoutSuiteReport[] = [];
  for (const scorer of scorers) {
    reports.push(await runFanoutEvalSuite(suiteId, cases, scorer));
  }
  return reports;
}
