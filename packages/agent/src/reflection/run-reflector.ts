/**
 * RunReflector — hybrid heuristic + optional LLM scoring of agent run quality.
 *
 * By default, pure heuristic analysis with zero LLM overhead.
 * When configured with an LLM function, can enhance scoring with
 * LLM-powered reflection (always or only when heuristic score is low).
 * Designed to run on every single agent run without measurable latency impact
 * in heuristic-only mode.
 *
 * This module is the thin composition root; the per-concern logic lives in
 * leaf modules under `./run-reflector/` (constants, text helpers, heuristic
 * scorers, and LLM reflection).
 */

import { VERY_FAST_MS, WEIGHTS } from "./run-reflector/constants.js";
import {
  scoreCoherence,
  scoreCompleteness,
  scoreConciseness,
  scoreReliability,
  scoreToolSuccess,
} from "./run-reflector/heuristic-scorers.js";
import {
  buildLlmPrompt,
  mergeScores,
  parseLlmResponse,
} from "./run-reflector/llm-reflection.js";
import { clamp01, stringify } from "./run-reflector/text-helpers.js";
import type {
  LlmReflectionResult,
  ReflectionDimensions,
  ReflectionInput,
  ReflectionScore,
  ReflectorConfig,
} from "./run-reflector/types.js";

export type {
  ReflectionDimensions,
  ReflectionInput,
  ReflectionScore,
  ReflectorConfig,
} from "./run-reflector/types.js";

/**
 * Scores the quality of an agent run using lightweight heuristics,
 * optionally enhanced with LLM-powered reflection.
 *
 * Stateless — each call to `score()` is independent.
 *
 * ```ts
 * // Heuristic-only (default, zero LLM overhead)
 * const reflector = new RunReflector()
 * const score = await reflector.score({
 *   input: 'Summarize the document',
 *   output: 'Here is the summary...',
 *   toolCalls: [{ name: 'readFile', success: true, durationMs: 120 }],
 *   durationMs: 3200,
 * })
 *
 * // With LLM reflection on low scores
 * const reflectorWithLlm = new RunReflector({
 *   llm: (prompt) => callMyModel(prompt),
 *   llmMode: 'on-low-score',
 *   llmThreshold: 0.6,
 * })
 * ```
 */
export class RunReflector {
  private readonly config: ReflectorConfig | undefined;

  constructor(config?: ReflectorConfig) {
    this.config = config;
  }

  /**
   * Score a completed agent run.
   *
   * Computes heuristic scores first; optionally enhances with LLM scoring
   * based on the configured mode.
   */
  async score(input: ReflectionInput): Promise<ReflectionScore> {
    const heuristicResult = this.scoreHeuristic(input);

    // If no LLM configured, return heuristic-only
    if (!this.config?.llm) {
      return heuristicResult;
    }

    const mode = this.config.llmMode ?? "on-low-score";
    const threshold = this.config.llmThreshold ?? 0.6;

    // Determine if we should invoke LLM
    const shouldInvokeLlm =
      mode === "always" || heuristicResult.overall < threshold;

    if (!shouldInvokeLlm) {
      return heuristicResult;
    }

    // Invoke LLM reflection and merge results
    try {
      const llmResult = await this.scoreLlm(input);
      return mergeScores(heuristicResult, llmResult);
    } catch {
      // LLM failure: fall back to heuristic with flag
      return {
        ...heuristicResult,
        flags: [...heuristicResult.flags, "llm_reflection_failed"],
      };
    }
  }

  /**
   * Compute heuristic-only score (synchronous, zero LLM overhead).
   */
  scoreHeuristic(input: ReflectionInput): ReflectionScore {
    const flags: string[] = [];

    const inputStr = stringify(input.input);
    const outputStr = stringify(input.output);

    const completeness = scoreCompleteness(inputStr, outputStr, flags);
    const coherence = scoreCoherence(outputStr, flags);
    const toolSuccess = scoreToolSuccess(input.toolCalls, flags);
    const conciseness = scoreConciseness(inputStr, outputStr, flags);
    const reliability = scoreReliability(
      input.errorCount ?? 0,
      input.retryCount ?? 0,
      flags
    );

    // Duration flags (informational, don't affect scores)
    if (input.durationMs < VERY_FAST_MS) {
      flags.push("very_fast");
    }

    const dimensions: ReflectionDimensions = {
      completeness,
      coherence,
      toolSuccess,
      conciseness,
      reliability,
    };

    const overall = clamp01(
      WEIGHTS.completeness * completeness +
        WEIGHTS.coherence * coherence +
        WEIGHTS.toolSuccess * toolSuccess +
        WEIGHTS.conciseness * conciseness +
        WEIGHTS.reliability * reliability
    );

    return { overall, dimensions, flags };
  }

  /**
   * Score using LLM reflection. Throws on failure.
   */
  private async scoreLlm(input: ReflectionInput): Promise<LlmReflectionResult> {
    if (!this.config?.llm) {
      throw new Error(
        "RunReflector: llm is not configured — scoreLlm() called without a configured llm function"
      );
    }
    const llm = this.config.llm;
    const prompt = buildLlmPrompt(input);
    const raw = await llm(prompt);
    const result = parseLlmResponse(raw);
    if (result === null) {
      throw new Error("Failed to parse LLM reflection response");
    }
    return result;
  }
}
