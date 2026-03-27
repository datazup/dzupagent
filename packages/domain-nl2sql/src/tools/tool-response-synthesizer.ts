/**
 * Response Synthesizer Tool — generates natural language explanations
 * of SQL query results.
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { NL2SQLToolkitConfig } from '../types/index.js'

const SynthesisOutputSchema = z.object({
  response: z.string(),
  structuredExplanation: z
    .object({
      summary: z.string(),
      tableExplanations: z.array(
        z.object({
          table: z.string(),
          purpose: z.string(),
        }),
      ),
      filterExplanations: z.array(
        z.object({
          filter: z.string(),
          meaning: z.string(),
        }),
      ),
      joinExplanations: z.array(
        z.object({
          join: z.string(),
          purpose: z.string(),
        }),
      ),
    })
    .optional(),
})

type SynthesisOutput = z.infer<typeof SynthesisOutputSchema>

const BASE_SYSTEM_PROMPT = `You are an expert data analyst who explains SQL query results in clear, natural language.

Given:
- The user's original question
- The SQL query that was executed
- The query results (as JSON)

Generate a helpful summary that:
1. Directly answers the user's question.
2. Highlights key findings and patterns in the data.
3. Formats numbers readably (e.g., "$1,234,567" not "1234567", "45.2%" not "0.452").
4. Mentions notable outliers or interesting data points.
5. Keeps the explanation concise but informative (2-4 sentences for simple results, more for complex ones).

Do NOT just describe the SQL query — focus on what the data tells us.`

const STRUCTURED_EXPLANATION_ADDENDUM = `

Additionally, generate a "structuredExplanation" object that breaks down the SQL query:
- summary: A one-sentence overview of what the query does.
- tableExplanations: For each table used, explain its purpose in the query.
- filterExplanations: For each WHERE/HAVING condition, explain what it filters.
- joinExplanations: For each JOIN, explain why these tables are connected.`

/**
 * Creates a tool that generates natural language explanations of SQL
 * query results, optionally with structured query breakdowns.
 */
export function createResponseSynthesizerTool(
  config: NL2SQLToolkitConfig,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'synthesize-response',
    description:
      'Generate a natural language explanation of SQL query results.',
    schema: z.object({
      query: z.string().describe('The original natural language question'),
      sql: z.string().describe('The SQL query that was executed'),
      result: z.string().describe('JSON string of QueryResultData'),
      includeStructuredExplanation: z
        .boolean()
        .optional()
        .describe('Whether to include a structured breakdown of the SQL query'),
    }),
    func: async (input) => {
      try {
        const systemPrompt = input.includeStructuredExplanation
          ? BASE_SYSTEM_PROMPT + STRUCTURED_EXPLANATION_ADDENDUM
          : BASE_SYSTEM_PROMPT

        const structuredModel = config.chatModel.withStructuredOutput(SynthesisOutputSchema)

        // Truncate very large result sets to stay within context limits
        let resultText = input.result
        const MAX_RESULT_CHARS = 8000
        if (resultText.length > MAX_RESULT_CHARS) {
          resultText = resultText.slice(0, MAX_RESULT_CHARS) + '\n... (truncated)'
        }

        const result: SynthesisOutput = await structuredModel.invoke([
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Question: ${input.query}\n\nSQL Query:\n${input.sql}\n\nResults:\n${resultText}`,
          },
        ])

        // Strip structuredExplanation if not requested
        if (!input.includeStructuredExplanation) {
          return JSON.stringify({ response: result.response })
        }

        return JSON.stringify(result)
      } catch (err: unknown) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
          response: 'Unable to generate a summary of the results.',
        })
      }
    },
  })
}
