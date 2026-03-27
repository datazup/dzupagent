/**
 * @dzipagent/domain-nl2sql — SQL Generation Tool
 *
 * Generates a SQL query from a natural language question using chain-of-thought
 * reasoning. Enforces SELECT-only, includes LIMIT, and uses dialect-specific
 * hints. Returns structured output with reasoning trace and confidence score.
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import type { NL2SQLToolkitConfig } from '../types/index.js'

// ---------------------------------------------------------------------------
// Output schema for withStructuredOutput
// ---------------------------------------------------------------------------

const SQLGenerationSchema = z.object({
  reasoning: z
    .object({
      relevantTables: z
        .string()
        .describe('Which tables are needed and why'),
      joins: z
        .string()
        .describe('What joins are required and on which keys'),
      filters: z
        .string()
        .describe('What WHERE conditions are needed'),
      aggregation: z
        .string()
        .describe('What aggregations, GROUP BY, or HAVING clauses are needed'),
      approach: z
        .string()
        .describe('Overall approach to constructing the query'),
    })
    .describe('Chain-of-thought reasoning steps'),
  generatedSQL: z
    .string()
    .describe('The generated SQL query — SELECT only, includes LIMIT'),
  sqlExplanation: z
    .string()
    .describe('Plain-English explanation of what the SQL does'),
  tablesUsed: z
    .array(z.string())
    .describe('List of table names referenced in the query'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Confidence score from 0 to 1'),
  verificationChecks: z
    .array(z.string())
    .describe(
      'Self-verification checks the model performed (e.g., "Confirmed all JOINs use indexed columns")',
    ),
})

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  config: NL2SQLToolkitConfig,
  schema: string,
  examples: string | undefined,
  dialect: string,
): string {
  const sections: string[] = []

  sections.push(`You are an expert SQL query generator for ${dialect} databases.

Your task is to convert a natural language question into a correct, efficient SQL query.

CRITICAL RULES:
1. Generate ONLY SELECT statements. Never generate INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, or any DDL/DML.
2. ALWAYS include a LIMIT clause (default LIMIT ${config.maxRows ?? 500}) unless the question explicitly asks for all rows.
3. Use the exact table and column names from the provided schema — do not invent tables or columns.
4. Prefer explicit JOIN syntax over implicit joins in WHERE.
5. Use table aliases for readability.
6. Include ORDER BY when ranking or "top N" is requested.
7. Handle NULL values appropriately (use COALESCE, IS NULL, etc.).
8. Use dialect-appropriate syntax for ${dialect}.`)

  // Dialect-specific hints
  const dialectHints: Record<string, string> = {
    postgresql: 'Use ILIKE for case-insensitive matching. Use :: for type casting. DATE_TRUNC for date grouping.',
    mysql: 'Use LIKE for pattern matching (case-insensitive by default). Use CAST() for type casting. DATE_FORMAT for date formatting.',
    clickhouse: 'Use toDate(), toDateTime() for date functions. Use arrayJoin() for array expansion. Prefer WHERE over HAVING.',
    snowflake: 'Use ILIKE for case-insensitive matching. Use TRY_CAST for safe type casting. DATEADD/DATEDIFF for date arithmetic.',
    bigquery: 'Use backticks for table references. Use SAFE_CAST. FORMAT_TIMESTAMP for date formatting. Use UNNEST for arrays.',
    sqlite: 'Use LIKE for pattern matching. Use CAST() for type casting. strftime() for date formatting.',
    sqlserver: 'Use TOP instead of LIMIT. Use CONVERT/TRY_CONVERT for type casting. DATEPART for date extraction.',
    duckdb: 'Use ILIKE for case-insensitive matching. Supports modern SQL syntax. Use DATE_TRUNC for date grouping.',
  }

  const hint = dialectHints[dialect]
  if (hint) {
    sections.push(`\nDialect hints for ${dialect}:\n${hint}`)
  }

  // Schema
  sections.push(`\n--- DATABASE SCHEMA ---\n${schema}`)

  // Few-shot examples
  if (examples && examples.trim().length > 0) {
    sections.push(`\n--- EXAMPLE QUERIES ---\n${examples}`)
  }

  // Business glossary
  if (config.businessGlossary && config.businessGlossary.length > 0) {
    const glossaryText = config.businessGlossary
      .map((entry) => {
        const synonyms =
          entry.synonyms && entry.synonyms.length > 0
            ? ` (also: ${entry.synonyms.join(', ')})`
            : ''
        const cols =
          entry.relatedColumns && entry.relatedColumns.length > 0
            ? ` → columns: ${entry.relatedColumns.join(', ')}`
            : ''
        return `- ${entry.term}${synonyms}: ${entry.definition}${cols}`
      })
      .join('\n')
    sections.push(`\n--- BUSINESS GLOSSARY ---\n${glossaryText}`)
  }

  // Conversation context
  if (config.conversationHistory && config.conversationHistory.length > 0) {
    const historyText = config.conversationHistory
      .slice(-5) // Last 5 turns
      .map((msg) => {
        const sqlNote = msg.sql ? ` [SQL: ${msg.sql}]` : ''
        return `${msg.role}: ${msg.content}${sqlNote}`
      })
      .join('\n')
    sections.push(`\n--- CONVERSATION HISTORY ---\n${historyText}`)
  }

  // Forbidden tables
  if (config.forbiddenTables && config.forbiddenTables.length > 0) {
    sections.push(
      `\n--- FORBIDDEN TABLES (never query these) ---\n${config.forbiddenTables.join(', ')}`,
    )
  }

  return sections.join('\n')
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSQLGenerateTool(
  config: NL2SQLToolkitConfig,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'generate-sql',
    description:
      'Generate a SQL query from natural language using chain-of-thought reasoning.',
    schema: z.object({
      query: z
        .string()
        .describe('The natural language question to convert to SQL'),
      schema: z
        .string()
        .describe('The DDL schema of relevant tables'),
      examples: z
        .string()
        .optional()
        .describe('Optional few-shot SQL examples formatted as Q/A pairs'),
      dialect: z
        .string()
        .describe('SQL dialect (postgresql, mysql, clickhouse, snowflake, bigquery, sqlite, sqlserver, duckdb)'),
    }),
    func: async ({ query, schema, examples, dialect }) => {
      try {
        const systemPrompt = buildSystemPrompt(config, schema, examples, dialect)

        const prompt = ChatPromptTemplate.fromMessages([
          ['system', systemPrompt],
          [
            'human',
            'Convert this question to a SQL query:\n\n{query}',
          ],
        ])

        const structuredModel = config.chatModel.withStructuredOutput(
          SQLGenerationSchema,
          { name: 'sql_generation' },
        )

        const chain = prompt.pipe(structuredModel)

        const result = await chain.invoke({ query })

        // Post-processing validation
        const sql = result.generatedSQL.trim()
        const warnings: string[] = []

        // Verify SELECT-only
        const firstKeyword = sql.split(/\s+/)[0]?.toUpperCase() ?? ''
        if (firstKeyword !== 'SELECT' && firstKeyword !== 'WITH') {
          return JSON.stringify({
            sql: null,
            explanation: 'Generation produced a non-SELECT statement which was blocked.',
            reasoning: result.reasoning,
            tablesUsed: result.tablesUsed,
            confidence: 0,
            verificationChecks: result.verificationChecks,
            error: `Blocked: generated statement starts with "${firstKeyword}" — only SELECT/WITH allowed.`,
          })
        }

        // Check for dangerous keywords inside CTEs or subqueries
        const dangerousPatterns = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|EXEC|EXECUTE)\b/i
        if (dangerousPatterns.test(sql)) {
          return JSON.stringify({
            sql: null,
            explanation: 'Generation contained dangerous SQL keywords and was blocked.',
            reasoning: result.reasoning,
            tablesUsed: result.tablesUsed,
            confidence: 0,
            verificationChecks: result.verificationChecks,
            error: 'Blocked: generated SQL contains dangerous keywords.',
          })
        }

        // Warn if no LIMIT (for non-aggregate queries)
        const hasLimit = /\bLIMIT\b/i.test(sql) || /\bTOP\b/i.test(sql)
        const hasAggregateOnly =
          /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(sql) &&
          !/\bGROUP\s+BY\b/i.test(sql)
        if (!hasLimit && !hasAggregateOnly) {
          warnings.push(
            'Query has no LIMIT clause — large result sets may impact performance.',
          )
        }

        return JSON.stringify({
          sql,
          explanation: result.sqlExplanation,
          reasoning: result.reasoning,
          tablesUsed: result.tablesUsed,
          confidence: result.confidence,
          verificationChecks: result.verificationChecks,
          warnings: warnings.length > 0 ? warnings : undefined,
        })
      } catch (error) {
        return JSON.stringify({
          sql: null,
          explanation: null,
          reasoning: null,
          tablesUsed: [],
          confidence: 0,
          verificationChecks: [],
          error: `SQL generation failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    },
  })
}
