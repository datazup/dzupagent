/**
 * Model Router Tool — classifies query complexity and recommends
 * which model tier to use for SQL generation.
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { NL2SQLToolkitConfig } from '../types/index.js'

const ComplexityClassificationSchema = z.object({
  complexity: z.enum(['simple', 'moderate', 'complex']),
  reason: z.string(),
  estimatedTables: z.number(),
  requiresJoins: z.boolean(),
  requiresAggregation: z.boolean(),
  requiresSubqueries: z.boolean(),
  requiresWindowFunctions: z.boolean(),
})

type ComplexityClassification = z.infer<typeof ComplexityClassificationSchema>

const SYSTEM_PROMPT = `You are an expert SQL complexity classifier. Given a natural language question and database schema, classify the SQL complexity needed.

Classification rules:
- **simple**: Single table, no aggregation, basic WHERE filters. Examples: "list all customers", "show orders from last week".
- **moderate**: 2-3 tables with simple JOINs, basic GROUP BY / aggregation (COUNT, SUM, AVG), HAVING clauses. Examples: "total revenue per customer", "top 10 products by sales".
- **complex**: 4+ tables, window functions (ROW_NUMBER, RANK, LAG/LEAD), CTEs, subqueries, UNION, pivoting, nested aggregations. Examples: "month-over-month growth rate per region", "running totals with rankings".

Be accurate in your estimates:
- estimatedTables: how many tables the SQL query will likely reference.
- requiresJoins: true if the query needs JOIN clauses.
- requiresAggregation: true if GROUP BY, COUNT, SUM, AVG, MIN, MAX, etc. are needed.
- requiresSubqueries: true if subqueries or CTEs are needed.
- requiresWindowFunctions: true if OVER(), PARTITION BY, window functions are needed.
- reason: a brief explanation of why you chose this complexity level.`

/**
 * Creates a tool that classifies the complexity of a natural language
 * query to determine which model tier should handle SQL generation.
 */
export function createModelRouterTool(
  config: NL2SQLToolkitConfig,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'route-model',
    description:
      'Classify query complexity and recommend which model tier to use for SQL generation.',
    schema: z.object({
      query: z.string().describe('The natural language question to classify'),
      schema: z.string().describe('Database schema context (DDL or table descriptions)'),
    }),
    func: async (input) => {
      try {
        const structuredModel = config.chatModel.withStructuredOutput(
          ComplexityClassificationSchema,
        )

        const result: ComplexityClassification = await structuredModel.invoke([
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Database schema:\n${input.schema}\n\nQuestion: ${input.query}`,
          },
        ])

        return JSON.stringify(result)
      } catch (err: unknown) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
          complexity: 'moderate' as const,
          reason: 'Fallback due to classification error',
          estimatedTables: 1,
          requiresJoins: false,
          requiresAggregation: false,
          requiresSubqueries: false,
          requiresWindowFunctions: false,
        })
      }
    },
  })
}
