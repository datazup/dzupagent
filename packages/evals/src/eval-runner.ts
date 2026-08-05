import { defaultLogger } from '@dzupagent/core/utils';
import type { EvalCase, EvalResult, EvalRunResult, EvalScorer, EvalSuite } from './types.js';

/**
 * Emit one structured JSON log line for a case/scorer failure during a suite
 * run.
 *
 * ERR-C-25: failures inside `runEvalSuite` used to be fatal to the whole
 * suite and were never logged — the caller only ever saw an unhandled
 * rejection. Every isolated failure must be visible.
 */
function logEvalRunnerError(
  operation: string,
  context: { caseId: string; scorerName?: string },
  error: unknown,
): void {
  const err = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: 'UnknownError', message: String(error), stack: undefined };

  defaultLogger.error(
    JSON.stringify({
      level: 'error',
      timestamp: new Date().toISOString(),
      component: '@dzupagent/evals/eval-runner',
      operation,
      caseId: context.caseId,
      scorerName: context.scorerName,
      error: err,
    }),
  );
}

/**
 * Codes/names that mean "stop the whole run", not "this case faulted".
 *
 * ERR-C-25 isolates *faults* (a target or scorer that misbehaves) so one bad
 * case cannot destroy a suite's other results. Cancellation and budget
 * exhaustion are not faults: they are control-flow signals from the
 * orchestrator that the run must end. Isolating them silently downgraded a
 * cancelled or over-budget run to `completed` — the cap threw on every case,
 * was swallowed here, and `runEvalSuite` returned normally.
 *
 * Matched structurally (by `name`/`code`) rather than by class so this
 * low-level runner keeps no import edge on `orchestrator/`.
 */
const CONTROL_FLOW_ERROR_NAMES = new Set(['AbortError']);
const CONTROL_FLOW_ERROR_CODES = new Set(['EVAL_COST_CAP_EXCEEDED']);

function isControlFlowError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  if (typeof name === 'string' && CONTROL_FLOW_ERROR_NAMES.has(name)) return true;
  return typeof code === 'string' && CONTROL_FLOW_ERROR_CODES.has(code);
}

function errorResult(error: unknown): EvalResult {
  return {
    score: 0,
    pass: false,
    reasoning: `Scorer threw: ${error instanceof Error ? error.message : String(error)}`,
    metadata: { error: true },
  };
}

/**
 * Runs an evaluation suite against a target function.
 *
 * Per-case and per-scorer failures are isolated (ERR-C-25): a scorer that
 * throws for one case is recorded as an errored (failing) result for that
 * scorer rather than destroying the whole suite run, and a case whose
 * target invocation throws is recorded as an errored case rather than
 * rejecting the entire `Promise.all` and discarding every other case's
 * already-completed results. All isolated failures are logged.
 *
 * Isolation covers *faults* only. Control-flow signals — cancellation
 * (`AbortError`) and cost-cap exhaustion (`EVAL_COST_CAP_EXCEEDED`) — propagate
 * so the run terminates instead of quietly finishing as `completed` while every
 * case scored zero. See {@link isControlFlowError}.
 */
export async function runEvalSuite(
  suite: EvalSuite,
  target: (input: string) => Promise<string>,
): Promise<EvalRunResult> {
  const passThreshold = suite.passThreshold ?? 0.7;
  const timestamp = new Date().toISOString();

  const results = await Promise.all(
    suite.cases.map(async (evalCase: EvalCase) => {
      let output: string;
      try {
        output = await target(evalCase.input);
      } catch (error) {
        // Cancellation / cost-cap must abort the suite, not become a zero-score
        // case. Rethrown before logging so it surfaces once, at the orchestrator.
        if (isControlFlowError(error)) throw error;
        logEvalRunnerError('runEvalSuite.target', { caseId: evalCase.id }, error);
        return {
          caseId: evalCase.id,
          scorerResults: [],
          aggregateScore: 0,
          pass: false,
        };
      }

      const settled = await Promise.allSettled(
        suite.scorers.map(async (scorer: EvalScorer) => {
          const result = await scorer.score(
            evalCase.input,
            output,
            evalCase.expectedOutput,
          );
          return { scorerName: scorer.name, result };
        }),
      );

      // `allSettled` never rejects, so a control-flow signal raised by a scorer
      // would otherwise be flattened into a zero score too.
      for (const outcome of settled) {
        if (outcome.status === 'rejected' && isControlFlowError(outcome.reason)) {
          throw outcome.reason;
        }
      }

      const scorerResults = settled.map((outcome, i) => {
        if (outcome.status === 'fulfilled') {
          return outcome.value;
        }
        const scorer = suite.scorers[i]!;
        logEvalRunnerError(
          'runEvalSuite.scorer',
          { caseId: evalCase.id, scorerName: scorer.name },
          outcome.reason,
        );
        return { scorerName: scorer.name, result: errorResult(outcome.reason) };
      });

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
