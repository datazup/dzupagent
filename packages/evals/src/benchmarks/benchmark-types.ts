/**
 * ECO-179: Benchmark Suite Types
 */

import type { EvalEntry } from '../dataset/eval-dataset.js';
import type { ScorerConfig } from '../types.js';

/**
 * Category of benchmark suite.
 */
export type BenchmarkCategory = 'code-gen' | 'qa' | 'tool-use' | 'multi-turn';

/**
 * A benchmark suite defines a set of eval cases, scorers, and baseline thresholds.
 */
export interface BenchmarkSuite {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this benchmark measures */
  description: string;
  /** Category of benchmark */
  category: BenchmarkCategory;
  /** Test cases to evaluate */
  dataset: EvalEntry[];
  /** Scorers to apply to each test case */
  scorers: ScorerConfig[];
  /** Minimum acceptable score per scorer ID */
  baselineThresholds: Record<string, number>;
}

/**
 * Result of running a benchmark suite.
 */
export interface BenchmarkResult {
  /** ID of the suite that was run */
  suiteId: string;
  /** ISO timestamp of when the benchmark was run */
  timestamp: string;
  /** Per-scorer average scores */
  scores: Record<string, number>;
  /** Whether all scores meet baseline thresholds */
  passedBaseline: boolean;
  /** List of scorer IDs that regressed below baseline */
  regressions: string[];
}

/**
 * Comparison between two benchmark runs.
 */
export interface BenchmarkComparison {
  /** Scorers that improved */
  improved: string[];
  /** Scorers that regressed */
  regressed: string[];
  /** Scorers that stayed the same */
  unchanged: string[];
}
