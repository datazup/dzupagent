/**
 * @forgeagent/memory-ipc — Arrow-based IPC for inter-agent memory sharing.
 *
 * Provides a canonical Arrow schema, builder/reader for memory frames,
 * IPC serialization, and cross-framework adapters.
 */

// --- Schema ---
export {
  MEMORY_FRAME_VERSION,
  MEMORY_FRAME_SCHEMA,
  MEMORY_FRAME_COLUMNS,
  MEMORY_FRAME_FIELD_COUNT,
} from './schema.js'
export type { MemoryFrameColumn } from './schema.js'

// --- Frame Builder ---
export { FrameBuilder } from './frame-builder.js'
export type {
  FrameScope,
  FrameTemporal,
  FrameDecay,
  FrameProvenance,
  FrameRecordMeta,
  FrameRecordValue,
} from './frame-builder.js'

// --- Frame Reader ---
export { FrameReader } from './frame-reader.js'
export type { FrameRecord } from './frame-reader.js'

// --- IPC Serialization ---
export {
  serializeToIPC,
  deserializeFromIPC,
  ipcToBase64,
  base64ToIPC,
} from './ipc-serializer.js'
export type { SerializeOptions } from './ipc-serializer.js'

// --- Adapters ---
export { createAdapterRegistry } from './adapters/adapter-interface.js'
export type {
  MemoryFrameAdapter,
  AdapterValidationResult,
  AdapterRegistry,
} from './adapters/adapter-interface.js'

export {
  createEmptyColumns,
  buildTable,
  pushDefaults,
  safeParseDate,
  getString,
  getBigInt,
  getFloat,
} from './adapters/frame-columns.js'
export type { FrameColumnArrays } from './adapters/frame-columns.js'

// --- Columnar Operations ---
export {
  findWeakIndices,
  batchDecayUpdate,
  temporalMask,
  applyMask,
  partitionByNamespace,
  computeCompositeScore,
  batchTokenEstimate,
  selectByTokenBudget,
  rankByPageRank,
  applyHubDampeningBatch,
  batchCosineSimilarity,
  takeRows,
} from './columnar-ops.js'

// --- Token Budget ---
export {
  selectMemoriesByBudget,
  TokenBudgetAllocator,
} from './token-budget.js'
export type {
  CompositeScoreWeights,
  ScoredRecord,
  TokenBudgetAllocation,
  TokenBudgetAllocatorConfig,
} from './token-budget.js'

// --- Phase Memory Selection ---
export {
  phaseWeightedSelection,
  PHASE_NAMESPACE_WEIGHTS,
  PHASE_CATEGORY_WEIGHTS,
} from './phase-memory-selection.js'
export type { ConversationPhase } from './phase-memory-selection.js'

// --- Cache Delta ---
export { computeFrameDelta } from './cache-delta.js'
export type { FrameDelta } from './cache-delta.js'

// --- Memory-Aware Compression ---
export { batchOverlapAnalysis } from './memory-aware-compress.js'
export type { OverlapAnalysis } from './memory-aware-compress.js'

// --- Shared Memory Channel ---
export { SharedMemoryChannel } from './shared-memory-channel.js'
export type {
  SharedMemoryChannelOptions,
  SlotHandle,
} from './shared-memory-channel.js'

// --- Memory Service Arrow Extension ---
export { extendMemoryServiceWithArrow } from './memory-service-ext.js'
export type {
  ExportFrameOptions,
  ImportFrameResult,
  ImportStrategy,
  MemoryServiceLike,
  MemoryServiceArrowExtension,
} from './memory-service-ext.js'

// --- MCP Memory Transport ---
export {
  exportMemoryInputSchema,
  exportMemoryOutputSchema,
  importMemoryInputSchema,
  importMemoryOutputSchema,
  memorySchemaOutputSchema,
  handleExportMemory,
  handleImportMemory,
  handleMemorySchema,
} from './mcp-memory-transport.js'
export type {
  ExportMemoryInput,
  ExportMemoryOutput,
  ImportMemoryInput,
  ImportMemoryOutput,
  MemorySchemaOutput,
  ExportMemoryDeps,
  ImportMemoryDeps,
} from './mcp-memory-transport.js'

// --- A2A Memory Artifact ---
export {
  createMemoryArtifact,
  parseMemoryArtifact,
  sanitizeForExport,
} from './a2a-memory-artifact.js'
export type {
  MemoryArtifact,
  MemoryArtifactPart,
  MemoryArtifactMetadata,
  SanitizeOptions,
} from './a2a-memory-artifact.js'

// --- Blackboard ---
export { ArrowBlackboard } from './blackboard.js'
export type {
  BlackboardConfig,
  BlackboardTableDef,
  BlackboardSnapshot,
} from './blackboard.js'

// --- Analytics (DuckDB-WASM) ---
export { DuckDBEngine } from './analytics/duckdb-engine.js'
export type { AnalyticsResult, RowRecord } from './analytics/duckdb-engine.js'

export { MemoryAnalytics } from './analytics/memory-analytics.js'
export type {
  DecayTrendPoint,
  NamespaceStats,
  AgentPerformance,
  ExpiringMemory,
  UsagePatternBucket,
  DuplicateCandidate,
} from './analytics/memory-analytics.js'

// --- Extended Frames ---
export {
  TOOL_RESULT_SCHEMA,
  ToolResultFrameBuilder,
  CODEGEN_FRAME_SCHEMA,
  CodegenFrameBuilder,
  EVAL_FRAME_SCHEMA,
  EvalFrameBuilder,
  ENTITY_GRAPH_SCHEMA,
  EntityGraphFrameBuilder,
} from './frames/index.js'
export type {
  ToolResultEntry,
  CodegenFileEntry,
  EvalResultEntry,
  EntityGraphEntry,
} from './frames/index.js'
