/**
 * Lower-level engine helpers for OutputRefinementLoop:
 * model-driven critique/refinement calls and result construction.
 *
 * @module self-correction/output-refinement-engine
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import {
  DOMAIN_CRITIQUE_PROMPTS,
  REFINEMENT_SYSTEM_PROMPT,
  extractText,
  parseCritiqueResponse,
} from './output-refinement-prompts.js'
import type {
  RefinementDomain,
  RefinementIteration,
  RefinementResult,
} from './output-refinement-types.js'

/**
 * Append optional context lines as a `## Additional Context` block on a
 * user message body.
 */
function appendContext(body: string, context?: Record<string, string>): string {
  if (!context || Object.keys(context).length === 0) return body
  const contextLines = Object.entries(context)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join('\n')
  return `${body}\n\n## Additional Context\n${contextLines}`
}

/**
 * Run a domain-aware critique on the output, returning score and feedback.
 */
export async function critiqueAndScore(
  model: BaseChatModel,
  task: string,
  output: string,
  domain: RefinementDomain,
  context?: Record<string, string>,
): Promise<{ score: number; feedback: string }> {
  const systemPrompt = DOMAIN_CRITIQUE_PROMPTS[domain]

  const userContent = appendContext(
    `## Task\n${task}\n\n## Output to Review\n${output}`,
    context,
  )

  const response = await model.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(userContent),
  ])

  const responseText = extractText(response.content as string | Array<{ type: string; text?: string }>)
  return parseCritiqueResponse(responseText)
}

/**
 * Apply refinement based on critique feedback.
 */
export async function applyRefinement(
  model: BaseChatModel,
  task: string,
  currentOutput: string,
  critique: string,
  context?: Record<string, string>,
): Promise<string> {
  const userContent = appendContext(
    `## Original Task\n${task}\n\n## Current Output\n${currentOutput}\n\n## Critique Feedback\n${critique}`,
    context,
  )

  const response = await model.invoke([
    new SystemMessage(REFINEMENT_SYSTEM_PROMPT),
    new HumanMessage(userContent),
  ])

  return extractText(response.content as string | Array<{ type: string; text?: string }>)
}

/**
 * Build a RefinementResult from accumulated state.
 */
export function buildRefinementResult(args: {
  bestOutput: string
  wasRefined: boolean
  bestScore: number
  originalScore: number
  domain: RefinementDomain
  iterations: RefinementIteration[]
  exitReason: RefinementResult['exitReason']
  totalStart: number
  estimatedCostCents: number
}): RefinementResult {
  const {
    bestOutput,
    wasRefined,
    bestScore,
    originalScore,
    domain,
    iterations,
    exitReason,
    totalStart,
    estimatedCostCents,
  } = args
  return {
    bestOutput,
    wasRefined,
    bestScore,
    originalScore,
    totalImprovement: bestScore - originalScore,
    domain,
    iterations,
    exitReason,
    totalDurationMs: Date.now() - totalStart,
    estimatedCostCents: Math.round(estimatedCostCents * 100) / 100,
  }
}
