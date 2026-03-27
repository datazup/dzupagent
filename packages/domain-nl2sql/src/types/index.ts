/**
 * @dzipagent/domain-nl2sql — Domain types for NL2SQL pipelines.
 *
 * Consolidated from @nl2sql/core pipeline.types, vector.types, and pipeline node outputs.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

// ---------------------------------------------------------------------------
// Types from @dzipagent/connectors and @dzipagent/core — defined locally
// to avoid build-order dependency on unbuilt sibling packages.
// At runtime, consumers inject concrete instances of these interfaces.
// ---------------------------------------------------------------------------

/** SQL dialect identifier */
export type SQLDialect =
  | 'postgresql' | 'mysql' | 'clickhouse' | 'snowflake'
  | 'bigquery' | 'sqlite' | 'sqlserver' | 'duckdb' | 'generic'

/** Minimal interface for SQL query execution (matches @dzipagent/connectors SQLConnector) */
export interface SQLConnector {
  getDialect(): SQLDialect
  executeQuery(sql: string, options?: { timeoutMs?: number; maxRows?: number }): Promise<QueryResultData>
  discoverSchema(options?: Record<string, unknown>): Promise<unknown>
  generateDDL(table: TableSchema): string
  destroy(): Promise<void>
}

/** Query result from SQL execution */
export interface QueryResultData {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
}

/** Table schema metadata */
export interface TableSchema {
  tableName: string
  schemaName: string
  columns: Array<{
    columnName: string
    dataType: string
    isNullable: boolean
    isPrimaryKey: boolean
    defaultValue: string | null
    description: string | null
    maxLength: number | null
  }>
  foreignKeys: Array<{
    constraintName: string
    columnName: string
    referencedTable: string
    referencedColumn: string
    referencedSchema: string
  }>
  rowCountEstimate: number
  description: string | null
  sampleValues: Record<string, unknown[]>
}

/** Minimal VectorStore interface (matches @dzipagent/core VectorStore) */
export interface VectorStore {
  readonly provider: string
  search(collection: string, query: { vector: number[]; limit: number; filter?: unknown; minScore?: number }): Promise<Array<{ id: string; score: number; metadata: Record<string, unknown>; text?: string }>>
  upsert(collection: string, entries: Array<{ id: string; vector: number[]; metadata: Record<string, unknown>; text?: string }>): Promise<void>
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number; provider: string }>
}

// ---------------------------------------------------------------------------
// Vector store types (NL2SQL-specific collections)
// ---------------------------------------------------------------------------

/** Input for upserting a table schema embedding */
export interface TableEmbeddingInput {
  tenantId: string
  dataSourceId: string
  workspaceId: string | null
  tableName: string
  schemaName: string
  ddl: string
  summary: string
  foreignKeyTables: string[]
}

/** A retrieved table from vector search */
export interface RetrievedTable {
  tableName: string
  schemaName: string
  ddl: string
  summary: string
  score: number
  foreignKeyTables: string[]
}

/** Input for upserting a SQL example embedding */
export interface SQLExampleInput {
  tenantId: string
  dataSourceId: string
  workspaceId: string | null
  question: string
  sql: string
  explanation: string
}

/** A retrieved SQL example from vector search */
export interface RetrievedExample {
  question: string
  sql: string
  explanation: string
  score: number
}

// ---------------------------------------------------------------------------
// Pipeline state types
// ---------------------------------------------------------------------------

/** Query complexity classification */
export type QueryComplexity = 'simple' | 'moderate' | 'complex'

/** Confidence label based on score */
export type ConfidenceLabel = 'high' | 'medium' | 'low'

/** A single reasoning step in SQL generation */
export interface ReasoningStep {
  relevantTables: string
  joins: string
  filters: string
  aggregation: string
  approach: string
}

/** Structured SQL explanation */
export interface StructuredExplanation {
  summary: string
  tableExplanations: Array<{ table: string; purpose: string }>
  filterExplanations: Array<{ filter: string; meaning: string }>
  joinExplanations: Array<{ join: string; purpose: string }>
}

/** Multi-dimensional confidence scorecard */
export interface ConfidenceScorecard {
  schemaMatch: { score: number; factors: string[] }
  syntaxValidity: { score: number; factors: string[] }
  semanticRelevance: { score: number; factors: string[] }
  historicalSuccess: { score: number; factors: string[] }
}

/** Conversation message for multi-turn context */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  sql?: string
  timestamp?: string
}

/** Business glossary entry */
export interface BusinessGlossaryEntry {
  term: string
  definition: string
  synonyms?: string[]
  relatedColumns?: string[]
}

/** CTE decomposition step */
export interface DecompositionStep {
  subQuestion: string
  cteName: string
  sql: string
}

/** Clarification request from ambiguity detection */
export interface ClarificationRequest {
  clarificationQuestion: string
  ambiguousTerms: string[]
  options: Array<{ label: string; description?: string }>
  responseType: 'single_select' | 'multi_select' | 'free_text'
}

/** Row-Level Security policy */
export interface RLSPolicy {
  tableName: string
  filterExpression: string
}

/** Workspace info for auto-selection */
export interface WorkspaceInfo {
  id: string
  name: string
  description?: string
}

/** Chart recommendation */
export interface ChartRecommendation {
  chartType: 'bar' | 'line' | 'pie' | 'scatter' | 'metric' | 'table'
  confidence: number
  reasoning: string
}

/** Result warning from plausibility checks */
export interface ResultWarning {
  message: string
  severity: 'info' | 'warning' | 'caution'
}

// ---------------------------------------------------------------------------
// Tool configuration
// ---------------------------------------------------------------------------

/** Configuration shared across all NL2SQL tools */
export interface NL2SQLToolkitConfig {
  /** LLM for generation tasks */
  chatModel: BaseChatModel
  /** Vector store for schema/example retrieval */
  vectorStore: VectorStore
  /** SQL connector for query execution + schema discovery */
  sqlConnector: SQLConnector
  /** Tenant identifier */
  tenantId: string
  /** Data source identifier */
  dataSourceId: string
  /** Optional workspace scope */
  workspaceId?: string | null
  /** SQL dialect */
  dialect: SQLDialect
  /** Max rows per query (default: 500) */
  maxRows?: number
  /** Query timeout in ms (default: 30000) */
  queryTimeout?: number
  /** Tables to block from queries */
  forbiddenTables?: string[]
  /** RLS policies to inject */
  rlsPolicies?: RLSPolicy[]
  /** Business glossary entries */
  businessGlossary?: BusinessGlossaryEntry[]
  /** Conversation history for multi-turn */
  conversationHistory?: ConversationMessage[]
}

// ---------------------------------------------------------------------------
// Workflow result
// ---------------------------------------------------------------------------

/** Complete result from NL2SQL workflow execution */
export interface NL2SQLResult {
  sql: string | null
  explanation: string | null
  result: QueryResultData | null
  chartRecommendation: ChartRecommendation | null
  isRelevant: boolean
  isAmbiguous: boolean
  clarificationRequest: ClarificationRequest | null
  confidenceScore: number | null
  confidenceLabel: ConfidenceLabel | null
  confidenceScorecard: ConfidenceScorecard | null
  structuredExplanation: StructuredExplanation | null
  error: string | null
  tablesUsed: string[]
  reasoningTrace: ReasoningStep | null
}
