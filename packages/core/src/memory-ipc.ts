/**
 * Re-exports from @dzipagent/memory-ipc for convenience.
 * Only available when @dzipagent/memory-ipc is installed as a peer dependency.
 */

// --- Schema ---
export {
  MEMORY_FRAME_SCHEMA,
  MEMORY_FRAME_VERSION,
  MEMORY_FRAME_COLUMNS,
  MEMORY_FRAME_FIELD_COUNT,
} from '@dzipagent/memory-ipc'
export type { MemoryFrameColumn } from '@dzipagent/memory-ipc'

// --- Frame Builder & Reader ---
export { FrameBuilder } from '@dzipagent/memory-ipc'
export type {
  FrameScope,
  FrameTemporal,
  FrameDecay,
  FrameProvenance,
  FrameRecordMeta,
  FrameRecordValue,
} from '@dzipagent/memory-ipc'

export { FrameReader } from '@dzipagent/memory-ipc'
export type { FrameRecord } from '@dzipagent/memory-ipc'

// --- IPC Serialization ---
export {
  serializeToIPC,
  deserializeFromIPC,
  ipcToBase64,
  base64ToIPC,
} from '@dzipagent/memory-ipc'
export type { SerializeOptions } from '@dzipagent/memory-ipc'

// --- Adapters ---
export { createAdapterRegistry } from '@dzipagent/memory-ipc'
export type {
  MemoryFrameAdapter,
  AdapterValidationResult,
  AdapterRegistry,
} from '@dzipagent/memory-ipc'

export {
  createEmptyColumns,
  buildTable,
  pushDefaults,
  safeParseDate,
  getString,
  getBigInt,
  getFloat,
} from '@dzipagent/memory-ipc'
export type { FrameColumnArrays } from '@dzipagent/memory-ipc'

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
} from '@dzipagent/memory-ipc'

// --- Token Budget ---
export {
  selectMemoriesByBudget,
  TokenBudgetAllocator,
} from '@dzipagent/memory-ipc'
export type {
  CompositeScoreWeights,
  ScoredRecord,
  TokenBudgetAllocation,
  TokenBudgetAllocatorConfig,
} from '@dzipagent/memory-ipc'

// --- Phase Memory Selection ---
export {
  phaseWeightedSelection,
  PHASE_NAMESPACE_WEIGHTS,
  PHASE_CATEGORY_WEIGHTS,
} from '@dzipagent/memory-ipc'
export type { ConversationPhase as IPCConversationPhase } from '@dzipagent/memory-ipc'

// --- Cache Delta ---
export { computeFrameDelta } from '@dzipagent/memory-ipc'
export type { FrameDelta } from '@dzipagent/memory-ipc'

// --- Memory-Aware Compression ---
export { batchOverlapAnalysis } from '@dzipagent/memory-ipc'
export type { OverlapAnalysis } from '@dzipagent/memory-ipc'

// --- Shared Memory Channel ---
export { SharedMemoryChannel } from '@dzipagent/memory-ipc'
export type {
  SharedMemoryChannelOptions,
  SlotHandle,
} from '@dzipagent/memory-ipc'

// --- Memory Service Arrow Extension ---
export { extendMemoryServiceWithArrow } from '@dzipagent/memory-ipc'
export type {
  ExportFrameOptions,
  ImportFrameResult,
  ImportStrategy,
  MemoryServiceLike,
  MemoryServiceArrowExtension,
} from '@dzipagent/memory-ipc'

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
} from '@dzipagent/memory-ipc'
export type {
  ExportMemoryInput,
  ExportMemoryOutput,
  ImportMemoryInput,
  ImportMemoryOutput,
  MemorySchemaOutput,
  ExportMemoryDeps,
  ImportMemoryDeps,
} from '@dzipagent/memory-ipc'

// --- A2A Memory Artifact ---
export {
  createMemoryArtifact,
  parseMemoryArtifact,
  sanitizeForExport,
} from '@dzipagent/memory-ipc'
export type {
  MemoryArtifact,
  MemoryArtifactPart,
  MemoryArtifactMetadata,
  SanitizeOptions,
} from '@dzipagent/memory-ipc'

// --- Blackboard ---
export { ArrowBlackboard } from '@dzipagent/memory-ipc'
export type {
  BlackboardConfig,
  BlackboardTableDef,
  BlackboardSnapshot,
} from '@dzipagent/memory-ipc'

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
} from '@dzipagent/memory-ipc'
export type {
  ToolResultEntry,
  CodegenFileEntry,
  EvalResultEntry,
  EntityGraphEntry,
} from '@dzipagent/memory-ipc'
