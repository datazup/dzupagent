/**
 * Tests for BenchmarkTrendStore — cross-wave trend detection via linear regression.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  BenchmarkTrendStore,
  InMemoryBenchmarkRunStore,
  type BenchmarkRunRecord,
  type BenchmarkRunStore,
} from '../benchmarks/benchmark-trend.js';
import type { BenchmarkResult } from '../benchmarks/benchmark-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBenchmarkResult(suiteId: string, overallScore: number): BenchmarkResult {
  return {
    suiteId,
    timestamp: new Date().toISOString(),
    scores: { overall: overallScore },
    passedBaseline: overallScore >= 0.5,
    regressions: [],
  };
}

function makeRecord(
  suiteId: string,
  targetId: string,
  overallScore: number,
  index: number,
): BenchmarkRunRecord {
  return {
    runId: `run-${suiteId}-${targetId}-${index}`,
    suiteId,
    targetId,
    timestamp: new Date(Date.now() + index * 60_000).toISOString(),
    overallScore,
    result: makeBenchmarkResult(suiteId, overallScore),
  };
}

async function seedStore(
  store: BenchmarkRunStore,
  suiteId: string,
  targetId: string,
  scores: number[],
): Promise<void> {
  for (let i = 0; i < scores.length; i++) {
    await store.append(makeRecord(suiteId, targetId, scores[i]!, i));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BenchmarkTrendStore', () => {
  let memoryStore: InMemoryBenchmarkRunStore;
  let trendStore: BenchmarkTrendStore;

  beforeEach(() => {
    memoryStore = new InMemoryBenchmarkRunStore();
    trendStore = new BenchmarkTrendStore(memoryStore);
  });

  // ── Insufficient data ────────────────────────────────

  describe('insufficient data', () => {
    it('returns insufficient_data for empty store', async () => {
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.direction).toBe('insufficient_data');
      expect(result.deltaPerWave).toBe(0);
      expect(result.runs).toEqual([]);
    });

    it('returns insufficient_data for single run', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.8]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.direction).toBe('insufficient_data');
      expect(result.runs).toHaveLength(1);
    });

    it('returns insufficient_data for two runs', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.7, 0.8]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.direction).toBe('insufficient_data');
      expect(result.runs).toHaveLength(2);
    });

    it('returns deltaPerWave = 0 when insufficient data', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.5]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.deltaPerWave).toBe(0);
    });
  });

  // ── Stable trend ─────────────────────────────────────

  describe('stable trend', () => {
    it('detects stable scores as stable', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.8, 0.8, 0.8, 0.8, 0.8]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.direction).toBe('stable');
    });

    it('detects nearly constant scores as stable', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.80, 0.81, 0.80, 0.81, 0.80]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.direction).toBe('stable');
    });

    it('detects flat trend with tiny noise as stable', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.50, 0.50, 0.505, 0.50, 0.50]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.direction).toBe('stable');
    });

    it('has deltaPerWave near zero for stable', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.7, 0.7, 0.7]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(Math.abs(result.deltaPerWave)).toBeLessThan(0.01);
    });
  });

  // ── Improving trend ──────────────────────────────────

  describe('improving trend', () => {
    it('detects linearly increasing scores as improving', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.5, 0.6, 0.7, 0.8, 0.9]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.direction).toBe('improving');
    });

    it('detects generally increasing scores with noise as improving', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.4, 0.55, 0.5, 0.65, 0.7]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.direction).toBe('improving');
    });

    it('has positive deltaPerWave for improving', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.3, 0.5, 0.7]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.deltaPerWave).toBeGreaterThan(0.01);
    });

    it('deltaPerWave approximates 0.1 for linear +0.1/run', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.5, 0.6, 0.7, 0.8, 0.9]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.deltaPerWave).toBeCloseTo(0.1, 5);
    });
  });

  // ── Degrading trend ──────────────────────────────────

  describe('degrading trend', () => {
    it('detects linearly decreasing scores as degrading', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.9, 0.8, 0.7, 0.6, 0.5]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.direction).toBe('degrading');
    });

    it('detects generally decreasing scores with noise as degrading', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.9, 0.85, 0.88, 0.75, 0.6]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.direction).toBe('degrading');
    });

    it('has negative deltaPerWave for degrading', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.9, 0.7, 0.5]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.deltaPerWave).toBeLessThan(-0.01);
    });

    it('deltaPerWave approximates -0.1 for linear -0.1/run', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.9, 0.8, 0.7, 0.6, 0.5]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.deltaPerWave).toBeCloseTo(-0.1, 5);
    });
  });

  // ── Exactly 3 runs threshold ─────────────────────────

  describe('exactly 3 runs (minimum for analysis)', () => {
    it('computes a trend with exactly 3 runs', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.5, 0.6, 0.7]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.direction).not.toBe('insufficient_data');
      expect(result.runs).toHaveLength(3);
    });

    it('can detect stable with exactly 3 runs', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.8, 0.8, 0.8]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.direction).toBe('stable');
    });

    it('can detect improving with exactly 3 runs', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.3, 0.5, 0.7]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.direction).toBe('improving');
    });

    it('can detect degrading with exactly 3 runs', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.9, 0.7, 0.5]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.direction).toBe('degrading');
    });
  });

  // ── Window size ──────────────────────────────────────

  describe('windowSize', () => {
    it('respects windowSize — only uses last N runs', async () => {
      // 7 runs: first 4 degrading, last 3 improving
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.9, 0.8, 0.7, 0.6, 0.7, 0.8, 0.9]);
      const result = await trendStore.trend('suite-1', 'target-1', 3);
      expect(result.direction).toBe('improving');
      expect(result.runs).toHaveLength(3);
    });

    it('uses all runs when windowSize exceeds total runs', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.5, 0.6, 0.7]);
      const result = await trendStore.trend('suite-1', 'target-1', 10);
      expect(result.runs).toHaveLength(3);
      expect(result.direction).toBe('improving');
    });

    it('default windowSize is 5', async () => {
      // 8 runs — default window=5 should use only last 5
      await seedStore(memoryStore, 'suite-1', 'target-1', [
        0.1, 0.2, 0.3, // early improving runs (should be ignored)
        0.9, 0.9, 0.9, 0.9, 0.9, // last 5 stable
      ]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.runs).toHaveLength(5);
      expect(result.direction).toBe('stable');
    });

    it('windowSize of 3 with degrading tail', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.5, 0.6, 0.7, 0.8, 0.6, 0.4]);
      const result = await trendStore.trend('suite-1', 'target-1', 3);
      expect(result.direction).toBe('degrading');
      expect(result.runs).toHaveLength(3);
    });
  });

  // ── Runs array ───────────────────────────────────────

  describe('runs array in result', () => {
    it('contains the exact records used for analysis', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.5, 0.6, 0.7, 0.8]);
      const result = await trendStore.trend('suite-1', 'target-1', 3);
      expect(result.runs).toHaveLength(3);
      expect(result.runs[0]!.overallScore).toBe(0.6);
      expect(result.runs[1]!.overallScore).toBe(0.7);
      expect(result.runs[2]!.overallScore).toBe(0.8);
    });

    it('preserves full BenchmarkResult in each record', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.5, 0.6, 0.7]);
      const result = await trendStore.trend('suite-1', 'target-1');
      for (const run of result.runs) {
        expect(run.result).toBeDefined();
        expect(run.result.suiteId).toBe('suite-1');
        expect(run.result.scores).toBeDefined();
      }
    });
  });

  // ── Suite + target filtering ─────────────────────────

  describe('suiteId + targetId filtering', () => {
    it('only considers matching suiteId', async () => {
      await seedStore(memoryStore, 'suite-A', 'target-1', [0.5, 0.6, 0.7]);
      await seedStore(memoryStore, 'suite-B', 'target-1', [0.9, 0.8, 0.7]);

      const resultA = await trendStore.trend('suite-A', 'target-1');
      expect(resultA.direction).toBe('improving');

      const resultB = await trendStore.trend('suite-B', 'target-1');
      expect(resultB.direction).toBe('degrading');
    });

    it('only considers matching targetId', async () => {
      await seedStore(memoryStore, 'suite-1', 'model-A', [0.5, 0.6, 0.7]);
      await seedStore(memoryStore, 'suite-1', 'model-B', [0.9, 0.8, 0.7]);

      const resultA = await trendStore.trend('suite-1', 'model-A');
      expect(resultA.direction).toBe('improving');

      const resultB = await trendStore.trend('suite-1', 'model-B');
      expect(resultB.direction).toBe('degrading');
    });

    it('returns insufficient_data for non-existent suiteId', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.5, 0.6, 0.7]);
      const result = await trendStore.trend('non-existent', 'target-1');
      expect(result.direction).toBe('insufficient_data');
    });

    it('returns insufficient_data for non-existent targetId', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.5, 0.6, 0.7]);
      const result = await trendStore.trend('suite-1', 'non-existent');
      expect(result.direction).toBe('insufficient_data');
    });
  });

  // ── Edge cases ───────────────────────────────────────

  describe('edge cases', () => {
    it('handles all zero scores as stable', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [0, 0, 0]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.direction).toBe('stable');
      expect(result.deltaPerWave).toBe(0);
    });

    it('handles all perfect scores as stable', async () => {
      await seedStore(memoryStore, 'suite-1', 'target-1', [1, 1, 1, 1, 1]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.direction).toBe('stable');
    });

    it('handles large number of runs with windowSize', async () => {
      const scores = Array.from({ length: 100 }, (_, i) => 0.5 + i * 0.001);
      await seedStore(memoryStore, 'suite-1', 'target-1', scores);
      const result = await trendStore.trend('suite-1', 'target-1', 5);
      expect(result.runs).toHaveLength(5);
      // Last 5 runs have very small slope, should still be stable (0.001/run < 0.01)
      expect(result.direction).toBe('stable');
    });

    it('borderline slope just above 0.01 is improving', async () => {
      // Slope = 0.015 per run over 3 points: y = 0.5, 0.515, 0.53
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.5, 0.515, 0.53]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.deltaPerWave).toBeGreaterThan(0.01);
      expect(result.direction).toBe('improving');
    });

    it('borderline slope just below -0.01 is degrading', async () => {
      // Slope = -0.015 per run over 3 points: y = 0.53, 0.515, 0.5
      await seedStore(memoryStore, 'suite-1', 'target-1', [0.53, 0.515, 0.5]);
      const result = await trendStore.trend('suite-1', 'target-1');
      expect(result.deltaPerWave).toBeLessThan(-0.01);
      expect(result.direction).toBe('degrading');
    });
  });

  // ── InMemoryBenchmarkRunStore ────────────────────────

  describe('InMemoryBenchmarkRunStore', () => {
    it('appends and lists records', async () => {
      const record = makeRecord('suite-1', 'target-1', 0.8, 0);
      await memoryStore.append(record);
      const records = await memoryStore.list('suite-1', 'target-1');
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual(record);
    });

    it('returns empty array for unknown suite/target', async () => {
      const records = await memoryStore.list('unknown', 'unknown');
      expect(records).toEqual([]);
    });

    it('returns records sorted by timestamp ascending', async () => {
      const r1 = makeRecord('suite-1', 'target-1', 0.5, 2);
      const r2 = makeRecord('suite-1', 'target-1', 0.6, 0);
      const r3 = makeRecord('suite-1', 'target-1', 0.7, 1);
      await memoryStore.append(r1);
      await memoryStore.append(r2);
      await memoryStore.append(r3);

      const records = await memoryStore.list('suite-1', 'target-1');
      expect(records).toHaveLength(3);
      // Sorted by timestamp: r2 (index 0) < r3 (index 1) < r1 (index 2)
      expect(records[0]!.overallScore).toBe(0.6);
      expect(records[1]!.overallScore).toBe(0.7);
      expect(records[2]!.overallScore).toBe(0.5);
    });
  });
});
