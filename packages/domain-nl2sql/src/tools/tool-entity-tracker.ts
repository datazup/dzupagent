/**
 * Entity Tracker Tool — analyzes conversation history to extract entities
 * and resolve pronoun references in follow-up questions.
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { NL2SQLToolkitConfig } from '../types/index.js'

const EntitySchema = z.object({
  entities: z.array(
    z.object({
      type: z.enum(['table', 'column', 'filter', 'aggregation', 'value', 'metric']),
      name: z.string(),
      resolvedTo: z.string().optional(),
    }),
  ),
  resolvedQuestion: z.string(),
  hasReferences: z.boolean(),
})

type EntityExtractionResult = z.infer<typeof EntitySchema>

const SYSTEM_PROMPT = `You are an expert at analyzing natural language questions in the context of database conversations.

Your job:
1. Analyze the user's question alongside the conversation history.
2. Identify all entity references: table names, column names, filter values, aggregation operations, metrics, and general values.
3. Resolve any pronoun or implicit references (e.g., "those", "it", "that table", "the same period") by looking at the conversation history.
4. Produce a "resolvedQuestion" — the user's question rewritten with all pronouns and ambiguous references replaced by their concrete referents.
5. Set "hasReferences" to true if the question contains any pronoun or implicit reference that required resolution.

Be precise. Only mark entities that are clearly present in the question or its resolved form.
If there is no conversation history, return the question as-is and set hasReferences to false.`

/**
 * Creates a tool that extracts entities from a user question and resolves
 * pronoun references using conversation history.
 */
export function createEntityTrackerTool(
  config: NL2SQLToolkitConfig,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'track-entities',
    description:
      'Analyze conversation history to extract entities and resolve pronouns in follow-up questions.',
    schema: z.object({
      query: z.string().describe('The user question to analyze'),
      conversationHistory: z
        .array(
          z.object({
            role: z.string().describe('Message role: user, assistant, or system'),
            content: z.string().describe('Message content'),
          }),
        )
        .optional()
        .describe('Prior conversation messages for context'),
    }),
    func: async (input) => {
      try {
        const history = input.conversationHistory ?? config.conversationHistory ?? []

        const historyBlock =
          history.length > 0
            ? history
                .map((m: { role: string; content: string }) => `[${m.role}]: ${m.content}`)
                .join('\n')
            : '(no prior conversation)'

        const structuredModel = config.chatModel.withStructuredOutput(EntitySchema)

        const result: EntityExtractionResult = await structuredModel.invoke([
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Conversation history:\n${historyBlock}\n\nCurrent question: ${input.query}`,
          },
        ])

        return JSON.stringify(result)
      } catch (err: unknown) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
          entities: [],
          resolvedQuestion: input.query,
          hasReferences: false,
        })
      }
    },
  })
}
