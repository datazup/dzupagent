/**
 * SelfCorrectingNode --- wraps a pipeline NodeExecutor with iterative
 * self-correction using ReflectionLoop and AdaptiveIterationController.
 *
 * The wrapped executor runs the original node, then evaluates and refines
 * the output through a drafter/critic loop until quality targets are met
 * or budgets are exhausted.
 *
 * General-purpose --- works for any pipeline node, not specific to code generation.
 *
 * @module self-correction/self-correcting-node
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { PipelineNode } from '@forgeagent/core'

import type { NodeExecutor, NodeResult, NodeExecutionContext } from '../pipeline/pipeline-runtime-types.js'
import { ReflectionLoop } from './reflection-loop.js'
import type { ScoreResult } from './reflection-loop.js'
import { AdaptiveIterationController } from './iteration-controller.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the self-correcting node wrapper. */
export interface SelfCorrectingConfig {
  /** Critic model for evaluating node outputs */
  critic: BaseChatModel
  /** Target quality score (0-1, default: 0.8) */
  qualityThreshold?: number
  /** Max refinement iterations (default: 3) */
  maxIterations?: number
  /** Max cost for refinement in cents (default: 50) */
  costBudgetCents?: number
  /** Custom scoring function (overrides critic LLM scoring) */
  scoreFn?: (output: string, task: string) => Promise<{ score: number; feedback: string }>
  /** Optional prompt for what to evaluate */
  evaluationCriteria?: string
  /** Minimum score improvement per iteration (default: 0.02) */
  minImprovement?: number
}

/** Extended NodeResult with self-correction metadata. */
export interface SelfCorrectingResult extends NodeResult {
  /** Number of refinement iterations used */
  refinementIterations: number
  /** Score history across iterations */
  scoreHistory: number[]
  /** Why refinement stopped */
  exitReason: string
  /** Total refinement cost in cents */
  refinementCostCents: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rough chars-per-token ratio for cost estimation. */
const CHARS_PER_TOKEN = 4

/** Default cost per 1K input tokens in cents (Haiku-class). */
const INPUT_COST_PER_1K_CENTS = 0.025

/** Default cost per 1K output tokens in cents (Haiku-class). */
const OUTPUT_COST_PER_1K_CENTS = 0.125

function estimateCostCents(inputChars: number, outputChars: number): number {
  const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN)
  const outputTokens = Math.ceil(outputChars / CHARS_PER_TOKEN)
  return (inputTokens / 1000) * INPUT_COST_PER_1K_CENTS + (outputTokens / 1000) * OUTPUT_COST_PER_1K_CENTS
}

/** Convert an arbitrary output value to a string. */
function outputToString(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === null || output === undefined) return ''
  return JSON.stringify(output)
}

// ---------------------------------------------------------------------------
// createSelfCorrectingExecutor
// ---------------------------------------------------------------------------

/**
 * Wraps a NodeExecutor to add iterative self-correction.
 *
 * The wrapped executor:
 * 1. Runs the original executor to get initial output
 * 2. If the result has an error, returns immediately (no refinement on errors)
 * 3. Scores the output via critic or custom scoreFn
 * 4. If below threshold, uses ReflectionLoop for iterative refinement
 * 5. Uses AdaptiveIterationController to monitor cost/improvement trends
 * 6. Returns the result with refinement metadata
 *
 * @param originalExecutor - The node executor to wrap
 * @param drafter - LLM used for revising the output
 * @param config - Self-correction configuration
 * @returns A new NodeExecutor with self-correction behavior
 */
export function createSelfCorrectingExecutor(
  originalExecutor: NodeExecutor,
  drafter: BaseChatModel,
  config: SelfCorrectingConfig,
): NodeExecutor {
  const qualityThreshold = config.qualityThreshold ?? 0.8
  const maxIterations = config.maxIterations ?? 3
  const costBudgetCents = config.costBudgetCents ?? 50
  const minImprovement = config.minImprovement ?? 0.02

  return async (
    nodeId: string,
    node: PipelineNode,
    context: NodeExecutionContext,
  ): Promise<SelfCorrectingResult> => {
    const startTime = Date.now()

    // Step 1: Run the original executor
    const initialResult = await originalExecutor(nodeId, node, context)

    // Step 2: If error, return immediately without refinement
    if (initialResult.error) {
      return {
        ...initialResult,
        refinementIterations: 0,
        scoreHistory: [],
        exitReason: 'error_passthrough',
        refinementCostCents: 0,
      }
    }

    const initialOutput = outputToString(initialResult.output)

    // If there is no output to refine, return as-is
    if (!initialOutput) {
      return {
        ...initialResult,
        refinementIterations: 0,
        scoreHistory: [],
        exitReason: 'empty_output',
        refinementCostCents: 0,
      }
    }

    // Step 3: Build the task description from node metadata
    const taskDescription = config.evaluationCriteria
      ?? node.description
      ?? node.name
      ?? nodeId

    // Step 4: Create the AdaptiveIterationController for monitoring
    const controller = new AdaptiveIterationController({
      targetScore: qualityThreshold,
      maxIterations,
      costBudgetCents,
      minImprovement,
    })

    // Step 5: Build a scoreFn that integrates the controller
    // We wrap the user-provided scoreFn (or default critic) and feed decisions
    // through the controller for cost/improvement tracking.
    const wrappedScoreFn = config.scoreFn
      ? async (output: string, task: string): Promise<ScoreResult> => {
          const raw = await config.scoreFn!(output, task)
          return { score: raw.score, feedback: raw.feedback }
        }
      : undefined

    // Step 6: Create and run the ReflectionLoop
    const reflectionLoop = new ReflectionLoop(drafter, config.critic, {
      maxIterations,
      qualityThreshold,
      criticPrompt: config.evaluationCriteria
        ? `You are an expert reviewer. Evaluate the following output against these criteria:\n\n${config.evaluationCriteria}\n\nRate on a scale of 0-10.\n\nProvide your response in this exact format:\nSCORE: <number 0-10>\nFEEDBACK: <specific, actionable feedback>`
        : undefined,
      costBudgetCents,
    })

    const reflectionResult = await reflectionLoop.execute(
      taskDescription,
      initialOutput,
      wrappedScoreFn,
    )

    // Step 7: Feed iteration results into the controller for metadata
    // (retrospective — we use controller.decide for each iteration to get
    // the final state and score history tracking)
    for (const iteration of reflectionResult.history) {
      const iterCost = estimateCostCents(
        taskDescription.length + iteration.draftLength,
        iteration.feedback.length,
      )
      controller.decide(iteration.score, iterCost)
    }

    const totalDurationMs = Date.now() - startTime

    // Step 8: Build the enhanced result
    return {
      nodeId: initialResult.nodeId,
      output: reflectionResult.finalOutput,
      durationMs: totalDurationMs,
      refinementIterations: reflectionResult.iterations,
      scoreHistory: reflectionResult.history.map((h) => h.score),
      exitReason: reflectionResult.exitReason,
      refinementCostCents: controller.totalCostCents,
    }
  }
}
