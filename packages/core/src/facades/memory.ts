/**
 * @forgeagent/core/memory — Curated API facade for memory-focused use cases.
 *
 * Exports memory service, retrieval strategies, store management,
 * consolidation, and decay — without pulling in the full core surface.
 *
 * @example
 * ```ts
 * import { MemoryService, createStore, fusionSearch } from '@forgeagent/core/memory';
 * ```
 */

// ---------------------------------------------------------------------------
// Core memory
// ---------------------------------------------------------------------------
export {
  createStore,
  MemoryService,
} from '@forgeagent/memory'
export type {
  StoreConfig,
  StoreIndexConfig,
  NamespaceConfig,
  FormatOptions,
  SemanticStoreAdapter,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------
export {
  calculateStrength,
  reinforceMemory,
  createDecayMetadata,
  scoreWithDecay,
  findWeakMemories,
} from '@forgeagent/memory'
export type { DecayConfig, DecayMetadata } from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------
export {
  sanitizeMemoryContent,
  stripInvisibleUnicode,
} from '@forgeagent/memory'
export type { SanitizeResult } from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------
export {
  consolidateNamespace,
  consolidateAll,
  SemanticConsolidator,
  consolidateWithLLM,
} from '@forgeagent/memory'
export type {
  ConsolidationConfig,
  ConsolidationResult,
  SemanticConsolidationConfig,
  SemanticConsolidationResult,
  ConsolidationAction,
  ConsolidationDecision,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Healer
// ---------------------------------------------------------------------------
export {
  findDuplicates,
  findContradictions,
  findStaleRecords,
  healMemory,
} from '@forgeagent/memory'
export type { HealingIssue, HealingReport, MemoryHealerConfig } from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Working Memory
// ---------------------------------------------------------------------------
export {
  WorkingMemory,
  VersionedWorkingMemory,
} from '@forgeagent/memory'
export type {
  WorkingMemoryConfig,
  VersionedWorkingMemoryConfig,
  WorkingMemoryDiff,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Observation Extractors
// ---------------------------------------------------------------------------
export {
  ObservationExtractor,
  MemoryAwareExtractor,
} from '@forgeagent/memory'
export type {
  ObservationExtractorConfig,
  Observation,
  ObservationCategory,
  MemoryAwareExtractorConfig,
  ExtractionResult,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Staged Writers & Policies
// ---------------------------------------------------------------------------
export {
  StagedWriter,
  PolicyAwareStagedWriter,
  defaultWritePolicy,
  composePolicies,
} from '@forgeagent/memory'
export type {
  StagedRecord,
  MemoryStage,
  StagedWriterConfig,
  PolicyAwareStagedWriterConfig,
  WritePolicy,
  WriteAction,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Retrieval — base strategies
// ---------------------------------------------------------------------------
export {
  StoreVectorSearch,
  VectorStoreSearch,
  KeywordFTSSearch,
  EntityGraphSearch,
  fusionSearch,
} from '@forgeagent/memory'
export type {
  VectorSearchResult,
  VectorSearchProvider,
  FTSSearchResult,
  GraphSearchResult,
  FusedResult,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Retrieval — adaptive
// ---------------------------------------------------------------------------
export {
  AdaptiveRetriever,
  DEFAULT_STRATEGIES,
  classifyIntent,
} from '@forgeagent/memory'
export type {
  QueryIntent,
  RetrievalWeights,
  RetrievalStrategy,
  RetrievalProviders,
  AdaptiveRetrieverConfig,
  AdaptiveSearchResult,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Retrieval — graph
// ---------------------------------------------------------------------------
export { PersistentEntityGraph } from '@forgeagent/memory'
export type { EntityNode, GraphTraversalResult } from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Retrieval — advanced (void filter, hub dampening, PageRank, reranking)
// ---------------------------------------------------------------------------
export { voidFilter } from '@forgeagent/memory'
export type { MemoryState, VoidFilterConfig, VoidFilterResult } from '@forgeagent/memory'

export { applyHubDampening, getAccessCount } from '@forgeagent/memory'
export type { HubDampenedResult, HubDampeningConfig } from '@forgeagent/memory'

export { computePPR, queryPPR } from '@forgeagent/memory'
export type { PPRConfig, PPRResult } from '@forgeagent/memory'

export { rerank, createLLMReranker } from '@forgeagent/memory'
export type { CrossEncoderProvider, RerankerConfig, RerankedResult } from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Retrieval — relationships & communities
// ---------------------------------------------------------------------------
export { RelationshipStore } from '@forgeagent/memory'
export type {
  RelationshipType,
  RelationshipEdge,
  EdgeMetadata,
  TraversalResult,
} from '@forgeagent/memory'

export { CommunityDetector } from '@forgeagent/memory'
export type {
  MemoryCommunity,
  CommunityDetectorConfig,
  CommunityDetectionResult,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Temporal memory
// ---------------------------------------------------------------------------
export {
  TemporalMemoryService,
  createTemporalMeta,
  isActive,
  wasActiveAsOf,
  wasValidAt,
  filterByTemporal,
} from '@forgeagent/memory'
export type { TemporalMetadata, TemporalQuery, TemporalChange } from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Scoped / multi-agent memory
// ---------------------------------------------------------------------------
export {
  ScopedMemoryService,
  createAgentMemories,
  PolicyTemplates,
} from '@forgeagent/memory'
export type {
  MemoryAccessPolicy,
  NamespaceAccess,
  AccessViolation,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Dual-stream & sleep consolidation
// ---------------------------------------------------------------------------
export { DualStreamWriter } from '@forgeagent/memory'
export type { DualStreamConfig, PendingRecord, IngestResult } from '@forgeagent/memory'

export { SleepConsolidator, runSleepConsolidation } from '@forgeagent/memory'
export type {
  SleepConsolidationConfig,
  SleepConsolidationReport,
  SleepPhase,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Observational memory
// ---------------------------------------------------------------------------
export { ObservationalMemory } from '@forgeagent/memory'
export type {
  ObservationalMemoryConfig,
  ObservationalMemoryStats,
  ObserverResult,
  ReflectorResult,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------
export {
  ProvenanceWriter,
  createProvenance,
  extractProvenance,
  createContentHash,
} from '@forgeagent/memory'
export type {
  MemoryProvenance,
  ProvenanceSource,
  ProvenanceWriteOptions,
  ProvenanceQuery,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Frozen Snapshot
// ---------------------------------------------------------------------------
export { FrozenMemorySnapshot } from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------
export { EnvKeyProvider, EncryptedMemoryService } from '@forgeagent/memory'
export type {
  EncryptedEnvelope,
  EncryptionKeyDescriptor,
  EncryptionKeyProvider,
  EncryptedMemoryServiceConfig,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Convention detection
// ---------------------------------------------------------------------------
export { ConventionExtractor, ALL_CONVENTION_CATEGORIES } from '@forgeagent/memory'
export type {
  ConventionCategory,
  DetectedConvention,
  ConventionCheckResult,
  ConventionFollowed,
  ConventionViolated,
  ConventionExtractorConfig,
  ConventionFilter,
  ConsolidateOptions,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Causal graph
// ---------------------------------------------------------------------------
export { CausalGraph } from '@forgeagent/memory'
export type {
  CausalRelation,
  CausalNode,
  CausalTraversalOptions,
  CausalGraphResult,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Shared memory spaces & CRDTs
// ---------------------------------------------------------------------------
export { MemorySpaceManager } from '@forgeagent/memory'
export type {
  MemorySpaceManagerConfig,
  SpacePermission,
  ConflictStrategy,
  ShareMode,
  MemoryParticipant,
  RetentionPolicy,
  SharedMemorySpace,
  MemoryShareRequest,
  PendingShareRequest,
  SharedMemoryEvent,
} from '@forgeagent/memory'

export { HLC, CRDTResolver } from '@forgeagent/memory'
export type {
  HLCTimestamp,
  LWWRegister,
  ORSetEntry,
  ORSet,
  LWWMap,
  MergeResult,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Multi-modal memory
// ---------------------------------------------------------------------------
export {
  MultiModalMemoryService,
  InMemoryAttachmentStorage,
  inferAttachmentType,
} from '@forgeagent/memory'
export type {
  AttachmentType,
  MemoryAttachment,
  AttachmentStorageProvider,
  MultiModalMemoryServiceConfig,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Multi-network memory
// ---------------------------------------------------------------------------
export { MultiNetworkMemory, DEFAULT_NETWORK_CONFIGS } from '@forgeagent/memory'
export type {
  MemoryNetwork,
  NetworkConfig,
  NetworkMemoryRecord,
  MultiNetworkSearchResult,
  NetworkStats,
  MultiNetworkMemoryConfig,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// Agent File export/import
// ---------------------------------------------------------------------------
export { AgentFileExporter, AgentFileImporter, AGENT_FILE_SCHEMA, AGENT_FILE_VERSION } from '@forgeagent/memory'
export type {
  AgentFile,
  AgentFileAgentSection,
  AgentFileMemorySection,
  AgentFileMemoryRecord,
  AgentFilePromptsSection,
  AgentFileStateSection,
  ImportOptions,
  ImportResult,
  AgentFileExporterConfig,
  ExportOptions,
} from '@forgeagent/memory'

// ---------------------------------------------------------------------------
// MCP memory handler
// ---------------------------------------------------------------------------
export { MCPMemoryHandler, MCP_MEMORY_TOOLS } from '@forgeagent/memory'
export type {
  MCPToolDefinition,
  MCPToolResult as MCPMemoryToolResult,
  MCPMemoryServices,
} from '@forgeagent/memory'
