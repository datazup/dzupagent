import { describe, it, expect, vi } from 'vitest';
import {
  runBenchmark,
  compareBenchmarks,
  createBenchmarkWithJudge,
} from '../benchmarks/benchmark-runner.js';
import type { BenchmarkSuite, BenchmarkResult } from '../benchmarks/benchmark-types.js';
import { CODE_GEN_SUITE } from '../benchmarks/suites/code-gen.js';
import { QA_SUITE } from '../benchmarks/suites/qa.js';
import { TOOL_USE_SUITE } from '../benchmarks/suites/tool-use.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSuite(overrides?: Partial<BenchmarkSuite>): BenchmarkSuite {
  return {
    id: 'test-suite',
    name: 'Test Suite',
    description: 'A test benchmark suite',
    category: 'qa',
    dataset: [
      {
        id: 'e1',
        input: 'What is TypeScript?',
        expectedOutput: 'TypeScript is a typed superset of JavaScript',
      },
      {
        id: 'e2',
        input: 'What is Node.js?',
        expectedOutput: 'Node.js is a runtime for JavaScript',
      },
    ],
    scorers: [
      { id: 'scorer-1', name: 'Test Scorer', type: 'deterministic', description: 'test' },
    ],
    baselineThresholds: {
      'scorer-1': 0.5,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// runBenchmark — deterministic scorer
// ---------------------------------------------------------------------------

describe('runBenchmark', () => {
  it('runs a simple deterministic benchmark and computes scores', async () => {
    const suite = makeSuite();
    const target = vi.fn().mockImplementation(async (input: string) => {
      if (input.includes('TypeScript')) {
        return 'TypeScript is a typed superset of JavaScript that compiles to plain JS';
      }
      return 'Node.js is a runtime for JavaScript on the server';
    });

    const result = await runBenchmark(suite, target);

    expect(result.suiteId).toBe('test-suite');
    expect(result.timestamp).toBeTruthy();
    expect(result.scores['scorer-1']).toBeDefined();
    expect(result.scores['scorer-1']!).toBeGreaterThan(0);
    expect(target).toHaveBeenCalledTimes(2);
  });

  it('passes baseline when scores meet thresholds', async () => {
    const suite = makeSuite({
      baselineThresholds: { 'scorer-1': 0.3 },
    });

    const target = async (input: string) =>
      `TypeScript JavaScript Node.js runtime typed superset ${input}`;

    const result = await runBenchmark(suite, target);
    expect(result.passedBaseline).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it('fails baseline when scores are below thresholds', async () => {
    const suite = makeSuite({
      baselineThresholds: { 'scorer-1': 0.99 },
    });

    const target = async () => 'completely unrelated response';

    const result = await runBenchmark(suite, target);
    expect(result.passedBaseline).toBe(false);
    expect(result.regressions).toContain('scorer-1');
  });

  it('handles empty dataset', async () => {
    const suite = makeSuite({ dataset: [] });
    const target = async () => 'response';

    const result = await runBenchmark(suite, target);
    expect(result.scores['scorer-1']).toBe(0);
    // With 0 entries, avg is 0, which is below the 0.5 threshold
    expect(result.passedBaseline).toBe(false);
    expect(result.regressions).toContain('scorer-1');
  });

  it('handles multiple scorers', async () => {
    const suite = makeSuite({
      scorers: [
        { id: 's1', name: 'S1', type: 'deterministic', description: 'test' },
        { id: 's2', name: 'S2', type: 'custom', description: 'test' },
      ],
      baselineThresholds: { s1: 0.3, s2: 0.5 },
    });

    const target = async (input: string) =>
      `TypeScript JavaScript Node.js runtime typed superset ${input}`;

    const result = await runBenchmark(suite, target);
    expect(result.scores['s1']).toBeDefined();
    expect(result.scores['s2']).toBeDefined();
    // custom scorer returns 1.0 for non-empty output
    expect(result.scores['s2']).toBe(1.0);
  });

  it('deterministic scorer: returns 1.0 for non-empty output when no reference', async () => {
    const suite = makeSuite({
      dataset: [{ id: 'e1', input: 'test' }], // no expectedOutput
    });

    const target = async () => 'some output';
    const result = await runBenchmark(suite, target);
    expect(result.scores['scorer-1']).toBe(1.0);
  });

  it('deterministic scorer: returns 0.0 for empty output when no reference', async () => {
    const suite = makeSuite({
      dataset: [{ id: 'e1', input: 'test' }],
    });

    const target = async () => '';
    const result = await runBenchmark(suite, target);
    expect(result.scores['scorer-1']).toBe(0.0);
  });

  it('composite scorer: averages deterministic + existence', async () => {
    const suite = makeSuite({
      scorers: [{ id: 'comp', name: 'Comp', type: 'composite', description: 'test' }],
      baselineThresholds: { comp: 0.3 },
      dataset: [
        { id: 'e1', input: 'test', expectedOutput: 'the expected answer with keywords' },
      ],
    });

    const target = async () => 'a response with no matching keywords at all';
    const result = await runBenchmark(suite, target);
    // deterministic gets low score, existence gets 1.0, average is moderate
    expect(result.scores['comp']).toBeDefined();
    expect(result.scores['comp']!).toBeGreaterThan(0);
    expect(result.scores['comp']!).toBeLessThanOrEqual(1);
  });

  it('custom scorer: returns 1.0 for non-empty, 0.0 for empty', async () => {
    const suite = makeSuite({
      scorers: [{ id: 'c', name: 'C', type: 'custom', description: 'test' }],
      baselineThresholds: {},
    });

    const target1 = async () => 'some content';
    const r1 = await runBenchmark(suite, target1);
    expect(r1.scores['c']).toBe(1.0);

    const target2 = async () => '';
    const r2 = await runBenchmark(suite, target2);
    expect(r2.scores['c']).toBe(0.0);
  });

  it('unknown scorer type: returns 1.0 for non-empty', async () => {
    const suite = makeSuite({
      scorers: [{ id: 'u', name: 'U', type: 'unknown-type', description: 'test' }],
      baselineThresholds: {},
    });

    const target = async () => 'output';
    const result = await runBenchmark(suite, target);
    expect(result.scores['u']).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// runBenchmark — llm-judge scorer
// ---------------------------------------------------------------------------

describe('runBenchmark with llm-judge', () => {
  it('falls back to heuristic when no llm provided', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const suite = makeSuite({
      scorers: [{ id: 'judge', name: 'J', type: 'llm-judge', description: 'test' }],
      baselineThresholds: {},
    });

    const target = async () => 'non-empty output';
    const result = await runBenchmark(suite, target);
    expect(result.scores['judge']).toBe(0.5);

    consoleSpy.mockRestore();
  });

  it('returns 0.0 for empty output with heuristic fallback', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const suite = makeSuite({
      scorers: [{ id: 'judge', name: 'J', type: 'llm-judge', description: 'test' }],
      baselineThresholds: {},
    });

    const target = async () => '   ';
    const result = await runBenchmark(suite, target);
    expect(result.scores['judge']).toBe(0.0);

    consoleSpy.mockRestore();
  });

  it('throws in strict mode without llm', async () => {
    const suite = makeSuite({
      scorers: [{ id: 'judge', name: 'J', type: 'llm-judge', description: 'test' }],
      baselineThresholds: {},
    });

    const target = async () => 'output';
    await expect(
      runBenchmark(suite, target, { strict: true }),
    ).rejects.toThrow('strict mode');
  });

  it('uses llm judge with custom criteria when provided', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'relevance', score: 0.8, reasoning: 'Good' },
        { criterion: 'accuracy', score: 0.9, reasoning: 'Accurate' },
      ]),
    );

    const suite = makeSuite({
      scorers: [{ id: 'judge', name: 'J', type: 'llm-judge', description: 'test' }],
      baselineThresholds: {},
      dataset: [{ id: 'e1', input: 'question', expectedOutput: 'answer' }],
    });

    const config = createBenchmarkWithJudge({
      llm,
      criteria: [
        { name: 'relevance', description: 'Is it relevant?', weight: 0.5 },
        { name: 'accuracy', description: 'Is it accurate?', weight: 0.5 },
      ],
    });

    const target = async () => 'good answer';
    const result = await runBenchmark(suite, target, config);
    expect(result.scores['judge']).toBeGreaterThan(0);
    expect(llm).toHaveBeenCalled();
  });

  it('uses default 5-dim scorer when llm provided without custom criteria', async () => {
    const llm = vi.fn().mockResolvedValue(JSON.stringify({
      correctness: 8,
      completeness: 7,
      coherence: 9,
      relevance: 8,
      safety: 10,
      reasoning: 'Good output',
    }));

    const suite = makeSuite({
      scorers: [{ id: 'judge', name: 'J', type: 'llm-judge', description: 'test' }],
      baselineThresholds: {},
      dataset: [{ id: 'e1', input: 'question', expectedOutput: 'answer' }],
    });

    const target = async () => 'response';
    const result = await runBenchmark(suite, target, { llm });
    expect(result.scores['judge']).toBeGreaterThan(0);
  });

  it('returns 0.0 when llm judge throws', async () => {
    const llm = vi.fn().mockRejectedValue(new Error('API error'));

    const suite = makeSuite({
      scorers: [{ id: 'judge', name: 'J', type: 'llm-judge', description: 'test' }],
      baselineThresholds: {},
      dataset: [{ id: 'e1', input: 'q', expectedOutput: 'a' }],
    });

    const target = async () => 'response';
    const result = await runBenchmark(suite, target, {
      llm,
      judgeCriteria: [{ name: 'test', description: 'test', weight: 1 }],
    });
    expect(result.scores['judge']).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// compareBenchmarks
// ---------------------------------------------------------------------------

describe('compareBenchmarks', () => {
  const makeResult = (scores: Record<string, number>): BenchmarkResult => ({
    suiteId: 'test',
    timestamp: new Date().toISOString(),
    scores,
    passedBaseline: true,
    regressions: [],
  });

  it('detects improvements', () => {
    const current = makeResult({ s1: 0.8 });
    const previous = makeResult({ s1: 0.5 });

    const comparison = compareBenchmarks(current, previous);
    expect(comparison.improved).toContain('s1');
    expect(comparison.regressed).toHaveLength(0);
    expect(comparison.unchanged).toHaveLength(0);
  });

  it('detects regressions', () => {
    const current = makeResult({ s1: 0.3 });
    const previous = makeResult({ s1: 0.8 });

    const comparison = compareBenchmarks(current, previous);
    expect(comparison.regressed).toContain('s1');
    expect(comparison.improved).toHaveLength(0);
  });

  it('detects unchanged scores', () => {
    const current = makeResult({ s1: 0.5 });
    const previous = makeResult({ s1: 0.5 });

    const comparison = compareBenchmarks(current, previous);
    expect(comparison.unchanged).toContain('s1');
  });

  it('treats small differences within EPSILON as unchanged', () => {
    const current = makeResult({ s1: 0.5005 });
    const previous = makeResult({ s1: 0.5 });

    const comparison = compareBenchmarks(current, previous);
    expect(comparison.unchanged).toContain('s1');
  });

  it('handles scorer present in only one result', () => {
    const current = makeResult({ s1: 0.8, s2: 0.6 });
    const previous = makeResult({ s1: 0.7 });

    const comparison = compareBenchmarks(current, previous);
    // s2 is new (0.6 vs 0), so improved
    expect(comparison.improved).toContain('s2');
  });

  it('handles scorer missing in current (defaults to 0)', () => {
    const current = makeResult({});
    const previous = makeResult({ s1: 0.8 });

    const comparison = compareBenchmarks(current, previous);
    expect(comparison.regressed).toContain('s1');
  });

  it('handles empty score maps', () => {
    const current = makeResult({});
    const previous = makeResult({});

    const comparison = compareBenchmarks(current, previous);
    expect(comparison.improved).toHaveLength(0);
    expect(comparison.regressed).toHaveLength(0);
    expect(comparison.unchanged).toHaveLength(0);
  });

  it('handles multiple scorers in mixed states', () => {
    const current = makeResult({ s1: 0.9, s2: 0.3, s3: 0.5 });
    const previous = makeResult({ s1: 0.5, s2: 0.8, s3: 0.5 });

    const comparison = compareBenchmarks(current, previous);
    expect(comparison.improved).toContain('s1');
    expect(comparison.regressed).toContain('s2');
    expect(comparison.unchanged).toContain('s3');
  });
});

// ---------------------------------------------------------------------------
// createBenchmarkWithJudge
// ---------------------------------------------------------------------------

describe('createBenchmarkWithJudge', () => {
  it('creates config with provided llm and default criteria', () => {
    const llm = async (_prompt: string) => 'response';
    const config = createBenchmarkWithJudge({ llm });
    expect(config.llm).toBe(llm);
    expect(config.judgeCriteria).toBeDefined();
    expect(config.judgeCriteria!.length).toBeGreaterThan(0);
  });

  it('uses custom criteria when provided', () => {
    const llm = async (_prompt: string) => 'response';
    const criteria = [{ name: 'custom', description: 'Custom', weight: 1 }];
    const config = createBenchmarkWithJudge({ llm, criteria });
    expect(config.judgeCriteria).toBe(criteria);
  });
});

// ---------------------------------------------------------------------------
// Benchmark suite structure validation
// ---------------------------------------------------------------------------

describe('benchmark suite structures', () => {
  it('CODE_GEN_SUITE has valid structure', () => {
    expect(CODE_GEN_SUITE.id).toBe('code-gen');
    expect(CODE_GEN_SUITE.category).toBe('code-gen');
    expect(CODE_GEN_SUITE.dataset.length).toBeGreaterThan(0);
    expect(CODE_GEN_SUITE.scorers.length).toBeGreaterThan(0);
    for (const entry of CODE_GEN_SUITE.dataset) {
      expect(entry.id).toBeTruthy();
      expect(entry.input).toBeTruthy();
      expect(entry.tags).toBeDefined();
    }
    for (const scorer of CODE_GEN_SUITE.scorers) {
      expect(CODE_GEN_SUITE.baselineThresholds[scorer.id]).toBeDefined();
    }
  });

  it('QA_SUITE has valid structure', () => {
    expect(QA_SUITE.id).toBe('qa');
    expect(QA_SUITE.category).toBe('qa');
    expect(QA_SUITE.dataset.length).toBeGreaterThan(0);
    for (const entry of QA_SUITE.dataset) {
      expect(entry.id).toBeTruthy();
      expect(entry.input).toBeTruthy();
    }
  });

  it('TOOL_USE_SUITE has valid structure', () => {
    expect(TOOL_USE_SUITE.id).toBe('tool-use');
    expect(TOOL_USE_SUITE.category).toBe('tool-use');
    expect(TOOL_USE_SUITE.dataset.length).toBeGreaterThan(0);
    for (const entry of TOOL_USE_SUITE.dataset) {
      expect(entry.id).toBeTruthy();
      expect(entry.metadata).toBeDefined();
    }
  });

  it('all entries have unique IDs within their suites', () => {
    for (const suite of [CODE_GEN_SUITE, QA_SUITE, TOOL_USE_SUITE]) {
      const ids = suite.dataset.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
