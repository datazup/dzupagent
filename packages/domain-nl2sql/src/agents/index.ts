/**
 * Pre-configured NL2SQL specialist agent definitions.
 *
 * These are config objects (not instantiated agents) — the consumer
 * passes them to DzipAgent or TenantAgentFactory to create instances.
 */

import type { NL2SQLToolkitConfig } from '../types/index.js'
import {
  createSchemaRetrievalTool,
  createColumnPruneTool,
  createSQLGenerateTool,
  createValidateSafetyTool,
  createValidateStructureTool,
  createExecuteQueryTool,
  createResponseSynthesizerTool,
  createConfidenceScorerTool,
  createResultValidatorTool,
} from '../tools/index.js'
import type { DynamicStructuredTool } from '@langchain/core/tools'

/** Agent definition (not instantiated — pass to DzipAgent constructor) */
export interface NL2SQLAgentDef {
  id: string
  name: string
  description: string
  instructions: string
  modelTier: 'chat' | 'reasoning'
  maxIterations: number
  tools: DynamicStructuredTool[]
}

/**
 * Schema Expert — finds and prunes relevant schema for a query.
 */
export function createSchemaExpertDef(config: NL2SQLToolkitConfig): NL2SQLAgentDef {
  return {
    id: 'schema-expert',
    name: 'Schema Expert',
    description: 'Finds relevant database tables via semantic search and prunes irrelevant columns.',
    instructions: `You are a Schema Expert for an NL2SQL system.

Your job:
1. Use retrieve-relevant-schema to find tables relevant to the user's question.
2. Use prune-schema-columns to remove irrelevant columns and reduce context.
3. Return ONLY the pruned DDL — no commentary, no SQL generation.

Guidelines:
- Always retrieve schema first, then prune.
- If retrieval returns no tables, say so clearly.
- Preserve PRIMARY KEY and FOREIGN KEY columns always.
- The pruned DDL will be passed to the SQL Writer agent.`,
    modelTier: 'chat',
    maxIterations: 3,
    tools: [
      createSchemaRetrievalTool(config),
      createColumnPruneTool(config),
    ],
  }
}

/**
 * SQL Writer — generates and validates SQL from schema + question.
 */
export function createSQLWriterDef(config: NL2SQLToolkitConfig): NL2SQLAgentDef {
  return {
    id: 'sql-writer',
    name: 'SQL Writer',
    description: 'Generates SQL from natural language and validates it for safety and correctness.',
    instructions: `You are a SQL Writer for an NL2SQL system.

Your job:
1. Use generate-sql to create a SQL query from the schema and question.
2. Use validate-sql-safety to check for destructive operations.
3. Use validate-sql-structure to verify table references exist.
4. If validation fails: analyze the error, fix the SQL, re-validate.
5. Return the validated SQL with explanation.

Guidelines:
- Generate SELECT-only queries. Never INSERT/UPDATE/DELETE/DROP.
- Include LIMIT if the user doesn't specify one.
- Use ${config.dialect} dialect syntax.
- Chain-of-thought: explain your reasoning step by step.
- If both validations pass, return the SQL immediately.`,
    modelTier: 'reasoning',
    maxIterations: 5,
    tools: [
      createSQLGenerateTool(config),
      createValidateSafetyTool(config),
      createValidateStructureTool(config),
    ],
  }
}

/**
 * Query Executor — runs SQL and synthesizes the response.
 */
export function createQueryExecutorDef(config: NL2SQLToolkitConfig): NL2SQLAgentDef {
  return {
    id: 'query-executor',
    name: 'Query Executor',
    description: 'Executes validated SQL, validates results, scores confidence, and generates response.',
    instructions: `You are a Query Executor for an NL2SQL system.

Your job:
1. Use execute-sql-query to run the SQL against the target database.
2. Use validate-result to check for data anomalies.
3. Use score-confidence to compute a reliability score.
4. Use synthesize-response to generate a natural language explanation.
5. Return execution results + explanation + confidence score.

Guidelines:
- If execution fails, report the error clearly with the error type.
- Mention key findings in the response (totals, counts, trends).
- Format numbers with appropriate units.
- Keep summaries concise (2-3 sentences for simple results).`,
    modelTier: 'chat',
    maxIterations: 3,
    tools: [
      createExecuteQueryTool(config),
      createResultValidatorTool(config),
      createConfidenceScorerTool(config),
      createResponseSynthesizerTool(config),
    ],
  }
}
