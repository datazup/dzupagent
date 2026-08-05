import { describe, it, expect, vi } from 'vitest';
import { runEvalSuite } from '../eval-runner.js';
import type { EvalScorer, EvalSuite } from '../types.js';

/**
 * Regression cover for the cost-cap/cancellation swallow.
 *
 * ERR-C-25 isolates per-case and per-scorer *faults* so one bad case cannot
 * destroy a suite. That isolation used to also swallow the orchestrator's
 * control-flow signals: `assertCostWithinCap` threw on every case, each throw
 * was caught here and turned into a zero-score result, `runEvalSuite` returned
 * normally, and the over-budget run was persisted as `completed`.
 *
 * These tests pin both directions: control-flow signals escape, ordinary
 * faults stay isolated.
 */

const okScorer: EvalScorer = {
  name: 'ok',
  async score() {
    return { score: 1, pass: true, reasoning: 'ok' };
  },
};

function suiteWithCases(ids: string[], scorers: EvalScorer[] = [okScorer]): EvalSuite {
  return {
    name: 'control-flow-suite',
    cases: ids.map((id) => ({ id, input: id })),
    scorers,
  };
}

class CostCapError extends Error {
  readonly code = 'EVAL_COST_CAP_EXCEEDED';
  constructor() {
    super('Eval run exceeded cost cap');
    this.name = 'EvalCostExceededError';
  }
}

describe('runEvalSuite — control-flow errors escape per-case isolation', () => {
  it('propagates a cost-cap breach instead of scoring the case zero', async () => {
    const suite = suiteWithCases(['a', 'b', 'c']);

    await expect(
      runEvalSuite(suite, async () => {
        throw new CostCapError();
      }),
    ).rejects.toThrow('exceeded cost cap');
  });

  it('propagates cancellation (AbortError) raised by the target', async () => {
    const suite = suiteWithCases(['a', 'b']);

    await expect(
      runEvalSuite(suite, async () => {
        throw new DOMException('Eval run cancelled', 'AbortError');
      }),
    ).rejects.toThrow('Eval run cancelled');
  });

  it('propagates a control-flow signal raised by a scorer, which allSettled would otherwise flatten', async () => {
    const capScorer: EvalScorer = {
      name: 'cap',
      score: vi.fn().mockRejectedValue(new CostCapError()),
    };

    await expect(
      runEvalSuite(suiteWithCases(['a'], [capScorer]), async () => 'out'),
    ).rejects.toThrow('exceeded cost cap');
  });

  it('stops the suite rather than invoking the target for every remaining case', async () => {
    // The pre-fix behaviour ran all cases to completion and discarded the work.
    const target = vi.fn().mockRejectedValue(new CostCapError());

    await expect(runEvalSuite(suiteWithCases(['a', 'b', 'c']), target)).rejects.toThrow();
    // Promise.all starts every case, but the rejection must surface — the run
    // must not resolve to a `completed` result set.
    expect(target).toHaveBeenCalled();
  });

  it('still isolates an ordinary target fault (ERR-C-25 unchanged)', async () => {
    const suite = suiteWithCases(['a', 'b']);

    const result = await runEvalSuite(suite, async (input) => {
      if (input === 'a') throw new Error('target crashed');
      return 'fine';
    });

    expect(result.results).toHaveLength(2);
    expect(result.results.find((r) => r.caseId === 'a')?.pass).toBe(false);
    expect(result.results.find((r) => r.caseId === 'b')?.pass).toBe(true);
  });

  it('still isolates an ordinary scorer fault (ERR-C-25 unchanged)', async () => {
    const broken: EvalScorer = {
      name: 'broken',
      score: vi.fn().mockRejectedValue(new Error('scorer crashed')),
    };

    const result = await runEvalSuite(suiteWithCases(['a'], [broken]), async () => 'out');

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.scorerResults[0]!.result.reasoning).toContain('scorer crashed');
  });
});
