/**
 * PromptOptimizer persistence — owns the optimization loop, version-store
 * interactions, and the `OptimizationResult` builder.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createHash } from 'node:crypto';

import type { EvalDataset } from '../dataset/eval-dataset.js';
import type { EvalInput, Scorer } from '../types.js';
import { evaluatePrompt, mergeFailures } from './prompt-optimizer-evaluator.js';
import { buildMetaPrompt, extractMessageText, parseCandidates } from './prompt-optimizer-generator.js';
import type { CandidateValidationResult, EvalOutcome, OptimizationCandidate, OptimizationResult, OptimizerConfig } from './prompt-optimizer-types.js';
import type { PromptVersion, PromptVersionStore } from './prompt-version-store.js';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const datasetDigest = (dataset: EvalDataset): string => digest(JSON.stringify(dataset.entries.map(
  (entry) => [entry.id, entry.input, entry.expectedOutput ?? null],
)));
function validateDataset(dataset: EvalDataset): void {
  if (!dataset.entries.length || dataset.size !== dataset.entries.length
    || dataset.entries.some(entry => !entry.id || !entry.input)
    || new Set(dataset.entries.map(entry => entry.id)).size !== dataset.size) {
    throw new Error('A nonempty dataset with unique case identities is required');
  }
}

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
    if (![this.maxCandidates, this.maxRounds].every(value => Number.isInteger(value) && value >= 1 && value <= 10)
      || !Number.isFinite(this.minImprovement) || this.minImprovement < 0 || this.minImprovement > 1
      || !this.scorers.length) throw new Error('Bounded optimization settings and at least one scorer are required');
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
    let originalVersion: PromptVersion | null = null;
    let latestVersion: PromptVersion | null = null;
    validateDataset(params.dataset);

    try {
      // 1. Load current active prompt from versionStore
      let currentVersion = await this.versionStore.getActive(params.promptKey);

      if (!currentVersion) {
        throw new Error(
          `No active prompt version found for key "${params.promptKey}". ` +
          'Save an initial version before optimizing.',
        );
      }

      originalVersion = currentVersion;
      latestVersion = currentVersion;

      // 2. Run baseline eval
      if (this.signal?.aborted) {
        return this.buildResult(originalVersion, currentVersion, allCandidates, rounds, 'aborted', startTime);
      }

      let currentOutcome = await this.runEval(currentVersion.content, params.dataset);
      let currentScore = currentOutcome.avgScore;

      // Baseline rescoring is local evidence, never a new active prompt version.
      originalVersion = { ...originalVersion, evalScores: {
        avgScore: currentOutcome.avgScore, passRate: currentOutcome.passRate,
        scorerAverages: currentOutcome.scorerAverages, datasetSize: params.dataset.size,
      } };
      currentVersion = originalVersion;
      latestVersion = currentVersion;

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
          if (this.signal?.aborted) {
            return this.buildResult(originalVersion, currentVersion, allCandidates, rounds, 'aborted', startTime);
          }
          if (newOutcome.avgScore - currentScore < this.minImprovement || newOutcome.passRate < currentOutcome.passRate) {
            return this.buildResult(originalVersion, currentVersion, allCandidates, rounds, 'no_improvement', startTime);
          }
          const active = await this.versionStore.getActive(params.promptKey);
          if (!active || active.id !== originalVersion.id || active.content !== originalVersion.content) {
            throw new Error('Active prompt changed while preparing a candidate');
          }

          const newVersion = await this.versionStore.save({
            promptKey: params.promptKey,
            content: bestCandidateContent,
            parentVersionId: currentVersion.id,
            metadata: {
              optimizationRound: round + 1,
              reasoning: bestCandidateReasoning,
              improvement,
              sourceVersionId: originalVersion.id,
              sourcePromptDigest: digest(originalVersion.content),
              trainingDatasetDigest: datasetDigest(params.dataset),
              trainingInputDigests: [...new Set(params.dataset.entries.map(entry => digest(entry.input)))],
            },
            evalScores: {
              avgScore: newOutcome.avgScore,
              passRate: newOutcome.passRate,
              scorerAverages: newOutcome.scorerAverages,
              datasetSize: params.dataset.size,
            },
            active: false,
          });

          currentVersion = newVersion;
          latestVersion = currentVersion;
          currentOutcome = newOutcome;
          currentScore = newOutcome.avgScore;
          // Continue to next round
        } else {
          // 3f. No improvement -- stop
          return this.buildResult(originalVersion, currentVersion, allCandidates, rounds, 'no_improvement', startTime);
        }
      }

      // Completed all rounds
      const improved = currentVersion.content !== originalVersion.content;
      const exitReason = improved ? 'improved' : 'max_rounds';

      return this.buildResult(originalVersion, currentVersion, allCandidates, rounds, exitReason, startTime);
    } catch (error: unknown) {
      // If we have partial results, return them with error exit reason
      const durationMs = Date.now() - startTime;
      const errMsg = error instanceof Error ? error.message : String(error);

      if (originalVersion && latestVersion) {
        return this.buildResult(originalVersion, latestVersion, allCandidates, rounds, 'error', startTime);
      }

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

  /** Validate an inactive candidate on disjoint held-out inputs; never promote it. */
  async validateCandidate(params: {
    promptKey: string;
    candidateVersionId: string;
    holdoutDataset: EvalDataset;
    minPassRate?: number;
  }): Promise<CandidateValidationResult> {
    validateDataset(params.holdoutDataset);
    const minPassRate = params.minPassRate ?? 1;
    if (!Number.isFinite(minPassRate) || minPassRate < 0 || minPassRate > 1) throw new Error('Invalid held-out pass-rate threshold');
    const candidateVersion = await this.versionStore.getById(params.candidateVersionId);
    const sourceVersion = await this.versionStore.getActive(params.promptKey);
    if (!candidateVersion || candidateVersion.active || candidateVersion.promptKey !== params.promptKey
      || !sourceVersion || candidateVersion.metadata?.sourceVersionId !== sourceVersion.id
      || candidateVersion.metadata?.sourcePromptDigest !== digest(sourceVersion.content)) {
      throw new Error('Candidate is unqualified or its source prompt changed');
    }
    const trainingInputs = candidateVersion.metadata?.trainingInputDigests;
    const trainingDatasetDigest = candidateVersion.metadata?.trainingDatasetDigest;
    if (!Array.isArray(trainingInputs) || !trainingInputs.length
      || trainingInputs.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
      || typeof trainingDatasetDigest !== 'string' || !/^[a-f0-9]{64}$/.test(trainingDatasetDigest)) {
      throw new Error('Candidate is missing training input evidence');
    }
    if (params.holdoutDataset.entries.some(entry => trainingInputs.includes(digest(entry.input)))) {
      throw new Error('Held-out inputs overlap the training dataset');
    }
    const baseline = await this.runEval(sourceVersion.content, params.holdoutDataset);
    const candidate = this.signal?.aborted
      ? { avgScore: 0, passRate: 0, scorerAverages: {}, failures: [] }
      : await this.runEval(candidateVersion.content, params.holdoutDataset);
    const currentSource = await this.versionStore.getActive(params.promptKey);
    const currentCandidate = await this.versionStore.getById(params.candidateVersionId);
    const reason = this.signal?.aborted ? 'aborted'
      : !currentSource || currentSource.id !== sourceVersion.id || currentSource.content !== sourceVersion.content
        || !currentCandidate || currentCandidate.content !== candidateVersion.content || currentCandidate.active ? 'source_changed'
      : candidate.avgScore - baseline.avgScore >= this.minImprovement
        && candidate.passRate >= Math.max(minPassRate, baseline.passRate) ? 'passed' : 'regression';
    return { passed: reason === 'passed', reason, sourceVersionId: sourceVersion.id,
      candidateVersionId: candidateVersion.id, candidatePromptDigest: digest(candidateVersion.content),
      trainingDatasetDigest, holdoutDatasetDigest: datasetDigest(params.holdoutDataset), baseline, candidate };
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

  private buildResult(
    originalVersion: PromptVersion,
    bestVersion: PromptVersion,
    candidates: OptimizationCandidate[],
    rounds: number,
    exitReason: OptimizationResult['exitReason'],
    startTime: number,
  ): OptimizationResult {
    const improved = bestVersion.content !== originalVersion.content;
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
