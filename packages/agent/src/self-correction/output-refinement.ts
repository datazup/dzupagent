/**
 * OutputRefinementLoop --- Domain-aware post-generation polishing module.
 *
 * Runs a domain-aware critique, applies targeted refinements, verifies no
 * regressions, then returns the best of original vs refined. Domain-aware,
 * regression-safe, budget-conscious, non-destructive. General-purpose.
 *
 * @module self-correction/output-refinement
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { omitUndefined } from '../utils/exact-optional.js'
import {
  applyRefinement,
  buildRefinementResult,
  critiqueAndScore,
} from './output-refinement-engine.js'
import {
  DOMAIN_CRITIQUE_PROMPTS,
  REFINEMENT_SYSTEM_PROMPT,
  detectRefinementDomain,
  estimateCostCents,
  estimateTokens,
} from './output-refinement-prompts.js'
import type {
  RefinementConfig,
  RefinementDomain,
  RefinementIteration,
  RefinementResult,
  ScoreFn,
} from './output-refinement-types.js'

export type {
  RefinementConfig,
  RefinementDomain,
  RefinementIteration,
  RefinementResult,
  ScoreFn,
} from './output-refinement-types.js'

// ---------------------------------------------------------------------------
// OutputRefinementLoop
// ---------------------------------------------------------------------------

/** Domain-aware post-generation polishing loop. */
export class OutputRefinementLoop {
  private readonly model: BaseChatModel
  private readonly config: RefinementConfig

  constructor(
    model: BaseChatModel,
    config?: Partial<RefinementConfig>,
  ) {
    this.model = model
    this.config = omitUndefined({
      maxIterations: config?.maxIterations ?? 2,
      qualityThreshold: config?.qualityThreshold ?? 0.9,
      minImprovement: config?.minImprovement ?? 0.05,
      costBudgetCents: config?.costBudgetCents ?? 20,
      domain: config?.domain,
      convergenceWindow: config?.convergenceWindow,
    })
  }

  /**
   * Refine an output with domain-aware critique.
   */
  async refine(params: {
    task: string
    output: string
    /** Optional scoring function (defaults to model self-eval). */
    scoreFn?: ScoreFn
    /** Optional domain override. */
    domain?: RefinementDomain
    /** Optional context for enrichment. */
    context?: Record<string, string>
  }): Promise<RefinementResult> {
    const totalStart = Date.now()
    const iterations: RefinementIteration[] = []
    let accumulatedCostCents = 0

    const domain = params.domain ?? this.config.domain ?? OutputRefinementLoop.detectDomain(params.task, params.output)
    let bestOutput = params.output
    let bestScore = 0
    let exitReason: RefinementResult['exitReason'] = 'max_iterations'

    const scoreOutput = (output: string) =>
      params.scoreFn
        ? params.scoreFn(output, params.task)
        : critiqueAndScore(this.model, params.task, output, domain, params.context)

    const accumulateCritiqueCost = (output: string, feedback: string): void => {
      if (params.scoreFn) return
      const totalChars = params.task.length + output.length + DOMAIN_CRITIQUE_PROMPTS[domain].length + feedback.length
      accumulatedCostCents += estimateCostCents(estimateTokens(totalChars))
    }

    const finish = (reason: RefinementResult['exitReason'], wasRefined: boolean) =>
      buildRefinementResult({
        bestOutput,
        wasRefined,
        bestScore,
        originalScore,
        domain,
        iterations,
        exitReason: reason,
        totalStart,
        estimatedCostCents: accumulatedCostCents,
      })

    // --- Score the original output ---
    let originalScore: number
    try {
      const scoreResult = await scoreOutput(params.output)
      originalScore = scoreResult.score
      bestScore = originalScore
      accumulateCritiqueCost(params.output, scoreResult.feedback)
    } catch {
      originalScore = 0
      return finish('error', false)
    }

    if (originalScore >= this.config.qualityThreshold) {
      return finish('quality_met', false)
    }

    // --- Refinement iterations ---
    let plateauCount = 0
    for (let i = 0; i < this.config.maxIterations; i++) {
      const iterStart = Date.now()

      if (accumulatedCostCents >= this.config.costBudgetCents) {
        exitReason = 'budget_exhausted'
        break
      }

      // Step 1: Critique current best
      let critique: string
      try {
        const critiqueResult = await scoreOutput(bestOutput)
        critique = critiqueResult.feedback
        accumulateCritiqueCost(bestOutput, critique)
      } catch {
        exitReason = 'error'
        break
      }

      // Step 2: Refine
      let refinedOutput: string
      try {
        refinedOutput = await applyRefinement(this.model, params.task, bestOutput, critique, params.context)
        const refinementChars = params.task.length + bestOutput.length + critique.length + REFINEMENT_SYSTEM_PROMPT.length + refinedOutput.length
        accumulatedCostCents += estimateCostCents(estimateTokens(refinementChars))
      } catch {
        exitReason = 'error'
        break
      }

      // Step 3: Score refined
      let refinedScore: number
      try {
        const refinedResult = await scoreOutput(refinedOutput)
        refinedScore = refinedResult.score
        accumulateCritiqueCost(refinedOutput, refinedResult.feedback)
      } catch {
        exitReason = 'error'
        break
      }

      const improvement = refinedScore - bestScore
      const accepted = improvement >= this.config.minImprovement

      iterations.push({
        iteration: i + 1,
        domain,
        critique,
        refinedOutput,
        originalScore: bestScore,
        refinedScore,
        improvement,
        accepted,
        durationMs: Date.now() - iterStart,
      })

      // Step 4: Evaluate

      if (refinedScore < bestScore) {
        exitReason = 'regression_detected'
        break
      }

      if (improvement < this.config.minImprovement) {
        exitReason = 'no_improvement'
        break
      }

      // Convergence plateau detection
      const convergenceWindow = this.config.convergenceWindow ?? 0
      if (convergenceWindow > 0) {
        const PLATEAU_THRESHOLD = this.config.minImprovement * 2
        if (improvement < PLATEAU_THRESHOLD) {
          plateauCount++
          if (plateauCount >= convergenceWindow) {
            exitReason = 'convergence'
            break
          }
        } else {
          plateauCount = 0
        }
      }

      // Accept refinement
      bestOutput = refinedOutput
      bestScore = refinedScore

      if (bestScore >= this.config.qualityThreshold) {
        exitReason = 'quality_met'
        break
      }

      if (accumulatedCostCents >= this.config.costBudgetCents) {
        exitReason = 'budget_exhausted'
        break
      }
    }

    const wasRefined = iterations.some(iter => iter.accepted)
    return finish(exitReason, wasRefined)
  }

  /**
   * Auto-detect domain from task and output content.
   * Delegates to {@link detectRefinementDomain}.
   */
  static detectDomain(task: string, output: string): RefinementDomain {
    return detectRefinementDomain(task, output)
  }
}
