/**
 * @dzipagent/domain-nl2sql — Domain types for NL2SQL pipelines.
 *
 * Consolidated from @nl2sql/core pipeline.types, vector.types, and pipeline node outputs.
 */

import type {
  SQLDialect,
  SQLConnector,
  TableSchema,
  QueryResultData,
} from '@dzipagent/connectors'
import type { VectorStore } from '@dzipagent/core'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

// Re-export connector types that NL2SQL domain uses directly
export type { SQLDialect, TableSchema, QueryResultData, SQLConnector }

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
