/**
 * Per-variant runner for the PromptExperiment harness.
 *
 * Extracted from `prompt-experiment.ts` so the top-level coordinator only
 * deals with cross-variant aggregation, while this module owns the
 * "run a single variant across the whole dataset" workflow.
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { Semaphore } from '@dzupagent/core/utils';

import type { EvalDataset, EvalEntry } from '../dataset/eval-dataset.js';
import type { EvalInput, ScorerResult } from '../types.js';

import { acquireSemaphore, mean } from './prompt-experiment-stats.js';
import type {
  ExperimentConfig,
  CostObservation,
  PromptVariant,
  VariantResult,
  VariantResultEntry,
} from './prompt-experiment-types.js';

/**
 * Extract output text from a LangChain BaseMessage `content` field, which
 * may be a plain string or an array of content blocks.
 */
function extractOutputText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          (block as { type?: unknown }).type === 'text',
      )
      .map((block) => block.text)
      .join('');
  }
  return String(content);
}

/**
 * Run a single prompt variant across the entire dataset.
 *
 * - Concurrency is bounded by the supplied semaphore.
 * - Honours the abort signal between/within entries.
 * - Calls `onProgress` on each completed entry, when configured.
 */
export async function runVariant(
  variant: PromptVariant,
  dataset: EvalDataset,
  config: ExperimentConfig,
  semaphore: Semaphore,
): Promise<VariantResult> {
  const { model, scorers, signal, onProgress } = config;
  const entryResults: VariantResultEntry[] = [];
  const latencies: number[] = [];
  const costs: CostObservation[] = [];
  let completed = 0;

  const promises = dataset.entries.map(async (entry: EvalEntry) => {
    if (signal?.aborted) return;

    const acquired = await acquireSemaphore(semaphore, signal);
    try {
      if (!acquired) return;
      if (signal?.aborted) return;

      // Invoke model
      const invokeStart = Date.now();
      const messages = [
        new SystemMessage(variant.systemPrompt),
        new HumanMessage(entry.input),
      ];
      const response = await model.invoke(messages);
      const latencyMs = Date.now() - invokeStart;
      latencies.push(latencyMs);

      const output = extractOutputText(response.content);

      // Token counts alone are not prices or billing evidence.
      const cost = config.costObservation?.(response, entry);
      if (cost !== undefined) {
        if (!Number.isFinite(cost.costCents) || cost.costCents < 0
          || !['reported', 'estimated'].includes(cost.basis)
          || typeof cost.evidenceRef !== 'string' || !cost.evidenceRef.trim()) {
          throw new Error('Invalid experiment cost observation');
        }
        costs.push(cost);
      }
      const costCents = cost?.costCents;

      // Build eval input and run scorers
      const evalInput: EvalInput = {
        input: entry.input,
        output,
        reference: entry.expectedOutput,
        tags: entry.tags,
        latencyMs,
        costCents,
        metadata: entry.metadata,
      };

      const scorerResults: ScorerResult[] = [];
      for (const scorer of scorers) {
        if (signal?.aborted) break;
        const result = await scorer.score(evalInput);
        scorerResults.push(result);
      }

      if (signal?.aborted) return;

      const aggregateScore =
        scorerResults.length > 0
          ? scorerResults.reduce((sum, sr) => sum + sr.aggregateScore, 0) /
            scorerResults.length
          : 0;

      entryResults.push({
        entryId: entry.id,
        output,
        scorerResults,
        aggregateScore,
        ...(cost === undefined ? {} : { cost }),
      });

      completed++;
      if (onProgress) {
        onProgress(variant.name, completed, dataset.size);
      }
    } finally {
      if (acquired) {
        semaphore.release();
      }
    }
  });

  await Promise.all(promises);

  // Compute variant-level aggregates
  const avgScore =
    entryResults.length > 0
      ? entryResults.reduce((s, e) => s + e.aggregateScore, 0) / entryResults.length
      : 0;

  const passRate =
    entryResults.length > 0
      ? entryResults.filter((e) =>
          e.scorerResults.length > 0 && e.scorerResults.every((sr) => sr.measured !== false && sr.passed),
        ).length / entryResults.length
      : 0;

  const avgLatencyMs = latencies.length > 0 ? mean(latencies) : 0;
  const costState: VariantResult['costState'] = costs.length === 0 ? 'unknown'
    : costs.length !== entryResults.length ? 'partial'
    : costs.some(cost => cost.basis !== costs[0]!.basis) ? 'mixed' : costs[0]!.basis;
  const avgCostCents = costState === 'reported' || costState === 'estimated'
    ? mean(costs.map(cost => cost.costCents)) : null;

  // Per-scorer averages
  const scorerSums = new Map<string, { total: number; count: number }>();
  for (const entry of entryResults) {
    for (const sr of entry.scorerResults) {
      const existing = scorerSums.get(sr.scorerId);
      if (existing) {
        existing.total += sr.aggregateScore;
        existing.count++;
      } else {
        scorerSums.set(sr.scorerId, { total: sr.aggregateScore, count: 1 });
      }
    }
  }
  const scorerAverages: Record<string, number> = {};
  for (const [scorerId, { total, count }] of scorerSums.entries()) {
    scorerAverages[scorerId] = count > 0 ? total / count : 0;
  }

  return {
    variantId: variant.id,
    variantName: variant.name,
    entries: entryResults,
    avgScore,
    passRate,
    avgLatencyMs,
    avgCostCents,
    costState,
    scorerAverages,
  };
}
