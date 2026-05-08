/**
 * PromptOptimizer persistence — owns the optimization loop, version-store
 * interactions, and the `OptimizationResult` builder.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

import type { EvalDataset } from '../dataset/eval-dataset.js';
import type { EvalInput, Scorer } from '../types.js';
import { evaluatePrompt, mergeFailures } from './prompt-optimizer-evaluator.js';
import { buildMetaPrompt, extractMessageText, parseCandidates } from './prompt-optimizer-generator.js';
import type { EvalOutcome, OptimizationCandidate, OptimizationResult, OptimizerConfig } from './prompt-optimizer-types.js';
import type { PromptVersion, PromptVersionStore } from './prompt-version-store.js';

export class PromptOptimizer {
  private readonly metaModel: BaseChatModel;
  private readonly evalModel: BaseChatModel;
  private readonly scorers: Scorer<EvalInput>[];
  private readonly versionStore: PromptVersionStore;
  private readonly maxCandidates: number;
  private readonly maxRounds: number;
  private readonly minImprovement: number;
  private readonly signal?: AbortSignal | undefined;

  constructor(config: OptimizerConfig) {
    this.metaModel = config.metaModel;
    this.evalModel = config.evalModel;
    this.scorers = config.scorers;
    this.versionStore = config.versionStore;
    this.maxCandidates = config.maxCandidates ?? 3;
    this.maxRounds = config.maxRounds ?? 3;
    this.minImprovement = config.minImprovement ?? 0.02;
    this.signal = config.signal;
  }

  /**
   * Optimize a system prompt based on eval results.
   */
  async optimize(params: {
    promptKey: string;
    dataset: EvalDataset;
    failures?: Array<{ input: string; output: string; feedback: string }>;
  }): Promise<OptimizationResult> {
    const startTime = Date.now();
    const allCandidates: OptimizationCandidate[] = [];
    let rounds = 0;

    try {
      // 1. Load current active prompt from versionStore
      let currentVersion = await this.versionStore.getActive(params.promptKey);

      if (!currentVersion) {
        throw new Error(
          `No active prompt version found for key "${params.promptKey}". ` +
          'Save an initial version before optimizing.',
        );
      }

      const originalVersion = currentVersion;

      // 2. Run baseline eval
      if (this.signal?.aborted) {
        return this.buildResult(originalVersion, currentVersion, allCandidates, rounds, 'aborted', startTime);
      }

      let currentOutcome = await this.runEval(currentVersion.content, params.dataset);
      let currentScore = currentOutcome.avgScore;

      // Update baseline version with eval scores if it didn't have them
      if (!currentVersion.evalScores) {
        currentVersion = await this.saveVersionWithScores(
          currentVersion,
          currentOutcome,
          params.dataset.size,
          true,
        );
      }

      // 3. Optimization rounds
      for (let round = 0; round < this.maxRounds; round++) {
        if (this.signal?.aborted) {
          return this.buildResult(originalVersion, currentVersion, allCandidates, rounds, 'aborted', startTime);
        }

        rounds++;

        // 3a. Build meta-prompt with failures
        const failures = mergeFailures(currentOutcome.failures, params.failures);
        const metaPrompt = buildMetaPrompt(
          currentVersion.content,
          currentOutcome,
          failures,
          this.maxCandidates,
        );

        // 3b. Generate candidate rewrites
        if (this.signal?.aborted) {
          return this.buildResult(originalVersion, currentVersion, allCandidates, rounds, 'aborted', startTime);
        }

        const rawResponse = await this.metaModel.invoke([
          new SystemMessage(
            'You are a prompt engineering expert. Follow the instructions precisely and return candidates in the exact format requested.',
          ),
          new HumanMessage(metaPrompt),
        ]);

        const responseText = extractMessageText(
          rawResponse.content as string | Array<unknown>,
        );

        // 3c. Parse candidates
        const parsedCandidates = parseCandidates(responseText, this.maxCandidates);

        if (parsedCandidates.length === 0) {
          return this.buildResult(originalVersion, currentVersion, allCandidates, rounds, 'no_improvement', startTime);
        }

        // 3d. Evaluate each candidate
        let bestCandidateScore = currentScore;
        let bestCandidateContent: string | null = null;
        let bestCandidateReasoning = '';

        for (const candidate of parsedCandidates) {
          if (this.signal?.aborted) {
            return this.buildResult(originalVersion, currentVersion, allCandidates, rounds, 'aborted', startTime);
          }

          const outcome = await this.runEval(candidate.content, params.dataset);

          const evalCandidate: OptimizationCandidate = {
            content: candidate.content,
            avgScore: outcome.avgScore,
            passRate: outcome.passRate,
            reasoning: candidate.reasoning,
          };
          allCandidates.push(evalCandidate);

          if (outcome.avgScore > bestCandidateScore) {
            bestCandidateScore = outcome.avgScore;
            bestCandidateContent = candidate.content;
            bestCandidateReasoning = candidate.reasoning;
          }
        }

        // 3e. Check if best candidate beats current by >= minImprovement
        const improvement = bestCandidateScore - currentScore;

        if (improvement >= this.minImprovement && bestCandidateContent !== null) {
          // Save improved version
          const newOutcome = await this.runEval(bestCandidateContent, params.dataset);

          const newVersion = await this.versionStore.save({
            promptKey: params.promptKey,
            content: bestCandidateContent,
            parentVersionId: currentVersion.id,
            metadata: {
              optimizationRound: round + 1,
              reasoning: bestCandidateReasoning,
              improvement,
            },
            evalScores: {
              avgScore: newOutcome.avgScore,
              passRate: newOutcome.passRate,
              scorerAverages: newOutcome.scorerAverages,
              datasetSize: params.dataset.size,
            },
            active: true,
          });

          currentVersion = newVersion;
          currentOutcome = newOutcome;
          currentScore = newOutcome.avgScore;
          // Continue to next round
        } else {
          // 3f. No improvement -- stop
          return this.buildResult(originalVersion, currentVersion, allCandidates, rounds, 'no_improvement', startTime);
        }
      }

      // Completed all rounds
      const improved = currentVersion.id !== originalVersion.id;
      const exitReason = improved ? 'improved' : 'max_rounds';

      // Activate best version
      await this.versionStore.activate(currentVersion.id);

      return this.buildResult(originalVersion, currentVersion, allCandidates, rounds, exitReason, startTime);
    } catch (error: unknown) {
      // If we have partial results, return them with error exit reason
      const durationMs = Date.now() - startTime;
      const errMsg = error instanceof Error ? error.message : String(error);

      // Re-throw if we can't even load the original version
      if (rounds === 0 && allCandidates.length === 0) {
        throw error;
      }

      // Return partial result on mid-optimization errors
      const fallbackVersion: PromptVersion = {
        id: 'error-fallback',
        promptKey: params.promptKey,
        content: '',
        version: 0,
        createdAt: new Date().toISOString(),
        active: false,
        metadata: { error: errMsg },
      };

      return {
        improved: false,
        originalVersion: fallbackVersion,
        bestVersion: fallbackVersion,
        scoreImprovement: 0,
        candidates: allCandidates,
        rounds,
        exitReason: 'error',
        durationMs,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Eval delegate
  // ---------------------------------------------------------------------------

  private runEval(systemPrompt: string, dataset: EvalDataset): Promise<EvalOutcome> {
    return evaluatePrompt({
      systemPrompt,
      dataset,
      evalModel: this.evalModel,
      scorers: this.scorers,
      signal: this.signal,
    });
  }

  // ---------------------------------------------------------------------------
  // Private: Version persistence helpers
  // ---------------------------------------------------------------------------

  private async saveVersionWithScores(
    version: PromptVersion,
    outcome: EvalOutcome,
    datasetSize: number,
    active: boolean,
  ): Promise<PromptVersion> {
    // We re-save the version with eval scores attached
    return this.versionStore.save({
      promptKey: version.promptKey,
      content: version.content,
      parentVersionId: version.parentVersionId,
      metadata: { ...version.metadata, baselineRescore: true },
      evalScores: {
        avgScore: outcome.avgScore,
        passRate: outcome.passRate,
        scorerAverages: outcome.scorerAverages,
        datasetSize,
      },
      active,
    });
  }

  private buildResult(
    originalVersion: PromptVersion,
    bestVersion: PromptVersion,
    candidates: OptimizationCandidate[],
    rounds: number,
    exitReason: OptimizationResult['exitReason'],
    startTime: number,
  ): OptimizationResult {
    const improved = bestVersion.id !== originalVersion.id;
    const scoreImprovement =
      bestVersion.evalScores && originalVersion.evalScores
        ? bestVersion.evalScores.avgScore - originalVersion.evalScores.avgScore
        : 0;

    return {
      improved,
      originalVersion,
      bestVersion,
      scoreImprovement,
      candidates,
      rounds,
      exitReason: improved && exitReason !== 'aborted' && exitReason !== 'error'
        ? 'improved'
        : exitReason,
      durationMs: Date.now() - startTime,
    };
  }
}
