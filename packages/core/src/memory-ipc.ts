/**
 * Re-exports from @forgeagent/memory-ipc for convenience.
 * Only available when @forgeagent/memory-ipc is installed as a peer dependency.
 */

// --- Schema ---
export {
  MEMORY_FRAME_SCHEMA,
  MEMORY_FRAME_VERSION,
  MEMORY_FRAME_COLUMNS,
  MEMORY_FRAME_FIELD_COUNT,
} from '@forgeagent/memory-ipc'
export type { MemoryFrameColumn } from '@forgeagent/memory-ipc'

// --- Frame Builder & Reader ---
export { FrameBuilder } from '@forgeagent/memory-ipc'
export type {
  FrameScope,
  FrameTemporal,
  FrameDecay,
  FrameProvenance,
  FrameRecordMeta,
  FrameRecordValue,
} from '@forgeagent/memory-ipc'

export { FrameReader } from '@forgeagent/memory-ipc'
export type { FrameRecord } from '@forgeagent/memory-ipc'

// --- IPC Serialization ---
export {
  serializeToIPC,
  deserializeFromIPC,
  ipcToBase64,
  base64ToIPC,
} from '@forgeagent/memory-ipc'
export type { SerializeOptions } from '@forgeagent/memory-ipc'

// --- Adapters ---
export { createAdapterRegistry } from '@forgeagent/memory-ipc'
export type {
  MemoryFrameAdapter,
  AdapterValidationResult,
  AdapterRegistry,
} from '@forgeagent/memory-ipc'

export {
  createEmptyColumns,
  buildTable,
  pushDefaults,
  safeParseDate,
  getString,
  getBigInt,
  getFloat,
} from '@forgeagent/memory-ipc'
export type { FrameColumnArrays } from '@forgeagent/memory-ipc'

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
} from '@forgeagent/memory-ipc'

// --- Token Budget ---
export {
  selectMemoriesByBudget,
  TokenBudgetAllocator,
} from '@forgeagent/memory-ipc'
export type {
  CompositeScoreWeights,
  ScoredRecord,
  TokenBudgetAllocation,
  TokenBudgetAllocatorConfig,
} from '@forgeagent/memory-ipc'

// --- Phase Memory Selection ---
export {
  phaseWeightedSelection,
  PHASE_NAMESPACE_WEIGHTS,
  PHASE_CATEGORY_WEIGHTS,
} from '@forgeagent/memory-ipc'
export type { ConversationPhase as IPCConversationPhase } from '@forgeagent/memory-ipc'

// --- Cache Delta ---
export { computeFrameDelta } from '@forgeagent/memory-ipc'
export type { FrameDelta } from '@forgeagent/memory-ipc'

// --- Memory-Aware Compression ---
export { batchOverlapAnalysis } from '@forgeagent/memory-ipc'
export type { OverlapAnalysis } from '@forgeagent/memory-ipc'

// --- Shared Memory Channel ---
export { SharedMemoryChannel } from '@forgeagent/memory-ipc'
export type {
  SharedMemoryChannelOptions,
  SlotHandle,
} from '@forgeagent/memory-ipc'

// --- Memory Service Arrow Extension ---
export { extendMemoryServiceWithArrow } from '@forgeagent/memory-ipc'
export type {
  ExportFrameOptions,
  ImportFrameResult,
  ImportStrategy,
  MemoryServiceLike,
  MemoryServiceArrowExtension,
} from '@forgeagent/memory-ipc'

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
} from '@forgeagent/memory-ipc'
export type {
  ExportMemoryInput,
  ExportMemoryOutput,
  ImportMemoryInput,
  ImportMemoryOutput,
  MemorySchemaOutput,
  ExportMemoryDeps,
  ImportMemoryDeps,
} from '@forgeagent/memory-ipc'

// --- A2A Memory Artifact ---
export {
  createMemoryArtifact,
  parseMemoryArtifact,
  sanitizeForExport,
} from '@forgeagent/memory-ipc'
export type {
  MemoryArtifact,
  MemoryArtifactPart,
  MemoryArtifactMetadata,
  SanitizeOptions,
} from '@forgeagent/memory-ipc'

// --- Blackboard ---
export { ArrowBlackboard } from '@forgeagent/memory-ipc'
export type {
  BlackboardConfig,
  BlackboardTableDef,
  BlackboardSnapshot,
} from '@forgeagent/memory-ipc'

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
} from '@forgeagent/memory-ipc'
export type {
  ToolResultEntry,
  CodegenFileEntry,
  EvalResultEntry,
  EntityGraphEntry,
} from '@forgeagent/memory-ipc'
