/**
 * @dzipagent/domain-nl2sql — NL2SQL domain module for DzipAgent.
 *
 * Provides 14 specialized tools, 3 specialist agent definitions,
 * and 2 workflow patterns (deterministic + supervisor) for building
 * natural language to SQL pipelines.
 *
 * @example
 * ```typescript
 * import {
 *   createFullToolkit,
 *   createSchemaExpertDef,
 *   createSQLWriterDef,
 *   createQueryExecutorDef,
 *   DETERMINISTIC_WORKFLOW,
 * } from '@dzipagent/domain-nl2sql'
 *
 * // Create all tools for a tenant
 * const tools = createFullToolkit({
 *   chatModel,
 *   vectorStore,
 *   sqlConnector,
 *   tenantId: 'tenant-1',
 *   dataSourceId: 'ds-1',
 *   dialect: 'postgresql',
 * })
 *
 * // Or use pre-configured agent definitions
 * const schemaExpert = createSchemaExpertDef(config)
 * const sqlWriter = createSQLWriterDef(config)
 * const executor = createQueryExecutorDef(config)
 * ```
 */

// --- Types ---
export type {
  // Core domain types
  NL2SQLToolkitConfig,
  NL2SQLResult,
  SQLDialect,
  TableSchema,
  QueryResultData,

  // Vector/retrieval types
  TableEmbeddingInput,
  RetrievedTable,
  SQLExampleInput,
  RetrievedExample,

  // Pipeline state types
  QueryComplexity,
  ConfidenceLabel,
  ReasoningStep,
  StructuredExplanation,
  ConfidenceScorecard,
  ConversationMessage,
  BusinessGlossaryEntry,
  DecompositionStep,
  ClarificationRequest,
  RLSPolicy,
  WorkspaceInfo,
  ChartRecommendation,
  ResultWarning,
} from './types/index.js'

// --- Tools ---
export {
  // Toolkit factories (grouped by tier)
  createCoreToolkit,
  createExtendedToolkit,
  createFullToolkit,

  // Individual tool factories
  createSchemaRetrievalTool,
  createColumnPruneTool,
  createSQLGenerateTool,
  createValidateSafetyTool,
  createValidateStructureTool,
  createExecuteQueryTool,
  createClassifyRelevanceTool,
  createDetectAmbiguityTool,
  createEntityTrackerTool,
  createModelRouterTool,
  createMultiAgentGenerateTool,
  createResponseSynthesizerTool,
  createResultValidatorTool,
  createConfidenceScorerTool,
} from './tools/index.js'

// --- Agents ---
export {
  createSchemaExpertDef,
  createSQLWriterDef,
  createQueryExecutorDef,
} from './agents/index.js'
export type { NL2SQLAgentDef } from './agents/index.js'

// --- Workflows ---
export {
  createWorkflowSteps,
  createEmptyResult,
  DETERMINISTIC_WORKFLOW,
  SUPERVISOR_WORKFLOW,
} from './workflows/index.js'
export type { NL2SQLWorkflowSteps } from './workflows/index.js'

// --- Embedding pipeline ---
export {
  SchemaEmbeddingPipeline,
  embedSQLExamples,
  deleteSQLExampleEmbeddings,
  TABLE_SCHEMA_COLLECTION,
  SQL_EXAMPLE_COLLECTION,
} from './embedding/index.js'
export type {
  SchemaEmbeddingPipelineConfig,
  EmbeddingPipelineInput,
  EmbeddingPipelineResult,
  DatabaseSchema,
  SummaryGenerator,
  TableSummaryInput,
  TableSummaryResult,
  SQLExampleEmbeddingInput,
  SQLExampleEmbeddingDeps,
} from './embedding/index.js'

// --- Streaming ---
export {
  PipelineEventEmitter,
  type StageStartEvent,
  type StageCompleteEvent,
  type SQLChunkEvent,
  type ResultRowEvent,
  type PipelineErrorEvent,
  type PipelineDoneEvent,
  type PipelineEvent,
  type PipelineEventMap,
  type PipelineEventName,
} from './streaming/index.js'
