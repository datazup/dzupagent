/**
 * Public types for the PromptExperiment harness.
 *
 * Extracted from `prompt-experiment.ts` so the runner stays focused on
 * orchestration. Statistical helpers live in `prompt-experiment-stats.ts`,
 * markdown formatting in `prompt-experiment-report.ts`, and per-variant
 * execution in `prompt-experiment-runner.ts`.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import type { EvalInput, Scorer, ScorerResult } from '../types.js';

export interface PromptVariant {
  id: string;
  name: string;
  systemPrompt: string;
  metadata?: Record<string, unknown>;
}

export interface ExperimentConfig {
  /** The LLM model to use for generating outputs */
  model: BaseChatModel;
  /** Scorers to evaluate outputs */
  scorers: Scorer<EvalInput>[];
  /** Max concurrent evaluations (default: 3) */
  concurrency?: number;
  /** Abort signal */
  signal?: AbortSignal;
  /** Progress callback */
  onProgress?: (variant: string, completed: number, total: number) => void;
}

export interface VariantResultEntry {
  entryId: string;
  output: string;
  scorerResults: ScorerResult[];
  aggregateScore: number;
}

export interface VariantResult {
  variantId: string;
  variantName: string;
  /** Per-entry results */
  entries: VariantResultEntry[];
  /** Aggregate metrics */
  avgScore: number;
  passRate: number;
  avgLatencyMs: number;
  avgCostCents: number;
  /** Per-scorer averages */
  scorerAverages: Record<string, number>;
}

export interface PairedComparison {
  variantA: string;
  variantB: string;
  /** Mean difference (A - B), positive means A is better */
  meanDifference: number;
  /** Standard error of the difference */
  standardError: number;
  /** 95% confidence interval [lower, upper] */
  confidenceInterval: [number, number];
  /** Two-tailed p-value (paired t-test) */
  pValue: number;
  /** Is the difference statistically significant at alpha=0.05? */
  significant: boolean;
  /** Winner or 'tie' */
  winner: string | 'tie';
  /** Human-readable summary */
  summary: string;
}

export interface ExperimentReport {
  /** Results per variant */
  variants: VariantResult[];
  /** Pairwise comparisons between all variants */
  comparisons: PairedComparison[];
  /** Overall winner (by highest avg score) */
  bestVariant: string;
  /** Is the winner significantly better than all others? */
  significantWinner: boolean;
  /** Total experiment duration */
  totalDurationMs: number;
  /** Number of entries evaluated per variant */
  datasetSize: number;
  /** Markdown-formatted report */
  toMarkdown(): string;
}
