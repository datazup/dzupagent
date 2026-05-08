/**
 * PromptExperiment — A/B testing harness for system prompts.
 *
 * Takes 2+ system prompt variants and a test dataset, runs each variant
 * through an LLM + scorers, and determines which prompt is statistically
 * better via paired t-tests.
 *
 * Composition:
 *   - Public types live in `prompt-experiment-types.ts`
 *   - Statistical helpers live in `prompt-experiment-stats.ts`
 *   - Per-variant execution lives in `prompt-experiment-runner.ts`
 *   - Markdown reporting lives in `prompt-experiment-report.ts`
 *
 * This file re-exports the public types to preserve the original API.
 */

import { Semaphore } from '@dzupagent/core/orchestration';

import type { EvalDataset, EvalEntry } from '../dataset/eval-dataset.js';

import { buildMarkdownReport } from './prompt-experiment-report.js';
import { runVariant } from './prompt-experiment-runner.js';
import {
  normalizeConcurrency,
  pairedTTest,
} from './prompt-experiment-stats.js';
import type {
  ExperimentConfig,
  ExperimentReport,
  PairedComparison,
  PromptVariant,
  VariantResult,
} from './prompt-experiment-types.js';

// Re-export public types for back-compat with the package barrel.
export type {
  ExperimentConfig,
  ExperimentReport,
  PairedComparison,
  PromptVariant,
  VariantResult,
  VariantResultEntry,
} from './prompt-experiment-types.js';

export class PromptExperiment {
  private readonly config: ExperimentConfig;

  constructor(config: ExperimentConfig) {
    this.config = config;
  }

  /**
   * Run the experiment across all variants.
   */
  async run(
    variants: PromptVariant[],
    dataset: EvalDataset,
  ): Promise<ExperimentReport> {
    if (variants.length < 2) {
      throw new Error('PromptExperiment requires at least 2 variants');
    }

    const concurrency = normalizeConcurrency(this.config.concurrency);
    const startTime = Date.now();
    const sem = new Semaphore(concurrency);
    const { signal } = this.config;

    const variantResults: VariantResult[] = [];

    for (const variant of variants) {
      if (signal?.aborted) break;
      const result = await runVariant(variant, dataset, this.config, sem);
      if (signal?.aborted) break;
      variantResults.push(result);
    }

    const comparisons = buildPairwiseComparisons(variantResults, dataset);
    const bestVariantName = pickBestVariantName(variantResults);

    // Check if the winner is significantly better than ALL others
    const significantWinner = comparisons
      .filter((c) => c.winner === bestVariantName)
      .length === variantResults.length - 1;

    const totalDurationMs = Date.now() - startTime;

    const report: ExperimentReport = {
      variants: variantResults,
      comparisons,
      bestVariant: bestVariantName,
      significantWinner,
      totalDurationMs,
      datasetSize: dataset.size,
      toMarkdown() {
        return buildMarkdownReport(this);
      },
    };

    return report;
  }
}

/**
 * Run paired t-tests for every pair of variants. Scores are aligned by
 * `entryId` so missing entries on either side are skipped — this preserves
 * the paired structure even if a variant aborts mid-run.
 */
function buildPairwiseComparisons(
  variantResults: VariantResult[],
  dataset: EvalDataset,
): PairedComparison[] {
  const comparisons: PairedComparison[] = [];
  const entryIdOrder = dataset.entries.map((e: EvalEntry) => e.id);

  for (let i = 0; i < variantResults.length; i++) {
    for (let j = i + 1; j < variantResults.length; j++) {
      const vA = variantResults[i]!;
      const vB = variantResults[j]!;

      const scoresAByEntry = new Map<string, number>();
      const scoresBByEntry = new Map<string, number>();
      for (const e of vA.entries) scoresAByEntry.set(e.entryId, e.aggregateScore);
      for (const e of vB.entries) scoresBByEntry.set(e.entryId, e.aggregateScore);

      const scoresA: number[] = [];
      const scoresB: number[] = [];
      for (const id of entryIdOrder) {
        const a = scoresAByEntry.get(id);
        const b = scoresBByEntry.get(id);
        if (a !== undefined && b !== undefined) {
          scoresA.push(a);
          scoresB.push(b);
        }
      }

      comparisons.push(pairedTTest(scoresA, scoresB, vA.variantName, vB.variantName));
    }
  }

  return comparisons;
}

/** Pick the variant with the highest avg score. Falls back to the first variant. */
function pickBestVariantName(variantResults: VariantResult[]): string {
  let bestName = variantResults[0]?.variantName ?? '';
  let bestAvg = variantResults[0]?.avgScore ?? 0;
  for (const v of variantResults) {
    if (v.avgScore > bestAvg) {
      bestAvg = v.avgScore;
      bestName = v.variantName;
    }
  }
  return bestName;
}
