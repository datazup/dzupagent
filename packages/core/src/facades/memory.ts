/**
 * @dzupagent/core/memory — Curated API facade for memory-focused use cases.
 *
 * Exports memory service, retrieval strategies, store management,
 * consolidation, and decay — without pulling in the full core surface.
 *
 * @example
 * ```ts
 * import { MemoryService, createStore, fusionSearch } from '@dzupagent/core/memory';
 * ```
 */

// ---------------------------------------------------------------------------
// Core memory
// ---------------------------------------------------------------------------
export {
  createStore,
  MemoryService,
} from '@dzupagent/memory'
export type {
  StoreConfig,
  StoreIndexConfig,
  NamespaceConfig,
  FormatOptions,
  SemanticStoreAdapter,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------
export {
  calculateStrength,
  reinforceMemory,
  createDecayMetadata,
  scoreWithDecay,
  findWeakMemories,
} from '@dzupagent/memory'
export type { DecayConfig, DecayMetadata } from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------
export {
  sanitizeMemoryContent,
  stripInvisibleUnicode,
} from '@dzupagent/memory'
export type { SanitizeResult } from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------
export {
  consolidateNamespace,
  consolidateAll,
  SemanticConsolidator,
  consolidateWithLLM,
} from '@dzupagent/memory'
export type {
  ConsolidationConfig,
  ConsolidationResult,
  SemanticConsolidationConfig,
  SemanticConsolidationResult,
  ConsolidationAction,
  ConsolidationDecision,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Healer
// ---------------------------------------------------------------------------
export {
  findDuplicates,
  findContradictions,
  findStaleRecords,
  healMemory,
} from '@dzupagent/memory'
export type { HealingIssue, HealingReport, MemoryHealerConfig } from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Working Memory
// ---------------------------------------------------------------------------
export {
  WorkingMemory,
  VersionedWorkingMemory,
} from '@dzupagent/memory'
export type {
  WorkingMemoryConfig,
  VersionedWorkingMemoryConfig,
  WorkingMemoryDiff,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Observation Extractors
// ---------------------------------------------------------------------------
export {
  ObservationExtractor,
  MemoryAwareExtractor,
} from '@dzupagent/memory'
export type {
  ObservationExtractorConfig,
  Observation,
  ObservationCategory,
  MemoryAwareExtractorConfig,
  ExtractionResult,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Staged Writers & Policies
// ---------------------------------------------------------------------------
export {
  StagedWriter,
  PolicyAwareStagedWriter,
  defaultWritePolicy,
  composePolicies,
} from '@dzupagent/memory'
export type {
  StagedRecord,
  MemoryStage,
  StagedWriterConfig,
  PolicyAwareStagedWriterConfig,
  WritePolicy,
  WriteAction,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Retrieval — base strategies
// ---------------------------------------------------------------------------
export {
  StoreVectorSearch,
  VectorStoreSearch,
  KeywordFTSSearch,
  EntityGraphSearch,
  fusionSearch,
} from '@dzupagent/memory'
export type {
  VectorSearchResult,
  VectorSearchProvider,
  FTSSearchResult,
  GraphSearchResult,
  FusedResult,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Retrieval — adaptive
// ---------------------------------------------------------------------------
export {
  AdaptiveRetriever,
  DEFAULT_STRATEGIES,
  classifyIntent,
} from '@dzupagent/memory'
export type {
  QueryIntent,
  RetrievalWeights,
  RetrievalStrategy,
  RetrievalProviders,
  AdaptiveRetrieverConfig,
  AdaptiveSearchResult,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Retrieval — graph
// ---------------------------------------------------------------------------
export { PersistentEntityGraph } from '@dzupagent/memory'
export type { EntityNode, GraphTraversalResult } from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Retrieval — advanced (void filter, hub dampening, PageRank, reranking)
// ---------------------------------------------------------------------------
export { voidFilter } from '@dzupagent/memory'
export type { MemoryState, VoidFilterConfig, VoidFilterResult } from '@dzupagent/memory'

export { applyHubDampening, getAccessCount } from '@dzupagent/memory'
export type { HubDampenedResult, HubDampeningConfig } from '@dzupagent/memory'

export { computePPR, queryPPR } from '@dzupagent/memory'
export type { PPRConfig, PPRResult } from '@dzupagent/memory'

export { rerank, createLLMReranker } from '@dzupagent/memory'
export type { CrossEncoderProvider, RerankerConfig, RerankedResult } from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Retrieval — relationships & communities
// ---------------------------------------------------------------------------
export { RelationshipStore } from '@dzupagent/memory'
export type {
  RelationshipType,
  RelationshipEdge,
  EdgeMetadata,
  TraversalResult,
} from '@dzupagent/memory'

export { CommunityDetector } from '@dzupagent/memory'
export type {
  MemoryCommunity,
  CommunityDetectorConfig,
  CommunityDetectionResult,
} from '@dzupagent/memory'

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
} from '@dzupagent/memory'
export type { TemporalMetadata, TemporalQuery, TemporalChange } from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Scoped / multi-agent memory
// ---------------------------------------------------------------------------
export {
  ScopedMemoryService,
  createAgentMemories,
  PolicyTemplates,
} from '@dzupagent/memory'
export type {
  MemoryAccessPolicy,
  NamespaceAccess,
  AccessViolation,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Dual-stream & sleep consolidation
// ---------------------------------------------------------------------------
export { DualStreamWriter } from '@dzupagent/memory'
export type { DualStreamConfig, PendingRecord, IngestResult } from '@dzupagent/memory'

export { SleepConsolidator, runSleepConsolidation } from '@dzupagent/memory'
export type {
  SleepConsolidationConfig,
  SleepConsolidationReport,
  SleepPhase,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Observational memory
// ---------------------------------------------------------------------------
export { ObservationalMemory } from '@dzupagent/memory'
export type {
  ObservationalMemoryConfig,
  ObservationalMemoryStats,
  ObserverResult,
  ReflectorResult,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------
export {
  ProvenanceWriter,
  createProvenance,
  extractProvenance,
  createContentHash,
} from '@dzupagent/memory'
export type {
  MemoryProvenance,
  ProvenanceSource,
  ProvenanceWriteOptions,
  ProvenanceQuery,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Frozen Snapshot
// ---------------------------------------------------------------------------
export { FrozenMemorySnapshot } from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------
export { EnvKeyProvider, EncryptedMemoryService } from '@dzupagent/memory'
export type {
  EncryptedEnvelope,
  EncryptionKeyDescriptor,
  EncryptionKeyProvider,
  EncryptedMemoryServiceConfig,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Convention detection
// ---------------------------------------------------------------------------
export { ConventionExtractor, ALL_CONVENTION_CATEGORIES } from '@dzupagent/memory'
export type {
  ConventionCategory,
  DetectedConvention,
  ConventionCheckResult,
  ConventionFollowed,
  ConventionViolated,
  ConventionExtractorConfig,
  ConventionFilter,
  ConsolidateOptions,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Causal graph
// ---------------------------------------------------------------------------
export { CausalGraph } from '@dzupagent/memory'
export type {
  CausalRelation,
  CausalNode,
  CausalTraversalOptions,
  CausalGraphResult,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Shared memory spaces & CRDTs
// ---------------------------------------------------------------------------
export { MemorySpaceManager } from '@dzupagent/memory'
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
} from '@dzupagent/memory'

export { HLC, CRDTResolver } from '@dzupagent/memory'
export type {
  HLCTimestamp,
  LWWRegister,
  ORSetEntry,
  ORSet,
  LWWMap,
  MergeResult,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Multi-modal memory
// ---------------------------------------------------------------------------
export {
  MultiModalMemoryService,
  InMemoryAttachmentStorage,
  inferAttachmentType,
} from '@dzupagent/memory'
export type {
  AttachmentType,
  MemoryAttachment,
  AttachmentStorageProvider,
  MultiModalMemoryServiceConfig,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Multi-network memory
// ---------------------------------------------------------------------------
export { MultiNetworkMemory, DEFAULT_NETWORK_CONFIGS } from '@dzupagent/memory'
export type {
  MemoryNetwork,
  NetworkConfig,
  NetworkMemoryRecord,
  MultiNetworkSearchResult,
  NetworkStats,
  MultiNetworkMemoryConfig,
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// Agent File export/import
// ---------------------------------------------------------------------------
export { AgentFileExporter, AgentFileImporter, AGENT_FILE_SCHEMA, AGENT_FILE_VERSION } from '@dzupagent/memory'
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
} from '@dzupagent/memory'

// ---------------------------------------------------------------------------
// MCP memory handler
// ---------------------------------------------------------------------------
export { MCPMemoryHandler, MCP_MEMORY_TOOLS } from '@dzupagent/memory'
export type {
  MCPToolDefinition,
  MCPToolResult as MCPMemoryToolResult,
  MCPMemoryServices,
} from '@dzupagent/memory'
