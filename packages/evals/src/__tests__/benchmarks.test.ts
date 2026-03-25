import { describe, it, expect } from 'vitest';
import { CODE_GEN_SUITE } from '../benchmarks/suites/code-gen.js';
import { QA_SUITE } from '../benchmarks/suites/qa.js';
import { TOOL_USE_SUITE } from '../benchmarks/suites/tool-use.js';
import { MULTI_TURN_SUITE } from '../benchmarks/suites/multi-turn.js';
import { VECTOR_SEARCH_SUITE } from '../benchmarks/suites/vector-search.js';
import { runBenchmark, compareBenchmarks } from '../benchmarks/benchmark-runner.js';
import type { BenchmarkSuite, BenchmarkResult } from '../benchmarks/benchmark-types.js';

// ---------------------------------------------------------------------------
// Suite structure validation
// ---------------------------------------------------------------------------

describe('Benchmark Suites — structure validation', () => {
  const suites: Array<{ name: string; suite: BenchmarkSuite }> = [
    { name: 'CODE_GEN_SUITE', suite: CODE_GEN_SUITE },
    { name: 'QA_SUITE', suite: QA_SUITE },
    { name: 'TOOL_USE_SUITE', suite: TOOL_USE_SUITE },
    { name: 'MULTI_TURN_SUITE', suite: MULTI_TURN_SUITE },
    { name: 'VECTOR_SEARCH_SUITE', suite: VECTOR_SEARCH_SUITE },
  ];

  for (const { name, suite } of suites) {
    describe(name, () => {
      it('should have at least 5 dataset entries', () => {
        expect(suite.dataset.length).toBeGreaterThanOrEqual(5);
      });

      it('should have a valid id', () => {
        expect(suite.id).toBeTruthy();
        expect(typeof suite.id).toBe('string');
      });

      it('should have a valid name and description', () => {
        expect(suite.name).toBeTruthy();
        expect(suite.description).toBeTruthy();
      });

      it('should have a valid category', () => {
        expect(['code-gen', 'qa', 'tool-use', 'multi-turn']).toContain(suite.category);
      });

      it('should have at least one scorer', () => {
        expect(suite.scorers.length).toBeGreaterThanOrEqual(1);
      });

      it('should have baseline thresholds for each scorer', () => {
        for (const scorer of suite.scorers) {
          expect(suite.baselineThresholds[scorer.id]).toBeDefined();
          expect(typeof suite.baselineThresholds[scorer.id]).toBe('number');
        }
      });

      it('should have unique dataset entry IDs', () => {
        const ids = suite.dataset.map((e) => e.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it('should have all required fields on each entry', () => {
        for (const entry of suite.dataset) {
          expect(entry.id).toBeTruthy();
          expect(entry.input).toBeTruthy();
          expect(typeof entry.id).toBe('string');
          expect(typeof entry.input).toBe('string');
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// runBenchmark
// ---------------------------------------------------------------------------

describe('runBenchmark', () => {
  it('should execute against a mock target and return a result', async () => {
    const target = async (input: string): Promise<string> => {
      return `Response to: ${input}`;
    };

    const result = await runBenchmark(CODE_GEN_SUITE, target);

    expect(result.suiteId).toBe('code-gen');
    expect(result.timestamp).toBeTruthy();
    expect(typeof result.passedBaseline).toBe('boolean');
    expect(Array.isArray(result.regressions)).toBe(true);
    expect(typeof result.scores).toBe('object');
  });

  it('should return scores for each scorer', async () => {
    const target = async (_input: string): Promise<string> => {
      return 'function sumEven(numbers: number[]): number { return numbers.filter(n => n % 2 === 0).reduce((sum, n) => sum + n, 0); }';
    };

    const result = await runBenchmark(CODE_GEN_SUITE, target);

    for (const scorer of CODE_GEN_SUITE.scorers) {
      expect(result.scores[scorer.id]).toBeDefined();
      expect(typeof result.scores[scorer.id]).toBe('number');
    }
  });

  it('should detect regressions when scores are below baseline', async () => {
    // Target that returns empty strings — should score 0
    const target = async (_input: string): Promise<string> => '';

    const result = await runBenchmark(CODE_GEN_SUITE, target);

    expect(result.passedBaseline).toBe(false);
    expect(result.regressions.length).toBeGreaterThan(0);
  });

  it('should pass baseline when scores are high enough', async () => {
    // Use a suite with very low thresholds
    const easySuite: BenchmarkSuite = {
      id: 'easy',
      name: 'Easy',
      description: 'Easy test',
      category: 'qa',
      dataset: [
        { id: 'e1', input: 'hello', expectedOutput: 'hello world' },
      ],
      scorers: [
        { id: 's1', name: 'test', type: 'deterministic', threshold: 0.5 },
      ],
      baselineThresholds: { s1: 0.0 },
    };

    const target = async (_input: string): Promise<string> => 'hello world';
    const result = await runBenchmark(easySuite, target);

    expect(result.passedBaseline).toBe(true);
    expect(result.regressions).toEqual([]);
  });

  it('should handle empty dataset gracefully', async () => {
    const emptySuite: BenchmarkSuite = {
      id: 'empty',
      name: 'Empty',
      description: 'Empty test',
      category: 'qa',
      dataset: [],
      scorers: [
        { id: 's1', name: 'test', type: 'deterministic' },
      ],
      baselineThresholds: {},
    };

    const target = async (_input: string): Promise<string> => 'response';
    const result = await runBenchmark(emptySuite, target);

    expect(result.suiteId).toBe('empty');
    expect(result.passedBaseline).toBe(true);
    expect(result.scores['s1']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// compareBenchmarks
// ---------------------------------------------------------------------------

describe('compareBenchmarks', () => {
  it('should detect improvements', () => {
    const previous: BenchmarkResult = {
      suiteId: 'test',
      timestamp: '2024-01-01T00:00:00Z',
      scores: { s1: 0.5, s2: 0.6 },
      passedBaseline: true,
      regressions: [],
    };

    const current: BenchmarkResult = {
      suiteId: 'test',
      timestamp: '2024-01-02T00:00:00Z',
      scores: { s1: 0.8, s2: 0.6 },
      passedBaseline: true,
      regressions: [],
    };

    const comparison = compareBenchmarks(current, previous);

    expect(comparison.improved).toContain('s1');
    expect(comparison.unchanged).toContain('s2');
    expect(comparison.regressed).toEqual([]);
  });

  it('should detect regressions', () => {
    const previous: BenchmarkResult = {
      suiteId: 'test',
      timestamp: '2024-01-01T00:00:00Z',
      scores: { s1: 0.8, s2: 0.7 },
      passedBaseline: true,
      regressions: [],
    };

    const current: BenchmarkResult = {
      suiteId: 'test',
      timestamp: '2024-01-02T00:00:00Z',
      scores: { s1: 0.5, s2: 0.7 },
      passedBaseline: true,
      regressions: [],
    };

    const comparison = compareBenchmarks(current, previous);

    expect(comparison.regressed).toContain('s1');
    expect(comparison.unchanged).toContain('s2');
    expect(comparison.improved).toEqual([]);
  });

  it('should handle new scorers appearing in current', () => {
    const previous: BenchmarkResult = {
      suiteId: 'test',
      timestamp: '2024-01-01T00:00:00Z',
      scores: { s1: 0.5 },
      passedBaseline: true,
      regressions: [],
    };

    const current: BenchmarkResult = {
      suiteId: 'test',
      timestamp: '2024-01-02T00:00:00Z',
      scores: { s1: 0.5, s2: 0.8 },
      passedBaseline: true,
      regressions: [],
    };

    const comparison = compareBenchmarks(current, previous);

    // s2 is new (previous was 0, current is 0.8) — should be improved
    expect(comparison.improved).toContain('s2');
    expect(comparison.unchanged).toContain('s1');
  });

  it('should treat small differences as unchanged', () => {
    const previous: BenchmarkResult = {
      suiteId: 'test',
      timestamp: '2024-01-01T00:00:00Z',
      scores: { s1: 0.5000 },
      passedBaseline: true,
      regressions: [],
    };

    const current: BenchmarkResult = {
      suiteId: 'test',
      timestamp: '2024-01-02T00:00:00Z',
      scores: { s1: 0.5005 },
      passedBaseline: true,
      regressions: [],
    };

    const comparison = compareBenchmarks(current, previous);

    expect(comparison.unchanged).toContain('s1');
    expect(comparison.improved).toEqual([]);
    expect(comparison.regressed).toEqual([]);
  });
});
