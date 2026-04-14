/**
 * ReflectionLoop --- Drafter/Critic iterative refinement loop.
 *
 * Implements the Reflection Pattern: a drafter LLM generates output,
 * a critic LLM scores it and provides feedback, and the drafter revises
 * based on that feedback. Repeats until quality threshold is met,
 * budget is exhausted, or no improvement is detected.
 *
 * General-purpose --- works for any text generation task (code, prose,
 * analysis, plans). Not specific to code generation.
 *
 * @module self-correction/reflection-loop
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the reflection loop. */
export interface ReflectionConfig {
  /** Max reflection iterations (default: 3). */
  maxIterations: number
  /** Quality threshold to exit early, 0-1 (default: 0.8). */
  qualityThreshold: number
  /** System prompt for the critic (overrides default). */
  criticPrompt?: string
  /** Max cost budget in cents for the entire reflection loop (default: 50). */
  costBudgetCents?: number
}

/** A single iteration's record. */
export interface ReflectionIteration {
  /** 1-based iteration number. */
  iteration: number
  /** Normalized score 0-1 for this iteration's draft. */
  score: number
  /** Feedback from the critic. */
  feedback: string
  /** Character length of the draft at this iteration. */
  draftLength: number
  /** Wall-clock duration in milliseconds. */
  durationMs: number
}

/** Result of the full reflection loop execution. */
export interface ReflectionResult {
  /** Final refined output. */
  finalOutput: string
  /** Number of iterations completed. */
  iterations: number
  /** Per-iteration score history. */
  history: ReflectionIteration[]
  /** Why the loop exited. */
  exitReason: 'quality_met' | 'max_iterations' | 'budget_exhausted' | 'no_improvement' | 'error'
  /** Total duration in milliseconds. */
  totalDurationMs: number
}

/** Score + feedback returned by a scoring function. */
export interface ScoreResult {
  /** Normalized quality score 0-1. */
  score: number
  /** Actionable feedback for the drafter. */
  feedback: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rough chars-per-token ratio for cost estimation. */
const CHARS_PER_TOKEN = 4

/** Default cost per 1K input tokens in cents (Claude Haiku-class). */
const INPUT_COST_PER_1K_CENTS = 0.025

/** Default cost per 1K output tokens in cents (Claude Haiku-class). */
const OUTPUT_COST_PER_1K_CENTS = 0.125

const DEFAULT_CRITIC_PROMPT = `You are an expert reviewer. Evaluate the following output for a given task.

Rate the output on a scale of 0-10 where:
- 0-2: Fundamentally broken or completely off-topic
- 3-4: Major issues that need significant revision
- 5-6: Acceptable but has notable gaps or problems
- 7-8: Good quality with minor issues
- 9-10: Excellent, publication-ready quality

Provide your response in this exact format:
SCORE: <number 0-10>
FEEDBACK: <specific, actionable feedback explaining what to improve>

Be specific about what is wrong and how to fix it. Do not be vague.`

const REVISION_SYSTEM_PROMPT = `You are an expert assistant. You previously generated a draft that received feedback from a reviewer. Revise your output to address ALL feedback points while maintaining the original task requirements.

Do NOT explain what you changed. Just output the improved version directly.`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Estimate token count from character length. */
function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** Estimate cost in cents for a given number of input + output tokens. */
function estimateCostCents(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1000) * INPUT_COST_PER_1K_CENTS +
    (outputTokens / 1000) * OUTPUT_COST_PER_1K_CENTS
  )
}

/** Parse a critic response to extract a numeric score and feedback. */
export function parseCriticResponse(response: string): ScoreResult {
  // Try to extract SCORE: <number> pattern
  const scoreMatch = response.match(/SCORE:\s*(\d+(?:\.\d+)?)/i) // eslint-disable-line security/detect-unsafe-regex
  let rawScore = scoreMatch ? parseFloat(scoreMatch[1]!) : NaN

  // Fallback: look for any standalone number 0-10 near the start
  if (Number.isNaN(rawScore)) {
    const numberMatch = response.match(/\b(\d+(?:\.\d+)?)\s*(?:\/\s*10|out of 10)?\b/) // eslint-disable-line security/detect-unsafe-regex
    rawScore = numberMatch ? parseFloat(numberMatch[1]!) : 5
  }

  // Clamp to 0-10 range, then normalize to 0-1
  rawScore = Math.max(0, Math.min(10, rawScore))
  const normalizedScore = rawScore / 10

  // Extract feedback after "FEEDBACK:" or use the full response
  const feedbackMatch = response.match(/FEEDBACK:\s*([\s\S]*)/i)
  const feedback = feedbackMatch
    ? feedbackMatch[1]!.trim()
    : response.replace(/SCORE:\s*\d+(?:\.\d+)?/i, '').trim() // eslint-disable-line security/detect-unsafe-regex

  return {
    score: normalizedScore,
    feedback: feedback || 'No specific feedback provided.',
  }
}

// ---------------------------------------------------------------------------
// ReflectionLoop
// ---------------------------------------------------------------------------

/**
 * Iterative drafter/critic refinement loop.
 *
 * ```ts
 * const loop = new ReflectionLoop(drafterModel, criticModel, {
 *   maxIterations: 3,
 *   qualityThreshold: 0.8,
 * })
 *
 * const result = await loop.execute('Write a function that sorts an array...')
 * console.log(result.finalOutput)   // refined output
 * console.log(result.exitReason)    // 'quality_met' | 'max_iterations' | ...
 * ```
 */
export class ReflectionLoop {
  private readonly drafter: BaseChatModel
  private readonly critic: BaseChatModel
  private readonly config: ReflectionConfig

  constructor(
    drafter: BaseChatModel,
    critic: BaseChatModel,
    config: Partial<ReflectionConfig> = {},
  ) {
    this.drafter = drafter
    this.critic = critic
    this.config = {
      maxIterations: config.maxIterations ?? 3,
      qualityThreshold: config.qualityThreshold ?? 0.8,
      criticPrompt: config.criticPrompt,
      costBudgetCents: config.costBudgetCents ?? 50,
    }
  }

  /**
   * Run the reflection loop on a task.
   *
   * @param task - The task description / prompt
   * @param initialDraft - Optional pre-existing draft to refine
   * @param scoreFn - Optional external scoring function (bypasses the critic LLM)
   */
  async execute(
    task: string,
    initialDraft?: string,
    scoreFn?: (output: string, task: string) => Promise<ScoreResult>,
  ): Promise<ReflectionResult> {
    const totalStart = Date.now()
    const history: ReflectionIteration[] = []
    let accumulatedCostCents = 0
    let currentDraft = initialDraft ?? ''
    let exitReason: ReflectionResult['exitReason'] = 'max_iterations'

    // Generate initial draft if none provided
    if (!currentDraft) {
      try {
        const draftStart = Date.now()
        const response = await this.drafter.invoke([
          new HumanMessage(task),
        ])
        currentDraft = typeof response.content === 'string'
          ? response.content
          : JSON.stringify(response.content)

        accumulatedCostCents += estimateCostCents(
          estimateTokensFromChars(task.length),
          estimateTokensFromChars(currentDraft.length),
        )

        // Check budget after initial draft
        if (this.isBudgetExceeded(accumulatedCostCents)) {
          return {
            finalOutput: currentDraft,
            iterations: 0,
            history,
            exitReason: 'budget_exhausted',
            totalDurationMs: Date.now() - totalStart,
          }
        }

        // Record timing for the draft generation (not counted as an iteration)
        const _draftDuration = Date.now() - draftStart
        void _draftDuration
      } catch {
        return {
          finalOutput: '',
          iterations: 0,
          history,
          exitReason: 'error',
          totalDurationMs: Date.now() - totalStart,
        }
      }
    }

    let previousScore = -1

    for (let i = 0; i < this.config.maxIterations; i++) {
      const iterStart = Date.now()

      // --- Score the current draft ---
      let scoreResult: ScoreResult
      try {
        scoreResult = scoreFn
          ? await scoreFn(currentDraft, task)
          : await this.scoreDraft(task, currentDraft)
      } catch {
        exitReason = 'error'
        break
      }

      // Estimate scoring cost (critic invocation)
      if (!scoreFn) {
        const criticInputChars = task.length + currentDraft.length + (this.config.criticPrompt ?? DEFAULT_CRITIC_PROMPT).length
        accumulatedCostCents += estimateCostCents(
          estimateTokensFromChars(criticInputChars),
          estimateTokensFromChars(scoreResult.feedback.length + 20), // +20 for "SCORE: X\n"
        )
      }

      const iterDurationMs = Date.now() - iterStart

      history.push({
        iteration: i + 1,
        score: scoreResult.score,
        feedback: scoreResult.feedback,
        draftLength: currentDraft.length,
        durationMs: iterDurationMs,
      })

      // --- Check exit conditions ---

      // Quality met
      if (scoreResult.score >= this.config.qualityThreshold) {
        exitReason = 'quality_met'
        break
      }

      // No improvement (score did not increase from previous iteration)
      if (i > 0 && scoreResult.score <= previousScore) {
        exitReason = 'no_improvement'
        break
      }

      // Budget exhausted
      if (this.isBudgetExceeded(accumulatedCostCents)) {
        exitReason = 'budget_exhausted'
        break
      }

      // Last iteration -- don't revise, just exit
      if (i === this.config.maxIterations - 1) {
        exitReason = 'max_iterations'
        break
      }

      previousScore = scoreResult.score

      // --- Revise the draft ---
      try {
        const revisionStart = Date.now()
        const revised = await this.reviseDraft(task, currentDraft, scoreResult.feedback)
        currentDraft = revised

        const revisionInputChars = task.length + currentDraft.length + scoreResult.feedback.length + REVISION_SYSTEM_PROMPT.length
        accumulatedCostCents += estimateCostCents(
          estimateTokensFromChars(revisionInputChars),
          estimateTokensFromChars(revised.length),
        )

        void revisionStart
      } catch {
        exitReason = 'error'
        break
      }

      // Budget check after revision
      if (this.isBudgetExceeded(accumulatedCostCents)) {
        exitReason = 'budget_exhausted'
        break
      }
    }

    return {
      finalOutput: currentDraft,
      iterations: history.length,
      history,
      exitReason,
      totalDurationMs: Date.now() - totalStart,
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Score a draft using the critic LLM. Parses the response to extract
   * a numeric score and actionable feedback.
   */
  private async scoreDraft(task: string, draft: string): Promise<ScoreResult> {
    const criticSystemPrompt = this.config.criticPrompt ?? DEFAULT_CRITIC_PROMPT

    const response = await this.critic.invoke([
      new SystemMessage(criticSystemPrompt),
      new HumanMessage(
        `## Task\n${task}\n\n## Output to Review\n${draft}`,
      ),
    ])

    const responseText = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content)

    return parseCriticResponse(responseText)
  }

  /**
   * Ask the drafter to revise the current draft based on critic feedback.
   */
  private async reviseDraft(
    task: string,
    currentDraft: string,
    feedback: string,
  ): Promise<string> {
    const response = await this.drafter.invoke([
      new SystemMessage(REVISION_SYSTEM_PROMPT),
      new HumanMessage(
        `## Original Task\n${task}\n\n## Current Draft\n${currentDraft}\n\n## Reviewer Feedback\n${feedback}`,
      ),
    ])

    return typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content)
  }

  /** Check if cost budget has been exceeded. */
  private isBudgetExceeded(accumulatedCents: number): boolean {
    if (this.config.costBudgetCents === undefined) return false
    return accumulatedCents >= this.config.costBudgetCents
  }
}
