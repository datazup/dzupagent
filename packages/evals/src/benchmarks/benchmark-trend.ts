/**
 * Benchmark Trend Detection — cross-wave trend analysis using linear regression.
 *
 * Wraps a BenchmarkRunStore to compute whether a suite+target combination
 * is improving, degrading, or stable over time.
 */

import type { BenchmarkResult } from './benchmark-types.js';

// ---------------------------------------------------------------------------
// Store abstraction
// ---------------------------------------------------------------------------

/**
 * A single benchmark run record stored for trend analysis.
 */
export interface BenchmarkRunRecord {
  /** Unique run identifier */
  runId: string;
  /** Suite that was benchmarked */
  suiteId: string;
  /** Target (model, prompt variant, etc.) that was benchmarked */
  targetId: string;
  /** ISO timestamp of the run */
  timestamp: string;
  /** Overall score for the run (0..1) */
  overallScore: number;
  /** Full benchmark result for drill-down */
  result: BenchmarkResult;
}

/**
 * Persistence abstraction for benchmark run records.
 * Implementations may use files, databases, or in-memory storage.
 */
export interface BenchmarkRunStore {
  /** Append a run record. */
  append(record: BenchmarkRunRecord): Promise<void>;
  /** List records for a suite+target, ordered by timestamp ascending. */
  list(suiteId: string, targetId: string): Promise<BenchmarkRunRecord[]>;
}

// ---------------------------------------------------------------------------
// Trend result
// ---------------------------------------------------------------------------

export interface BenchmarkTrendResult {
  /** Overall direction of the trend */
  direction: 'improving' | 'degrading' | 'stable' | 'insufficient_data';
  /** Linear regression slope — score change per run */
  deltaPerWave: number;
  /** The run records that were used for the analysis */
  runs: BenchmarkRunRecord[];
}

// ---------------------------------------------------------------------------
// In-memory store (useful for tests and ephemeral usage)
// ---------------------------------------------------------------------------

export class InMemoryBenchmarkRunStore implements BenchmarkRunStore {
  private readonly records: BenchmarkRunRecord[] = [];

  async append(record: BenchmarkRunRecord): Promise<void> {
    this.records.push(record);
  }

  async list(suiteId: string, targetId: string): Promise<BenchmarkRunRecord[]> {
    return this.records
      .filter((r) => r.suiteId === suiteId && r.targetId === targetId)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
}

// ---------------------------------------------------------------------------
// Trend store
// ---------------------------------------------------------------------------

/**
 * Wraps a BenchmarkRunStore to provide cross-wave trend analysis.
 * Uses linear regression over the last N runs' overallScore.
 */
export class BenchmarkTrendStore {
  constructor(private readonly store: BenchmarkRunStore) {}

  /**
   * Compute trend for a suite+target combination over the last windowSize runs.
   * Returns 'insufficient_data' when fewer than 3 runs are available.
   */
  async trend(
    suiteId: string,
    targetId: string,
    windowSize = 5,
  ): Promise<BenchmarkTrendResult> {
    const allRuns = await this.store.list(suiteId, targetId);

    // Take only the last `windowSize` runs
    const runs = allRuns.slice(-windowSize);

    if (runs.length < 3) {
      return {
        direction: 'insufficient_data',
        deltaPerWave: 0,
        runs,
      };
    }

    const slope = linearRegressionSlope(runs.map((r) => r.overallScore));

    let direction: BenchmarkTrendResult['direction'];
    if (slope > 0.01) {
      direction = 'improving';
    } else if (slope < -0.01) {
      direction = 'degrading';
    } else {
      direction = 'stable';
    }

    return {
      direction,
      deltaPerWave: slope,
      runs,
    };
  }
}

// ---------------------------------------------------------------------------
// Linear regression helper
// ---------------------------------------------------------------------------

/**
 * Compute the slope of a simple linear regression where x = index (0, 1, 2, ...)
 * and y = the provided values.
 *
 * slope = (n * Sigma(xy) - Sigma(x) * Sigma(y)) / (n * Sigma(x^2) - (Sigma(x))^2)
 */
function linearRegressionSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    const x = i;
    const y = values[i]!;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;

  return (n * sumXY - sumX * sumY) / denominator;
}
