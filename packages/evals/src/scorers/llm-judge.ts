/**
 * LLM-as-judge scorer — uses an LLM to evaluate agent outputs.
 */
import { HumanMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { Scorer, EvalInput, EvalResult } from '../types.js'

export interface LLMJudgeConfig {
  /** Unique scorer ID */
  id: string
  /** LLM model to use as judge (preferably cheap/fast) */
  model: BaseChatModel
  /** Evaluation criteria in natural language */
  criteria: string
  /** Optional detailed rubric */
  rubric?: string
  /** Pass threshold (default: 0.7) */
  threshold?: number
}

export function createLLMJudge(config: LLMJudgeConfig): Scorer {
  const threshold = config.threshold ?? 0.7

  return {
    id: config.id,
    type: 'llm',
    threshold,

    async evaluate(input: EvalInput): Promise<EvalResult> {
      const prompt = [
        'Evaluate the following output against these criteria.',
        '',
        `**Criteria:** ${config.criteria}`,
        config.rubric ? `**Rubric:**\n${config.rubric}` : '',
        '',
        `**Input:** ${input.input}`,
        `**Output:** ${input.output}`,
        input.reference ? `**Reference:** ${input.reference}` : '',
        '',
        'Rate on a scale of 0-10 and explain your reasoning.',
        'Respond as JSON: { "score": <number 0-10>, "reasoning": "<string>" }',
      ].filter(Boolean).join('\n')

      try {
        const response = await config.model.invoke([new HumanMessage(prompt)])
        const text = typeof response.content === 'string'
          ? response.content
          : JSON.stringify(response.content)

        // Extract JSON from response (handles markdown code blocks)
        const jsonMatch = text.match(/\{[\s\S]*"score"[\s\S]*\}/)
        if (!jsonMatch) {
          return {
            scorerId: config.id,
            score: 0,
            pass: false,
            reasoning: `Failed to parse judge response: ${text.slice(0, 200)}`,
          }
        }

        const parsed = JSON.parse(jsonMatch[0]) as { score: number; reasoning: string }
        const normalizedScore = Math.max(0, Math.min(1, parsed.score / 10))

        return {
          scorerId: config.id,
          score: normalizedScore,
          pass: normalizedScore >= threshold,
          reasoning: parsed.reasoning,
        }
      } catch (err) {
        return {
          scorerId: config.id,
          score: 0,
          pass: false,
          reasoning: `Judge error: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
  }
}
