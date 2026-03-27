/**
 * @dzipagent/domain-nl2sql — Relevance Classification Tool
 *
 * Uses the LLM (via withStructuredOutput) to determine whether a user
 * query is a data question answerable with SQL.
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import type { NL2SQLToolkitConfig } from '../types/index.js'

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

const RelevanceOutputSchema = z.object({
  isRelevant: z
    .boolean()
    .describe('True if the query is a data question answerable with SQL'),
  reasoning: z
    .string()
    .describe('Brief explanation for the classification decision'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Confidence score between 0 and 1'),
})

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You classify whether a user query is a data question answerable with SQL.

Data questions include queries about:
- Counts, totals, sums, averages, and other aggregations
- Trends over time (growth, decline, changes)
- Comparisons between entities or time periods
- Specific record lookups or filtering
- Rankings, top-N, distributions
- Joins across related data

Non-data queries include:
- Greetings and casual conversation ("hello", "how are you")
- Help requests about the system ("how do I use this?")
- General knowledge questions ("what is GDP?")
- Code generation requests ("write a Python script")
- Opinions or subjective questions
- Instructions or commands ("send an email")

Be generous with classification — if a query could plausibly be answered with a database query, classify it as relevant.`

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createClassifyRelevanceTool(
  config: NL2SQLToolkitConfig,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'classify-relevance',
    description:
      'Classify if a user query is a data question answerable with SQL.',
    schema: z.object({
      query: z.string().describe('The user query to classify'),
      availableTables: z
        .array(z.string())
        .optional()
        .describe('Optional list of available table names for context'),
    }),
    func: async ({ query, availableTables }) => {
      try {
        const tableContext =
          availableTables && availableTables.length > 0
            ? `\n\nAvailable database tables: ${availableTables.join(', ')}`
            : ''

        const prompt = ChatPromptTemplate.fromMessages([
          ['system', SYSTEM_PROMPT + tableContext],
          [
            'human',
            'Classify this query: "{query}"',
          ],
        ])

        const structuredModel = config.chatModel.withStructuredOutput(
          RelevanceOutputSchema,
          { name: 'relevance_classification' },
        )

        const chain = prompt.pipe(structuredModel)

        const result = await chain.invoke({ query })

        return JSON.stringify({
          isRelevant: result.isRelevant,
          reasoning: result.reasoning,
          confidence: result.confidence,
        })
      } catch (error) {
        return JSON.stringify({
          isRelevant: false,
          reasoning: `Classification error: ${error instanceof Error ? error.message : String(error)}`,
          confidence: 0,
        })
      }
    },
  })
}
