/**
 * PromptOptimizer evaluator — runs a candidate prompt against a dataset using
 * the eval model and aggregates per-scorer results into an `EvalOutcome`.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

import type { EvalDataset } from '../dataset/eval-dataset.js';
import type { EvalInput, Scorer, ScorerResult } from '../types.js';
import { extractMessageText } from './prompt-optimizer-generator.js';
import type { EvalOutcome } from './prompt-optimizer-types.js';

export interface EvaluatePromptParams {
  systemPrompt: string;
  dataset: EvalDataset;
  evalModel: BaseChatModel;
  scorers: Scorer<EvalInput>[];
  signal?: AbortSignal | undefined;
}

/**
 * Score the given system prompt against every entry in the dataset using
 * the configured eval model and scorer suite.
 */
export async function evaluatePrompt(
  params: EvaluatePromptParams,
): Promise<EvalOutcome> {
  const { systemPrompt, dataset, evalModel, scorers, signal } = params;
  const entries = [...dataset.entries];
  const scorerTotals: Record<string, { total: number; count: number }> = {};
  let totalScore = 0;
  let passCount = 0;
  const failures: EvalOutcome['failures'] = [];

  for (const entry of entries) {
    if (signal?.aborted) break;

    // Generate output using evalModel with the system prompt
    const response = await evalModel.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(entry.input),
    ]);

    const output = extractMessageText(
      response.content as string | Array<unknown>,
    );

    // Score the output
    const evalInput: EvalInput = {
      input: entry.input,
      output,
      reference: entry.expectedOutput,
      tags: entry.tags,
      metadata: entry.metadata,
    };

    const scorerResults: ScorerResult[] = [];
    for (const scorer of scorers) {
      if (signal?.aborted) break;
      const result = await scorer.score(evalInput);
      scorerResults.push(result);

      const scorerId = result.scorerId;
      const existing = scorerTotals[scorerId];
      if (existing) {
        existing.total += result.aggregateScore;
        existing.count++;
      } else {
        scorerTotals[scorerId] = { total: result.aggregateScore, count: 1 };
      }
    }

    const entryScore = scorerResults.length > 0
      ? scorerResults.reduce((sum, sr) => sum + sr.aggregateScore, 0) / scorerResults.length
      : 0;
    const entryPassed = scorerResults.length > 0 && scorerResults.every((sr) => sr.passed);

    totalScore += entryScore;
    if (entryPassed) passCount++;

    if (!entryPassed) {
      const feedback = scorerResults
        .filter((sr) => !sr.passed)
        .flatMap((sr) =>
          sr.scores.map((s) => `${s.criterion}: ${s.score.toFixed(2)} - ${s.reasoning}`),
        )
        .join('; ');

      failures.push({
        input: entry.input,
        output,
        score: entryScore,
        feedback,
      });
    }
  }

  const avgScore = entries.length > 0 ? totalScore / entries.length : 0;
  const passRate = entries.length > 0 ? passCount / entries.length : 0;

  const scorerAverages: Record<string, number> = {};
  for (const [scorerId, { total, count }] of Object.entries(scorerTotals)) {
    scorerAverages[scorerId] = count > 0 ? total / count : 0;
  }

  return { avgScore, passRate, scorerAverages, failures };
}

/**
 * Merge dataset-derived failures with externally supplied failure feedback
 * (e.g. from `run:scored` events). Provided failures get a synthetic
 * score of 0 so they sort to the top of the meta-prompt's worst-failures
 * list.
 */
export function mergeFailures(
  evalFailures: EvalOutcome['failures'],
  providedFailures?: Array<{ input: string; output: string; feedback: string }>,
): EvalOutcome['failures'] {
  const merged = [...evalFailures];

  if (providedFailures) {
    for (const f of providedFailures) {
      merged.push({
        input: f.input,
        output: f.output,
        score: 0,
        feedback: f.feedback,
      });
    }
  }

  return merged;
}
