/**
 * @dzipagent/domain-nl2sql — Ambiguity Detection Tool
 *
 * Uses the LLM (via withStructuredOutput) to detect ambiguous terms
 * in a user query that need clarification before SQL generation.
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import type { NL2SQLToolkitConfig } from '../types/index.js'

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

const AmbiguityOutputSchema = z.object({
  isAmbiguous: z
    .boolean()
    .describe('True if the query contains terms that need clarification'),
  ambiguousTerms: z
    .array(z.string())
    .describe('List of ambiguous terms found in the query'),
  clarificationQuestion: z
    .string()
    .describe(
      'A natural-language question to ask the user for clarification (empty string if not ambiguous)',
    ),
  options: z
    .array(
      z.object({
        label: z.string().describe('Option label'),
        description: z
          .string()
          .optional()
          .describe('Optional description of this option'),
      }),
    )
    .describe('Suggested options for the user to choose from'),
  responseType: z
    .enum(['single_select', 'multi_select', 'free_text'])
    .describe('How the user should respond'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Confidence that this ambiguity would materially affect the SQL'),
})

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You detect ambiguous terms in natural-language queries that could materially change the generated SQL. Your goal is to identify terms where different interpretations would produce different query results.

Common ambiguities to check:
- "revenue" — gross revenue, net revenue, or revenue after returns?
- "active users" — active today, this week, this month, or ever?
- "recent" — last 7 days, 30 days, 90 days?
- "customers" — all customers, paying customers, or active customers?
- "sales" — order count, revenue amount, or units sold?
- Date ranges when not specified — YTD, last quarter, all time?
- Geographic scope when multiple regions exist
- Currency when multiple currencies are in the data

Rules:
1. ONLY flag ambiguity if it would MATERIALLY change the SQL result (different tables, columns, filters, or aggregations).
2. Check the schema first — if a term maps to exactly one column or table, it is NOT ambiguous.
3. Check the glossary first — if a term is defined in the glossary, it is NOT ambiguous.
4. Do NOT flag common SQL patterns that have obvious interpretations.
5. Do NOT flag terms that have standard database interpretations in context.
6. If the query is clear enough to generate correct SQL, set isAmbiguous to false.
7. Keep clarification questions concise and user-friendly.
8. Provide 2-5 options when possible to make clarification easy.`

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDetectAmbiguityTool(
  config: NL2SQLToolkitConfig,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'detect-ambiguity',
    description:
      'Detect ambiguous terms in a query that need user clarification.',
    schema: z.object({
      query: z.string().describe('The user query to check for ambiguity'),
      schema: z
        .string()
        .describe(
          'Database schema context (DDL, table descriptions, or column listings)',
        ),
      glossary: z
        .string()
        .optional()
        .describe('Optional business glossary definitions for domain terms'),
    }),
    func: async ({ query, schema, glossary }) => {
      try {
        const glossarySection = glossary
          ? `\n\nBusiness Glossary:\n${glossary}`
          : '\n\nNo business glossary provided.'

        const prompt = ChatPromptTemplate.fromMessages([
          ['system', SYSTEM_PROMPT],
          [
            'human',
            `Database Schema:\n{schema}${glossarySection}\n\nUser Query: "{query}"\n\nAnalyse the query for ambiguous terms that would change the SQL output.`,
          ],
        ])

        const structuredModel = config.chatModel.withStructuredOutput(
          AmbiguityOutputSchema,
          { name: 'ambiguity_detection' },
        )

        const chain = prompt.pipe(structuredModel)

        const result = await chain.invoke({ query, schema })

        return JSON.stringify({
          isAmbiguous: result.isAmbiguous,
          ambiguousTerms: result.ambiguousTerms,
          clarificationQuestion: result.clarificationQuestion,
          options: result.options,
          responseType: result.responseType,
          confidence: result.confidence,
        })
      } catch (error) {
        return JSON.stringify({
          isAmbiguous: false,
          ambiguousTerms: [],
          clarificationQuestion: '',
          options: [],
          responseType: 'free_text' as const,
          confidence: 0,
        })
      }
    },
  })
}
