/**
 * @dzipagent/domain-nl2sql — Column Pruning Tool
 *
 * Removes irrelevant columns from DDL to reduce LLM context window usage.
 * Short DDLs pass through unchanged; larger ones are pruned via LLM call
 * that preserves primary keys, foreign keys, and query-relevant columns.
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import { StringOutputParser } from '@langchain/core/output_parsers'
import type { NL2SQLToolkitConfig } from '../types/index.js'

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const PRUNE_SYSTEM_PROMPT = `You are a database schema optimizer. Your task is to remove columns from the provided DDL that are NOT relevant to answering the user's question.

Rules:
1. ALWAYS keep PRIMARY KEY columns — never remove them.
2. ALWAYS keep FOREIGN KEY columns — never remove them.
3. ALWAYS keep columns explicitly mentioned or implied by the user's question.
4. ALWAYS keep columns likely needed for JOIN conditions.
5. Remove columns that are clearly irrelevant (audit timestamps, internal flags, blob fields, etc.) unless the question asks about them.
6. Preserve the exact table and schema names.
7. Preserve column data types exactly as given.
8. Return ONLY the pruned DDL — no explanations, no markdown fences, no comments.

If in doubt about whether a column is relevant, KEEP it. It is better to include a slightly irrelevant column than to remove one that is needed.`

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createColumnPruneTool(
  config: NL2SQLToolkitConfig,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'prune-schema-columns',
    description:
      'Remove irrelevant columns from DDL schema to reduce LLM context. Preserves PKs and FKs.',
    schema: z.object({
      ddl: z.string().describe('The full DDL schema to prune'),
      query: z.string().describe('The user question — columns relevant to this are kept'),
      threshold: z
        .number()
        .int()
        .min(100)
        .optional()
        .describe(
          'Character count threshold below which DDL is returned as-is (default: 4000)',
        ),
    }),
    func: async ({ ddl, query, threshold }) => {
      const charThreshold = threshold ?? 4000

      try {
        // -----------------------------------------------------------------
        // Short-circuit: DDL is small enough — no pruning needed
        // -----------------------------------------------------------------
        if (ddl.length < charThreshold) {
          return JSON.stringify({
            prunedDDL: ddl,
            pruned: false,
            originalLength: ddl.length,
            prunedLength: ddl.length,
          })
        }

        // -----------------------------------------------------------------
        // LLM-based pruning
        // -----------------------------------------------------------------
        const prompt = ChatPromptTemplate.fromMessages([
          ['system', PRUNE_SYSTEM_PROMPT],
          [
            'human',
            'User question: {query}\n\nDDL to prune:\n\n{ddl}',
          ],
        ])

        const chain = prompt.pipe(config.chatModel).pipe(new StringOutputParser())

        const prunedDDL = await chain.invoke({ query, ddl })

        // Sanity check: if LLM returned something unreasonably small, fall back
        // to original DDL (the LLM may have hallucinated an empty response).
        const minReasonableLength = Math.min(200, ddl.length * 0.05)
        if (prunedDDL.trim().length < minReasonableLength) {
          return JSON.stringify({
            prunedDDL: ddl,
            pruned: false,
            originalLength: ddl.length,
            prunedLength: ddl.length,
            warning: 'LLM pruning returned suspiciously short result; using original DDL',
          })
        }

        return JSON.stringify({
          prunedDDL: prunedDDL.trim(),
          pruned: true,
          originalLength: ddl.length,
          prunedLength: prunedDDL.trim().length,
          reductionPercent:
            Math.round((1 - prunedDDL.trim().length / ddl.length) * 100),
        })
      } catch (error) {
        // On error, return original DDL — pruning is an optimization, not critical
        return JSON.stringify({
          prunedDDL: ddl,
          pruned: false,
          originalLength: ddl.length,
          prunedLength: ddl.length,
          error: `Column pruning failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    },
  })
}
