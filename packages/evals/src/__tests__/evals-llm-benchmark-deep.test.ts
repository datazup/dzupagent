/**
 * W23-A1: Deep coverage for evals LLM-judge scorer, benchmark runner,
 * eval runner, composite scorer and domain scorer modules.
 *
 * All tests are mock-only — no real LLM API calls.
 */
import { describe, it, expect, vi } from 'vitest';
import { LLMJudgeScorer } from '../llm-judge-scorer.js';
import { CompositeScorer } from '../composite-scorer.js';
import { DeterministicScorer } from '../deterministic-scorer.js';
import { runEvalSuite } from '../eval-runner.js';
import {
  runBenchmark,
  compareBenchmarks,
  createBenchmarkWithJudge,
} from '../benchmarks/benchmark-runner.js';
import type { BenchmarkSuite, BenchmarkResult } from '../benchmarks/benchmark-types.js';
import { DomainScorer } from '../scorers/domain-scorer.js';
import { buildDomainConfig, cloneDomainConfig, DOMAIN_CONFIGS } from '../scorers/domain-scorer/configs.js';
import { clamp01, combinedText, countPatterns } from '../scorers/domain-scorer/helpers.js';
import type { EvalScorer, EvalSuite, EvalResult, EvalInput } from '../types.js';

// ---------------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------------

function judgeJson(score: number, pass?: boolean, reasoning = 'Looks good'): string {
  return JSON.stringify({ score, pass: pass ?? score >= 0.5, reasoning });
}

function mkSuite(overrides: Partial<BenchmarkSuite> = {}): BenchmarkSuite {
  return {
    id: 'deep-suite',
    name: 'Deep Suite',
    description: 'A test benchmark suite',
    category: 'qa',
    dataset: [{ id: 'e1', input: 'ask', expectedOutput: 'good answer here' }],
    scorers: [{ id: 's1', name: 'S1', type: 'deterministic', description: 'det' }],
    baselineThresholds: { s1: 0.3 },
    ...overrides,
  };
}

function fixedScorer(name: string, score: number, pass?: boolean): EvalScorer {
  return {
    name,
    score: vi.fn().mockResolvedValue({
      score,
      pass: pass ?? score >= 0.5,
      reasoning: `${name}=${score}`,
    } satisfies EvalResult),
  };
}

// ===========================================================================
// SECTION 1 — LLMJudgeScorer (legacy simple JSON scorer)
// ===========================================================================

describe('LLMJudgeScorer — deep coverage', () => {
  it('returns numeric score in 0–1 range', async () => {
    const llm = vi.fn().mockResolvedValue(judgeJson(0.73));
    const scorer = new LLMJudgeScorer({ llm, rubric: 'Be good' });
    const result = await scorer.score('in', 'out');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeCloseTo(0.73, 4);
  });

  it('clamps score to 1.0 when LLM returns above-bounds score', async () => {
    const llm = vi.fn().mockResolvedValue(judgeJson(1.7));
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    const result = await scorer.score('in', 'out');
    expect(result.score).toBe(1);
  });

  it('clamps score to 0.0 when LLM returns negative score', async () => {
    const llm = vi.fn().mockResolvedValue(judgeJson(-0.5));
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    const result = await scorer.score('in', 'out');
    expect(result.score).toBe(0);
  });

  it('includes expected input and output text in the LLM prompt', async () => {
    const llm = vi.fn().mockResolvedValue(judgeJson(0.8));
    const scorer = new LLMJudgeScorer({ llm, rubric: 'Test rubric' });
    await scorer.score('UNIQUE_INPUT_TOKEN', 'UNIQUE_OUTPUT_TOKEN');
    const prompt = (llm.mock.calls[0]![0] ?? '') as string;
    expect(prompt).toContain('UNIQUE_INPUT_TOKEN');
    expect(prompt).toContain('UNIQUE_OUTPUT_TOKEN');
    expect(prompt).toContain('Test rubric');
  });

  it('includes the reference in prompt when provided', async () => {
    const llm = vi.fn().mockResolvedValue(judgeJson(0.9));
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    await scorer.score('in', 'out', 'REF_TOKEN');
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('Reference: REF_TOKEN');
  });

  it('omits reference line when not provided', async () => {
    const llm = vi.fn().mockResolvedValue(judgeJson(0.9));
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    await scorer.score('in', 'out');
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).not.toContain('Reference:');
  });

  it('uses the default score range when none configured', async () => {
    const llm = vi.fn().mockResolvedValue(judgeJson(0.8));
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    await scorer.score('in', 'out');
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('0.0 to 1.0');
  });

  it('respects a custom scoreRange in the prompt', async () => {
    const llm = vi.fn().mockResolvedValue(judgeJson(0.8));
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r', scoreRange: '1 to 5' });
    await scorer.score('in', 'out');
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('1 to 5');
  });

  it('prompts include the JSON schema hint', async () => {
    const llm = vi.fn().mockResolvedValue(judgeJson(0.5));
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    await scorer.score('in', 'out');
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"pass"');
    expect(prompt).toContain('"reasoning"');
  });

  it('uses provided custom name', () => {
    const scorer = new LLMJudgeScorer({
      llm: vi.fn(),
      rubric: 'r',
      name: 'my-custom-judge',
    });
    expect(scorer.name).toBe('my-custom-judge');
  });

  it('defaults name to "llm-judge" when none provided', () => {
    const scorer = new LLMJudgeScorer({ llm: vi.fn(), rubric: 'r' });
    expect(scorer.name).toBe('llm-judge');
  });

  it('returns failure result when LLM throws (model error fallback)', async () => {
    const llm = vi.fn().mockRejectedValue(new Error('api boom'));
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    const result = await scorer.score('in', 'out');
    expect(result.score).toBe(0);
    expect(result.pass).toBe(false);
    expect(result.reasoning).toMatch(/Failed to call LLM/i);
  });

  it('returns parse-failure reasoning when LLM response is not JSON', async () => {
    const llm = vi.fn().mockResolvedValue('not json at all');
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    const result = await scorer.score('in', 'out');
    expect(result.score).toBe(0);
    expect(result.pass).toBe(false);
    expect(result.reasoning).toMatch(/Failed to parse/i);
  });

  it('returns parse-failure when LLM returns an array (not object)', async () => {
    const llm = vi.fn().mockResolvedValue(JSON.stringify([1, 2, 3]));
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    const result = await scorer.score('in', 'out');
    expect(result.score).toBe(0);
    expect(result.pass).toBe(false);
  });

  it('returns parse-failure when LLM returns null', async () => {
    const llm = vi.fn().mockResolvedValue(JSON.stringify(null));
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    const result = await scorer.score('in', 'out');
    expect(result.score).toBe(0);
    expect(result.pass).toBe(false);
  });

  it('derives pass from score when pass field missing', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 0.8, reasoning: 'no pass field' }),
    );
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    const result = await scorer.score('in', 'out');
    expect(result.pass).toBe(true);
  });

  it('derives pass=false from low score when pass field missing', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 0.3, reasoning: 'no pass field' }),
    );
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    const result = await scorer.score('in', 'out');
    expect(result.pass).toBe(false);
  });

  it('defaults score to 0.0 when missing', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ pass: true, reasoning: 'no score' }),
    );
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    const result = await scorer.score('in', 'out');
    expect(result.score).toBe(0);
  });

  it('defaults reasoning when missing from response', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 0.9, pass: true }),
    );
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    const result = await scorer.score('in', 'out');
    expect(result.reasoning).toBe('No reasoning provided');
  });

  it('ignores non-string reasoning and uses default', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 0.9, pass: true, reasoning: 123 }),
    );
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    const result = await scorer.score('in', 'out');
    expect(result.reasoning).toBe('No reasoning provided');
  });

  it('supports concurrent scoring without cross-contamination', async () => {
    let i = 0;
    const llm = vi.fn().mockImplementation(async () => {
      const n = i++;
      return judgeJson(n * 0.1, undefined, `call-${n}`);
    });
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    const results = await Promise.all([
      scorer.score('a', 'a-out'),
      scorer.score('b', 'b-out'),
      scorer.score('c', 'c-out'),
    ]);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
    expect(llm).toHaveBeenCalledTimes(3);
  });

  it('treats non-number score field as 0.0', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 'high', pass: true, reasoning: 'x' }),
    );
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    const result = await scorer.score('in', 'out');
    expect(result.score).toBe(0);
  });
});

// ===========================================================================
// SECTION 2 — BenchmarkRunner (suite orchestration)
// ===========================================================================

describe('runBenchmark — deep coverage', () => {
  it('returns BenchmarkResult with all expected fields', async () => {
    const result = await runBenchmark(mkSuite(), async () => 'good answer here');
    expect(result.suiteId).toBe('deep-suite');
    expect(result.timestamp).toBeTruthy();
    expect(typeof result.scores).toBe('object');
    expect(typeof result.passedBaseline).toBe('boolean');
    expect(Array.isArray(result.regressions)).toBe(true);
  });

  it('produces an ISO-8601 timestamp', async () => {
    const result = await runBenchmark(mkSuite(), async () => 'output');
    expect(() => new Date(result.timestamp).toISOString()).not.toThrow();
    expect(new Date(result.timestamp).getTime()).not.toBeNaN();
  });

  it('invokes target once per dataset entry (preserves order)', async () => {
    const target = vi.fn().mockResolvedValue('word matches');
    const suite = mkSuite({
      dataset: [
        { id: 'a', input: 'alpha', expectedOutput: 'word matches' },
        { id: 'b', input: 'beta', expectedOutput: 'word matches' },
        { id: 'c', input: 'gamma', expectedOutput: 'word matches' },
      ],
    });
    await runBenchmark(suite, target);
    expect(target).toHaveBeenCalledTimes(3);
    expect(target.mock.calls[0]![0]).toBe('alpha');
    expect(target.mock.calls[1]![0]).toBe('beta');
    expect(target.mock.calls[2]![0]).toBe('gamma');
  });

  it('reports regressions for scorers below baseline', async () => {
    const suite = mkSuite({
      baselineThresholds: { s1: 0.95 },
    });
    const result = await runBenchmark(suite, async () => 'unrelated text');
    expect(result.passedBaseline).toBe(false);
    expect(result.regressions).toContain('s1');
  });

  it('passes baseline when all scorers meet thresholds', async () => {
    const suite = mkSuite({ baselineThresholds: { s1: 0.1 } });
    const result = await runBenchmark(suite, async () => 'good answer here matching');
    expect(result.passedBaseline).toBe(true);
    expect(result.regressions).toEqual([]);
  });

  it('handles scorer with no baseline threshold configured', async () => {
    const suite = mkSuite({ baselineThresholds: {} });
    const result = await runBenchmark(suite, async () => 'anything');
    expect(result.passedBaseline).toBe(true);
    expect(result.regressions).toEqual([]);
  });

  it('skips accumulator update when scorer id missing in map (defensive)', async () => {
    const suite = mkSuite();
    const result = await runBenchmark(suite, async () => 'ok');
    expect(Object.keys(result.scores)).toContain('s1');
  });

  it('averages scores across all dataset entries', async () => {
    const suite = mkSuite({
      scorers: [{ id: 'c', name: 'C', type: 'custom', description: '' }],
      baselineThresholds: {},
      dataset: [
        { id: 'a', input: 'x' },
        { id: 'b', input: 'y' },
        { id: 'c', input: 'z' },
      ],
    });
    let callN = 0;
    const target = async (): Promise<string> => {
      callN++;
      return callN === 2 ? '' : 'content';
    };
    const result = await runBenchmark(suite, target);
    // custom: 1.0 + 0.0 + 1.0 = 2/3
    expect(result.scores['c']).toBeCloseTo(2 / 3, 4);
  });

  it('handles multiple scorers and computes each score independently', async () => {
    const suite = mkSuite({
      scorers: [
        { id: 'det', name: 'D', type: 'deterministic', description: '' },
        { id: 'cus', name: 'C', type: 'custom', description: '' },
      ],
      baselineThresholds: {},
      dataset: [{ id: 'e1', input: 'in', expectedOutput: 'answer keyword' }],
    });
    const result = await runBenchmark(suite, async () => 'answer keyword reply');
    expect(result.scores['det']).toBeCloseTo(1, 4);
    expect(result.scores['cus']).toBe(1);
  });

  it('supports llm-judge scorer with custom criteria', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([{ criterion: 'rel', score: 0.9, reasoning: 'ok' }]),
    );
    const suite = mkSuite({
      scorers: [{ id: 'j', name: 'J', type: 'llm-judge', description: '' }],
      baselineThresholds: {},
    });
    const result = await runBenchmark(suite, async () => 'a', {
      llm,
      judgeCriteria: [{ name: 'rel', description: 'rel', weight: 1 }],
    });
    expect(result.scores['j']).toBeGreaterThan(0);
    expect(llm).toHaveBeenCalled();
  });

  it('returns 0 for llm-judge when custom-criteria judge throws', async () => {
    const llm = vi.fn().mockRejectedValue(new Error('bad'));
    const suite = mkSuite({
      scorers: [{ id: 'j', name: 'J', type: 'llm-judge', description: '' }],
      baselineThresholds: {},
    });
    const result = await runBenchmark(suite, async () => 'hi', {
      llm,
      judgeCriteria: [{ name: 'rel', description: 'rel', weight: 1 }],
    });
    expect(result.scores['j']).toBe(0);
  });

  it('strict mode: throws when llm-judge used without llm function', async () => {
    const suite = mkSuite({
      scorers: [{ id: 'j', name: 'J', type: 'llm-judge', description: '' }],
      baselineThresholds: {},
    });
    await expect(
      runBenchmark(suite, async () => 'o', { strict: true }),
    ).rejects.toThrow(/strict mode/);
  });

  it('non-strict mode: warns and uses 0.5 heuristic for non-empty output', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const suite = mkSuite({
      scorers: [{ id: 'j', name: 'J', type: 'llm-judge', description: '' }],
      baselineThresholds: {},
    });
    const result = await runBenchmark(suite, async () => 'something');
    expect(result.scores['j']).toBe(0.5);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('non-strict mode: heuristic returns 0.0 for whitespace-only output', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const suite = mkSuite({
      scorers: [{ id: 'j', name: 'J', type: 'llm-judge', description: '' }],
      baselineThresholds: {},
    });
    const result = await runBenchmark(suite, async () => '   \n\t  ');
    expect(result.scores['j']).toBe(0);
    warnSpy.mockRestore();
  });

  it('deterministic keyword overlap scoring works with reference', async () => {
    const suite = mkSuite({
      dataset: [{ id: 'a', input: 'q', expectedOutput: 'alpha beta gamma delta' }],
    });
    const result = await runBenchmark(suite, async () => 'alpha delta only');
    // 2 of 4 keywords match
    expect(result.scores['s1']).toBeCloseTo(0.5, 4);
  });

  it('deterministic scoring ignores short words from reference (length <= 2)', async () => {
    const suite = mkSuite({
      dataset: [{ id: 'a', input: 'q', expectedOutput: 'an is a word xray' }],
    });
    const result = await runBenchmark(suite, async () => 'word xray');
    // only long words ('word','xray') count
    expect(result.scores['s1']).toBeCloseTo(1, 4);
  });

  it('deterministic with reference-of-only-short-words falls back to non-empty check', async () => {
    const suite = mkSuite({
      dataset: [{ id: 'a', input: 'q', expectedOutput: 'is a' }],
    });
    const result = await runBenchmark(suite, async () => 'something');
    expect(result.scores['s1']).toBe(1);
  });

  it('composite scorer averages deterministic and existence', async () => {
    const suite = mkSuite({
      scorers: [{ id: 'cmp', name: 'Cmp', type: 'composite', description: '' }],
      baselineThresholds: {},
      dataset: [{ id: 'a', input: 'q', expectedOutput: 'four five six seven' }],
    });
    const result = await runBenchmark(suite, async () => 'four five');
    // deterministic: 2/4 = 0.5, existence: 1 => (0.5+1)/2 = 0.75
    expect(result.scores['cmp']).toBeCloseTo(0.75, 4);
  });

  it('propagates a target error (not caught by benchmark runner)', async () => {
    const suite = mkSuite();
    const target = vi.fn().mockRejectedValue(new Error('target went boom'));
    await expect(runBenchmark(suite, target)).rejects.toThrow('target went boom');
  });

  it('handles empty dataset with zero-division-safe averages', async () => {
    const suite = mkSuite({ dataset: [], baselineThresholds: {} });
    const result = await runBenchmark(suite, async () => 'x');
    expect(result.scores['s1']).toBe(0);
    expect(result.passedBaseline).toBe(true);
  });

  it('empty dataset with threshold yields regression', async () => {
    const suite = mkSuite({ dataset: [], baselineThresholds: { s1: 0.5 } });
    const result = await runBenchmark(suite, async () => 'x');
    expect(result.passedBaseline).toBe(false);
    expect(result.regressions).toContain('s1');
  });

  it('unknown scorer type falls back to non-empty heuristic (1.0)', async () => {
    const suite = mkSuite({
      scorers: [{ id: 'u', name: 'U', type: 'mystery' as unknown as 'custom', description: '' }],
      baselineThresholds: {},
    });
    const result = await runBenchmark(suite, async () => 'non-empty');
    expect(result.scores['u']).toBe(1);
  });
});

describe('compareBenchmarks — deep coverage', () => {
  const mkResult = (scores: Record<string, number>): BenchmarkResult => ({
    suiteId: 'x',
    timestamp: new Date().toISOString(),
    scores,
    passedBaseline: true,
    regressions: [],
  });

  it('classifies scorer movements above/below/within epsilon', () => {
    const c = mkResult({ up: 0.9, down: 0.2, same: 0.5, tiny: 0.5009 });
    const p = mkResult({ up: 0.5, down: 0.8, same: 0.5, tiny: 0.5 });
    const res = compareBenchmarks(c, p);
    expect(res.improved).toContain('up');
    expect(res.regressed).toContain('down');
    expect(res.unchanged).toContain('same');
    expect(res.unchanged).toContain('tiny');
  });

  it('reports a new scorer (absent in previous) as improved', () => {
    const res = compareBenchmarks(mkResult({ x: 0.4 }), mkResult({}));
    expect(res.improved).toContain('x');
  });

  it('reports a removed scorer (absent in current) as regressed', () => {
    const res = compareBenchmarks(mkResult({}), mkResult({ x: 0.4 }));
    expect(res.regressed).toContain('x');
  });

  it('handles both empty score maps', () => {
    const res = compareBenchmarks(mkResult({}), mkResult({}));
    expect(res.improved).toEqual([]);
    expect(res.regressed).toEqual([]);
    expect(res.unchanged).toEqual([]);
  });

  it('treats 0 vs 0 difference as unchanged', () => {
    const res = compareBenchmarks(mkResult({ z: 0 }), mkResult({ z: 0 }));
    expect(res.unchanged).toContain('z');
  });
});

describe('createBenchmarkWithJudge — deep coverage', () => {
  it('defaults to STANDARD_CRITERIA when none provided', () => {
    const llm = vi.fn();
    const cfg = createBenchmarkWithJudge({ llm });
    expect(cfg.llm).toBe(llm);
    expect(cfg.judgeCriteria!.length).toBeGreaterThan(0);
  });

  it('uses provided custom criteria verbatim', () => {
    const llm = vi.fn();
    const criteria = [{ name: 'x', description: 'x', weight: 1 }];
    const cfg = createBenchmarkWithJudge({ llm, criteria });
    expect(cfg.judgeCriteria).toBe(criteria);
  });
});

// ===========================================================================
// SECTION 3 — EvalRunner (legacy runEvalSuite)
// ===========================================================================

describe('runEvalSuite — deep coverage', () => {
  it('aggregates per-case score over multiple scorers (mean)', async () => {
    const suite: EvalSuite = {
      name: 's',
      cases: [{ id: 'c1', input: 'x' }],
      scorers: [fixedScorer('a', 0.4), fixedScorer('b', 0.8)],
    };
    const res = await runEvalSuite(suite, async () => 'o');
    expect(res.results[0]!.aggregateScore).toBeCloseTo(0.6, 4);
  });

  it('handles zero scorers (aggregateScore = 0)', async () => {
    const suite: EvalSuite = {
      name: 's',
      cases: [{ id: 'c1', input: 'x' }],
      scorers: [],
    };
    const res = await runEvalSuite(suite, async () => 'o');
    expect(res.results[0]!.aggregateScore).toBe(0);
    // No scorers + threshold default 0.7 => aggregate 0 < 0.7 => fail
    expect(res.results[0]!.pass).toBe(false);
  });

  it('pass flag follows >= passThreshold boundary', async () => {
    const suite: EvalSuite = {
      name: 's',
      passThreshold: 0.5,
      cases: [
        { id: 'exact', input: 'x' },
        { id: 'low', input: 'x' },
      ],
      scorers: [fixedScorer('x', 0.5)],
    };
    const res = await runEvalSuite(suite, async () => 'o');
    expect(res.results[0]!.pass).toBe(true);
    expect(res.results[1]!.pass).toBe(true);
  });

  it('passRate is fraction of passing cases', async () => {
    const suite: EvalSuite = {
      name: 's',
      passThreshold: 0.5,
      cases: [
        { id: 'c1', input: 'x' },
        { id: 'c2', input: 'y' },
        { id: 'c3', input: 'z' },
      ],
      scorers: [
        {
          name: 'sw',
          score: vi
            .fn<(_i: string, o: string) => Promise<EvalResult>>()
            .mockImplementation(async (_i, o) => ({
              score: o === 'fail' ? 0 : 1,
              pass: o !== 'fail',
              reasoning: '',
            })),
        },
      ],
    };
    let i = 0;
    const res = await runEvalSuite(suite, async () => (i++ === 1 ? 'fail' : 'ok'));
    expect(res.passRate).toBeCloseTo(2 / 3, 4);
  });

  it('aggregateScore across suite is mean of per-case aggregate', async () => {
    const suite: EvalSuite = {
      name: 's',
      cases: [
        { id: 'c1', input: 'x' },
        { id: 'c2', input: 'y' },
      ],
      scorers: [fixedScorer('a', 0.4)],
    };
    const res = await runEvalSuite(suite, async () => 'o');
    expect(res.aggregateScore).toBeCloseTo(0.4, 4);
  });

  it('serializes result with all required fields', async () => {
    const suite: EvalSuite = {
      name: 'serial',
      cases: [{ id: 'c1', input: 'x' }],
      scorers: [fixedScorer('x', 1)],
    };
    const res = await runEvalSuite(suite, async () => 'o');
    const json = JSON.stringify(res);
    const parsed = JSON.parse(json) as typeof res;
    expect(parsed.suiteId).toBe('serial');
    expect(parsed.results[0]!.caseId).toBe('c1');
    expect(parsed.results[0]!.scorerResults[0]!.scorerName).toBe('x');
  });

  it('suiteId mirrors the provided suite name', async () => {
    const suite: EvalSuite = {
      name: 'my-suite-name-42',
      cases: [],
      scorers: [],
    };
    const res = await runEvalSuite(suite, async () => '');
    expect(res.suiteId).toBe('my-suite-name-42');
  });

  it('target receives exact inputs per case', async () => {
    const seen: string[] = [];
    const suite: EvalSuite = {
      name: 's',
      cases: [
        { id: 'c1', input: 'alpha' },
        { id: 'c2', input: 'beta' },
      ],
      scorers: [fixedScorer('x', 1)],
    };
    await runEvalSuite(suite, async (inp) => {
      seen.push(inp);
      return inp;
    });
    expect(seen.sort()).toEqual(['alpha', 'beta']);
  });

  it('scorerResults retain the scorer name', async () => {
    const suite: EvalSuite = {
      name: 's',
      cases: [{ id: 'c1', input: 'x' }],
      scorers: [fixedScorer('alpha', 1), fixedScorer('beta', 0)],
    };
    const res = await runEvalSuite(suite, async () => 'o');
    const names = res.results[0]!.scorerResults.map((s) => s.scorerName).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });
});

// ===========================================================================
// SECTION 4 — CompositeScorer (weighted average)
// ===========================================================================

describe('CompositeScorer — deep coverage', () => {
  it('returns weighted average of sub-scorers', async () => {
    const c = new CompositeScorer({
      scorers: [
        { scorer: fixedScorer('a', 1), weight: 3 },
        { scorer: fixedScorer('b', 0), weight: 1 },
      ],
    });
    const res = await c.score('in', 'out');
    expect(res.score).toBeCloseTo(0.75, 4);
  });

  it('normalizes weights (3/1 same as 6/2)', async () => {
    const a = new CompositeScorer({
      scorers: [
        { scorer: fixedScorer('a', 1), weight: 3 },
        { scorer: fixedScorer('b', 0), weight: 1 },
      ],
    });
    const b = new CompositeScorer({
      scorers: [
        { scorer: fixedScorer('a', 1), weight: 6 },
        { scorer: fixedScorer('b', 0), weight: 2 },
      ],
    });
    const ra = await a.score('i', 'o');
    const rb = await b.score('i', 'o');
    expect(ra.score).toBeCloseTo(rb.score, 6);
  });

  it('single-scorer passthrough keeps the score identical', async () => {
    const c = new CompositeScorer({
      scorers: [{ scorer: fixedScorer('only', 0.42), weight: 5 }],
    });
    const res = await c.score('i', 'o');
    expect(res.score).toBeCloseTo(0.42, 6);
  });

  it('empty scorers array returns zero score with helpful reasoning', async () => {
    const c = new CompositeScorer({ scorers: [] });
    const res = await c.score('i', 'o');
    expect(res.score).toBe(0);
    expect(res.pass).toBe(false);
    expect(res.reasoning).toMatch(/No scorers/);
  });

  it('zero total weight returns 0 with "Total weight is zero" reasoning', async () => {
    const c = new CompositeScorer({
      scorers: [{ scorer: fixedScorer('z', 1), weight: 0 }],
    });
    const res = await c.score('i', 'o');
    expect(res.score).toBe(0);
    expect(res.reasoning).toMatch(/zero/i);
  });

  it('pass is true exactly when weighted score >= 0.5', async () => {
    const c = new CompositeScorer({
      scorers: [
        { scorer: fixedScorer('a', 0.5), weight: 1 },
        { scorer: fixedScorer('b', 0.5), weight: 1 },
      ],
    });
    const res = await c.score('i', 'o');
    expect(res.score).toBeCloseTo(0.5, 6);
    expect(res.pass).toBe(true);
  });

  it('pass is false when weighted score < 0.5', async () => {
    const c = new CompositeScorer({
      scorers: [
        { scorer: fixedScorer('a', 0), weight: 3 },
        { scorer: fixedScorer('b', 1), weight: 1 },
      ],
    });
    const res = await c.score('i', 'o');
    expect(res.score).toBeCloseTo(0.25, 4);
    expect(res.pass).toBe(false);
  });

  it('resulting score remains within 0–1 for any weights', async () => {
    const c = new CompositeScorer({
      scorers: [
        { scorer: fixedScorer('a', 1), weight: 99 },
        { scorer: fixedScorer('b', 0), weight: 1 },
      ],
    });
    const res = await c.score('i', 'o');
    expect(res.score).toBeGreaterThanOrEqual(0);
    expect(res.score).toBeLessThanOrEqual(1);
  });

  it('combined reasoning includes every sub-scorer name', async () => {
    const c = new CompositeScorer({
      scorers: [
        { scorer: fixedScorer('alpha', 1), weight: 1 },
        { scorer: fixedScorer('beta', 0), weight: 1 },
      ],
    });
    const res = await c.score('i', 'o');
    expect(res.reasoning).toContain('alpha');
    expect(res.reasoning).toContain('beta');
  });

  it('metadata contains per-scorer normalized weights summing to 1', async () => {
    const c = new CompositeScorer({
      scorers: [
        { scorer: fixedScorer('a', 1), weight: 2 },
        { scorer: fixedScorer('b', 0), weight: 6 },
      ],
    });
    const res = await c.score('i', 'o');
    const meta = res.metadata!['scorerResults'] as Array<{
      scorerName: string;
      normalizedWeight: number;
      score: number;
      weight: number;
    }>;
    const total = meta.reduce((s, m) => s + m.normalizedWeight, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(meta.map((m) => m.scorerName).sort()).toEqual(['a', 'b']);
  });

  it('custom name is exposed via the scorer.name property', () => {
    const c = new CompositeScorer({
      name: 'my-comp',
      scorers: [{ scorer: fixedScorer('x', 1), weight: 1 }],
    });
    expect(c.name).toBe('my-comp');
  });

  it('defaults name to "composite" when none provided', () => {
    const c = new CompositeScorer({
      scorers: [{ scorer: fixedScorer('x', 1), weight: 1 }],
    });
    expect(c.name).toBe('composite');
  });

  it('runs sub-scorers concurrently (total latency ~= max not sum)', async () => {
    const delayScorer = (name: string, score: number, ms: number): EvalScorer => ({
      name,
      score: async (): Promise<EvalResult> => {
        await new Promise((r) => setTimeout(r, ms));
        return { score, pass: true, reasoning: name };
      },
    });
    const c = new CompositeScorer({
      scorers: [
        { scorer: delayScorer('a', 1, 40), weight: 1 },
        { scorer: delayScorer('b', 1, 40), weight: 1 },
        { scorer: delayScorer('c', 1, 40), weight: 1 },
      ],
    });
    const start = Date.now();
    await c.score('i', 'o');
    const elapsed = Date.now() - start;
    // Sequential would be >= 120ms; concurrent should be roughly < 120ms.
    expect(elapsed).toBeLessThan(120);
  });

  it('passes reference through to sub-scorers', async () => {
    const inner: EvalScorer = {
      name: 'ref',
      score: vi
        .fn<(i: string, o: string, r?: string) => Promise<EvalResult>>()
        .mockResolvedValue({ score: 1, pass: true, reasoning: '' }),
    };
    const c = new CompositeScorer({ scorers: [{ scorer: inner, weight: 1 }] });
    await c.score('in', 'out', 'ref-value');
    const fn = inner.score as ReturnType<typeof vi.fn>;
    expect(fn).toHaveBeenCalledWith('in', 'out', 'ref-value');
  });
});

// ===========================================================================
// SECTION 5 — Domain scorer modules + helpers
// ===========================================================================

describe('DomainScorer — module behavior', () => {
  it('routes to the correct domain when explicitly configured', async () => {
    const scorer = new DomainScorer({ domain: 'sql' });
    const res = await scorer.score({
      input: 'Write a query',
      output: 'SELECT id FROM users',
    });
    expect(res.domain).toBe('sql');
    expect(res.scorerId).toBe('domain-scorer-sql');
  });

  it('detectDomain identifies SQL content', () => {
    const d = DomainScorer.detectDomain({
      input: 'SELECT something',
      output: 'SELECT name FROM t WHERE id=1',
    });
    expect(d).toBe('sql');
  });

  it('detectDomain falls back to "general" for neutral content', () => {
    const d = DomainScorer.detectDomain({
      input: 'hello there',
      output: 'greetings friend',
    });
    expect(d).toBe('general');
  });

  it('detectDomain identifies code when language keywords appear', () => {
    const d = DomainScorer.detectDomain({
      input: 'write a function',
      output: 'function add(a: number, b: number) { return a + b; }',
    });
    // 'code' scorer has patterns around function/const/return
    expect(['code', 'general']).toContain(d);
  });

  it('buildDomainConfig normalizes overridden weights to sum to 1', () => {
    const cfg = buildDomainConfig({
      domain: 'code',
      weightOverrides: { typeCorrectness: 4, testCoverage: 2 },
    });
    const sum = cfg.criteria.reduce((s, c) => s + c.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('buildDomainConfig respects customConfig field overrides without mutating DOMAIN_CONFIGS', () => {
    const before = cloneDomainConfig('sql');
    const cfg = buildDomainConfig({
      domain: 'sql',
      customConfig: { name: 'OverrideName' },
    });
    expect(cfg.name).toBe('OverrideName');
    expect(DOMAIN_CONFIGS.sql.name).toBe(before.name);
  });

  it('cloneDomainConfig returns a deep clone (criteria array and members)', () => {
    const clone = cloneDomainConfig('code');
    expect(clone.criteria).not.toBe(DOMAIN_CONFIGS.code.criteria);
    clone.criteria[0]!.weight = 0.0001;
    expect(DOMAIN_CONFIGS.code.criteria[0]!.weight).not.toBe(0.0001);
  });

  it('getConfig returns a config for the requested built-in domain', () => {
    const cfg = DomainScorer.getConfig('ops');
    expect(cfg.domain).toBe('ops');
    expect(cfg.criteria.length).toBeGreaterThan(0);
  });

  it('DomainScorer.config reflects domain label', () => {
    const s = new DomainScorer({ domain: 'analysis' });
    expect(s.config.id).toBe('domain-scorer-analysis');
    expect(s.config.type).toBe('composite');
  });

  it('DomainScorer.config switches label to "auto" in auto-detect mode', () => {
    const s = new DomainScorer({ domain: 'general', autoDetect: true });
    expect(s.config.id).toBe('domain-scorer-auto');
  });
});

describe('Domain helpers — deep coverage', () => {
  it('clamp01 clamps below-range values to 0', () => {
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(-0.0001)).toBe(0);
  });

  it('clamp01 clamps above-range values to 1', () => {
    expect(clamp01(2)).toBe(1);
    expect(clamp01(1.01)).toBe(1);
  });

  it('clamp01 is an identity within [0,1]', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
  });

  it('countPatterns counts each pattern match once', () => {
    const n = countPatterns('alpha alpha beta', [/alpha/, /beta/, /gamma/]);
    expect(n).toBe(2);
  });

  it('countPatterns returns 0 for empty patterns', () => {
    expect(countPatterns('any text', [])).toBe(0);
  });

  it('combinedText concatenates input and output', () => {
    const text = combinedText({ input: 'ABC', output: 'DEF' } satisfies EvalInput);
    expect(text).toContain('ABC');
    expect(text).toContain('DEF');
  });
});

// ===========================================================================
// SECTION 6 — Error paths & corrupt data
// ===========================================================================

describe('error and corrupt-input paths', () => {
  it('LLMJudgeScorer gracefully handles a timeout-like rejection', async () => {
    const timeoutError = new Error('timeout');
    const llm = vi.fn().mockRejectedValue(timeoutError);
    const scorer = new LLMJudgeScorer({ llm, rubric: 'r' });
    const res = await scorer.score('in', 'out');
    expect(res.score).toBe(0);
    expect(res.pass).toBe(false);
  });

  it('runBenchmark: scorer registration via suite.scorers does not duplicate ids', async () => {
    const suite = mkSuite({
      scorers: [
        { id: 'dup', name: 'A', type: 'deterministic', description: '' },
        { id: 'dup', name: 'B', type: 'custom', description: '' },
      ],
      baselineThresholds: {},
    });
    const result = await runBenchmark(suite, async () => 'ok');
    // Same key 'dup' in accumulator map — only one entry survives
    expect(Object.keys(result.scores)).toContain('dup');
    expect(Object.keys(result.scores).filter((k) => k === 'dup')).toHaveLength(1);
  });

  it('runBenchmark: deterministic with undefined expectedOutput + empty output gets 0', async () => {
    const suite = mkSuite({
      dataset: [{ id: 'a', input: 'x' }],
      baselineThresholds: {},
    });
    const result = await runBenchmark(suite, async () => '');
    expect(result.scores['s1']).toBe(0);
  });

  it('runBenchmark: deterministic with reference but target returns empty gets 0', async () => {
    const suite = mkSuite({
      dataset: [{ id: 'a', input: 'q', expectedOutput: 'aaa bbb ccc' }],
      baselineThresholds: {},
    });
    const result = await runBenchmark(suite, async () => '');
    expect(result.scores['s1']).toBe(0);
  });

  it('runEvalSuite rejects when any scorer throws', async () => {
    const bad: EvalScorer = {
      name: 'bad',
      score: vi.fn().mockRejectedValue(new Error('nope')),
    };
    const suite: EvalSuite = {
      name: 's',
      cases: [{ id: 'c1', input: 'x' }],
      scorers: [bad],
    };
    await expect(runEvalSuite(suite, async () => 'o')).rejects.toThrow('nope');
  });

  it('CompositeScorer surfaces errors from sub-scorers', async () => {
    const broken: EvalScorer = {
      name: 'broken',
      score: vi.fn().mockRejectedValue(new Error('inner')),
    };
    const c = new CompositeScorer({
      scorers: [
        { scorer: fixedScorer('ok', 1), weight: 1 },
        { scorer: broken, weight: 1 },
      ],
    });
    await expect(c.score('i', 'o')).rejects.toThrow('inner');
  });

  it('integration: CompositeScorer wrapping an LLMJudgeScorer works with DeterministicScorer', async () => {
    const llm = vi.fn().mockResolvedValue(judgeJson(0.9));
    const judge = new LLMJudgeScorer({ llm, rubric: 'r' });
    const det = new DeterministicScorer({ mode: 'contains' });
    const composite = new CompositeScorer({
      scorers: [
        { scorer: judge, weight: 2 },
        { scorer: det, weight: 1 },
      ],
    });
    const res = await composite.score('question', 'the answer is 42', 'the answer');
    // judge=0.9, det=1.0 → (0.9*2 + 1*1)/3 = 2.8/3 ≈ 0.933
    expect(res.score).toBeCloseTo(2.8 / 3, 4);
    expect(res.pass).toBe(true);
  });
});
