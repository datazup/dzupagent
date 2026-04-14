/**
 * PromptOptimizer — LLM-driven prompt rewriting that takes a current prompt +
 * eval failures, generates candidate rewrites, evaluates them, and stores the
 * best version.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { EvalDataset } from '../dataset/eval-dataset.js';
import type { EvalInput, Scorer, ScorerResult } from '../types.js';
import type { PromptVersion, PromptVersionStore } from './prompt-version-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OptimizerConfig {
  /** LLM for generating prompt rewrites */
  metaModel: BaseChatModel;
  /** LLM for generating outputs during eval */
  evalModel: BaseChatModel;
  /** Scorers to evaluate prompt quality */
  scorers: Scorer<EvalInput>[];
  /** Version store for persisting prompts */
  versionStore: PromptVersionStore;
  /** Max candidates to generate per optimization round (default: 3) */
  maxCandidates?: number;
  /** Max optimization rounds (default: 3) */
  maxRounds?: number;
  /** Minimum improvement to accept a new version (default: 0.02) */
  minImprovement?: number;
  /** Abort signal */
  signal?: AbortSignal;
}

export interface OptimizationCandidate {
  content: string;
  avgScore: number;
  passRate: number;
  reasoning: string;
}

export interface OptimizationResult {
  /** Was the prompt improved? */
  improved: boolean;
  /** Original prompt version */
  originalVersion: PromptVersion;
  /** Best prompt version found (may be the original if no improvement) */
  bestVersion: PromptVersion;
  /** Score improvement (best - original) */
  scoreImprovement: number;
  /** All candidates evaluated */
  candidates: OptimizationCandidate[];
  /** Number of rounds executed */
  rounds: number;
  /** Exit reason */
  exitReason: 'improved' | 'no_improvement' | 'max_rounds' | 'aborted' | 'error';
  /** Total duration */
  durationMs: number;
}

interface EvalOutcome {
  avgScore: number;
  passRate: number;
  scorerAverages: Record<string, number>;
  failures: Array<{
    input: string;
    output: string;
    score: number;
    feedback: string;
  }>;
}

// ---------------------------------------------------------------------------
// PromptOptimizer
// ---------------------------------------------------------------------------

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

      let currentOutcome = await this.evaluatePrompt(currentVersion.content, params.dataset);
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
        const failures = this.mergeFailures(currentOutcome.failures, params.failures);
        const metaPrompt = this.buildMetaPrompt(
          currentVersion.content,
          currentOutcome,
          failures,
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

        const responseText = typeof rawResponse.content === 'string'
          ? rawResponse.content
          : Array.isArray(rawResponse.content)
            ? rawResponse.content
                .filter((block): block is { type: 'text'; text: string } =>
                  typeof block === 'object' && block !== null && 'type' in block && block.type === 'text',
                )
                .map((block) => block.text)
                .join('\n')
            : '';

        // 3c. Parse candidates
        const parsedCandidates = this.parseCandidates(responseText);

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

          const outcome = await this.evaluatePrompt(candidate.content, params.dataset);

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
          const newOutcome = await this.evaluatePrompt(bestCandidateContent, params.dataset);

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
  // Private: Evaluation
  // ---------------------------------------------------------------------------

  private async evaluatePrompt(
    systemPrompt: string,
    dataset: EvalDataset,
  ): Promise<EvalOutcome> {
    const entries = [...dataset.entries];
    const scorerTotals: Record<string, { total: number; count: number }> = {};
    let totalScore = 0;
    let passCount = 0;
    const failures: EvalOutcome['failures'] = [];

    for (const entry of entries) {
      if (this.signal?.aborted) break;

      // Generate output using evalModel with the system prompt
      const response = await this.evalModel.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(entry.input),
      ]);

      const output = typeof response.content === 'string'
        ? response.content
        : Array.isArray(response.content)
          ? response.content
              .filter((block): block is { type: 'text'; text: string } =>
                typeof block === 'object' && block !== null && 'type' in block && block.type === 'text',
              )
              .map((block) => block.text)
              .join('\n')
          : '';

      // Score the output
      const evalInput: EvalInput = {
        input: entry.input,
        output,
        reference: entry.expectedOutput,
        tags: entry.tags,
        metadata: entry.metadata,
      };

      const scorerResults: ScorerResult[] = [];
      for (const scorer of this.scorers) {
        if (this.signal?.aborted) break;
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

  // ---------------------------------------------------------------------------
  // Private: Meta-prompt construction
  // ---------------------------------------------------------------------------

  private buildMetaPrompt(
    currentPrompt: string,
    outcome: EvalOutcome,
    failures: EvalOutcome['failures'],
  ): string {
    // Format scorer averages
    const scorerLines = Object.entries(outcome.scorerAverages)
      .map(([name, avg]) => `- ${name}: ${avg.toFixed(3)}`)
      .join('\n');

    // Sort failures by score ascending (worst first), take top 5
    const worstFailures = [...failures]
      .sort((a, b) => a.score - b.score)
      .slice(0, 5);

    const failureLines = worstFailures
      .map(
        (f, i) =>
          `### Failure ${i + 1} (score: ${f.score.toFixed(3)})\n` +
          `**Input:** ${truncate(f.input, 500)}\n` +
          `**Output:** ${truncate(f.output, 500)}\n` +
          `**Feedback:** ${truncate(f.feedback, 300)}`,
      )
      .join('\n\n');

    return (
      `You are a prompt engineering expert. Your task is to improve a system prompt based on evaluation results.\n\n` +
      `## Current System Prompt\n${currentPrompt}\n\n` +
      `## Evaluation Scores\n` +
      `- Overall: ${outcome.avgScore.toFixed(3)}/1.0 (${(outcome.passRate * 100).toFixed(0)}% pass rate)\n` +
      `${scorerLines}\n\n` +
      `## Sample Failures (worst scoring)\n${failureLines}\n\n` +
      `## Instructions\n` +
      `Generate ${this.maxCandidates} improved versions of the system prompt. For each:\n` +
      `1. Identify what went wrong in the failures\n` +
      `2. Add specific instructions to prevent those failure modes\n` +
      `3. Keep what already works well\n` +
      `4. Be concise - don't bloat the prompt unnecessarily\n\n` +
      `Return each candidate as:\n` +
      `### Candidate 1\n` +
      `[reasoning for changes]\n` +
      '```prompt\n' +
      `[the full improved system prompt]\n` +
      '```\n\n' +
      `### Candidate 2\n` +
      `...`
    );
  }

  // ---------------------------------------------------------------------------
  // Private: Parse candidates from LLM response
  // ---------------------------------------------------------------------------

  private parseCandidates(
    response: string,
  ): Array<{ content: string; reasoning: string }> {
    const candidates: Array<{ content: string; reasoning: string }> = [];

    // Split by "### Candidate N" headers
    const candidatePattern = /###\s*Candidate\s*\d+/gi;
    const sections = response.split(candidatePattern).slice(1); // Skip preamble

    for (const section of sections) {
      if (candidates.length >= this.maxCandidates) break;

      // Extract prompt from code block
      const promptMatch = /```(?:prompt)?\s*\n([\s\S]*?)```/i.exec(section);
      if (!promptMatch?.[1]) continue;

      const content = promptMatch[1].trim();
      if (content.length === 0) continue;

      // Everything before the code block is reasoning
      const codeBlockStart = section.indexOf('```');
      const reasoning = codeBlockStart > 0
        ? section.slice(0, codeBlockStart).trim()
        : '';

      candidates.push({ content, reasoning });
    }

    return candidates;
  }

  // ---------------------------------------------------------------------------
  // Private: Helpers
  // ---------------------------------------------------------------------------

  private mergeFailures(
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

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}
