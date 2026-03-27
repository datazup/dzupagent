/**
 * @dzipagent/core/memory — Curated API facade for memory-focused use cases.
 *
 * Exports memory service, retrieval strategies, store management,
 * consolidation, and decay — without pulling in the full core surface.
 *
 * @example
 * ```ts
 * import { MemoryService, createStore, fusionSearch } from '@dzipagent/core/memory';
 * ```
 */

// ---------------------------------------------------------------------------
// Core memory
// ---------------------------------------------------------------------------
export {
  createStore,
  MemoryService,
} from '@dzipagent/memory'
export type {
  StoreConfig,
  StoreIndexConfig,
  NamespaceConfig,
  FormatOptions,
  SemanticStoreAdapter,
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------
export {
  calculateStrength,
  reinforceMemory,
  createDecayMetadata,
  scoreWithDecay,
  findWeakMemories,
} from '@dzipagent/memory'
export type { DecayConfig, DecayMetadata } from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------
export {
  sanitizeMemoryContent,
  stripInvisibleUnicode,
} from '@dzipagent/memory'
export type { SanitizeResult } from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------
export {
  consolidateNamespace,
  consolidateAll,
  SemanticConsolidator,
  consolidateWithLLM,
} from '@dzipagent/memory'
export type {
  ConsolidationConfig,
  ConsolidationResult,
  SemanticConsolidationConfig,
  SemanticConsolidationResult,
  ConsolidationAction,
  ConsolidationDecision,
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Healer
// ---------------------------------------------------------------------------
export {
  findDuplicates,
  findContradictions,
  findStaleRecords,
  healMemory,
} from '@dzipagent/memory'
export type { HealingIssue, HealingReport, MemoryHealerConfig } from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Working Memory
// ---------------------------------------------------------------------------
export {
  WorkingMemory,
  VersionedWorkingMemory,
} from '@dzipagent/memory'
export type {
  WorkingMemoryConfig,
  VersionedWorkingMemoryConfig,
  WorkingMemoryDiff,
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Observation Extractors
// ---------------------------------------------------------------------------
export {
  ObservationExtractor,
  MemoryAwareExtractor,
} from '@dzipagent/memory'
export type {
  ObservationExtractorConfig,
  Observation,
  ObservationCategory,
  MemoryAwareExtractorConfig,
  ExtractionResult,
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Staged Writers & Policies
// ---------------------------------------------------------------------------
export {
  StagedWriter,
  PolicyAwareStagedWriter,
  defaultWritePolicy,
  composePolicies,
} from '@dzipagent/memory'
export type {
  StagedRecord,
  MemoryStage,
  StagedWriterConfig,
  PolicyAwareStagedWriterConfig,
  WritePolicy,
  WriteAction,
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Retrieval — base strategies
// ---------------------------------------------------------------------------
export {
  StoreVectorSearch,
  VectorStoreSearch,
  KeywordFTSSearch,
  EntityGraphSearch,
  fusionSearch,
} from '@dzipagent/memory'
export type {
  VectorSearchResult,
  VectorSearchProvider,
  FTSSearchResult,
  GraphSearchResult,
  FusedResult,
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Retrieval — adaptive
// ---------------------------------------------------------------------------
export {
  AdaptiveRetriever,
  DEFAULT_STRATEGIES,
  classifyIntent,
} from '@dzipagent/memory'
export type {
  QueryIntent,
  RetrievalWeights,
  RetrievalStrategy,
  RetrievalProviders,
  AdaptiveRetrieverConfig,
  AdaptiveSearchResult,
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Retrieval — graph
// ---------------------------------------------------------------------------
export { PersistentEntityGraph } from '@dzipagent/memory'
export type { EntityNode, GraphTraversalResult } from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Retrieval — advanced (void filter, hub dampening, PageRank, reranking)
// ---------------------------------------------------------------------------
export { voidFilter } from '@dzipagent/memory'
export type { MemoryState, VoidFilterConfig, VoidFilterResult } from '@dzipagent/memory'

export { applyHubDampening, getAccessCount } from '@dzipagent/memory'
export type { HubDampenedResult, HubDampeningConfig } from '@dzipagent/memory'

export { computePPR, queryPPR } from '@dzipagent/memory'
export type { PPRConfig, PPRResult } from '@dzipagent/memory'

export { rerank, createLLMReranker } from '@dzipagent/memory'
export type { CrossEncoderProvider, RerankerConfig, RerankedResult } from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Retrieval — relationships & communities
// ---------------------------------------------------------------------------
export { RelationshipStore } from '@dzipagent/memory'
export type {
  RelationshipType,
  RelationshipEdge,
  EdgeMetadata,
  TraversalResult,
} from '@dzipagent/memory'

export { CommunityDetector } from '@dzipagent/memory'
export type {
  MemoryCommunity,
  CommunityDetectorConfig,
  CommunityDetectionResult,
} from '@dzipagent/memory'

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
} from '@dzipagent/memory'
export type { TemporalMetadata, TemporalQuery, TemporalChange } from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Scoped / multi-agent memory
// ---------------------------------------------------------------------------
export {
  ScopedMemoryService,
  createAgentMemories,
  PolicyTemplates,
} from '@dzipagent/memory'
export type {
  MemoryAccessPolicy,
  NamespaceAccess,
  AccessViolation,
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Dual-stream & sleep consolidation
// ---------------------------------------------------------------------------
export { DualStreamWriter } from '@dzipagent/memory'
export type { DualStreamConfig, PendingRecord, IngestResult } from '@dzipagent/memory'

export { SleepConsolidator, runSleepConsolidation } from '@dzipagent/memory'
export type {
  SleepConsolidationConfig,
  SleepConsolidationReport,
  SleepPhase,
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Observational memory
// ---------------------------------------------------------------------------
export { ObservationalMemory } from '@dzipagent/memory'
export type {
  ObservationalMemoryConfig,
  ObservationalMemoryStats,
  ObserverResult,
  ReflectorResult,
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------
export {
  ProvenanceWriter,
  createProvenance,
  extractProvenance,
  createContentHash,
} from '@dzipagent/memory'
export type {
  MemoryProvenance,
  ProvenanceSource,
  ProvenanceWriteOptions,
  ProvenanceQuery,
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Frozen Snapshot
// ---------------------------------------------------------------------------
export { FrozenMemorySnapshot } from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------
export { EnvKeyProvider, EncryptedMemoryService } from '@dzipagent/memory'
export type {
  EncryptedEnvelope,
  EncryptionKeyDescriptor,
  EncryptionKeyProvider,
  EncryptedMemoryServiceConfig,
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Convention detection
// ---------------------------------------------------------------------------
export { ConventionExtractor, ALL_CONVENTION_CATEGORIES } from '@dzipagent/memory'
export type {
  ConventionCategory,
  DetectedConvention,
  ConventionCheckResult,
  ConventionFollowed,
  ConventionViolated,
  ConventionExtractorConfig,
  ConventionFilter,
  ConsolidateOptions,
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Causal graph
// ---------------------------------------------------------------------------
export { CausalGraph } from '@dzipagent/memory'
export type {
  CausalRelation,
  CausalNode,
  CausalTraversalOptions,
  CausalGraphResult,
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Shared memory spaces & CRDTs
// ---------------------------------------------------------------------------
export { MemorySpaceManager } from '@dzipagent/memory'
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
} from '@dzipagent/memory'

export { HLC, CRDTResolver } from '@dzipagent/memory'
export type {
  HLCTimestamp,
  LWWRegister,
  ORSetEntry,
  ORSet,
  LWWMap,
  MergeResult,
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Multi-modal memory
// ---------------------------------------------------------------------------
export {
  MultiModalMemoryService,
  InMemoryAttachmentStorage,
  inferAttachmentType,
} from '@dzipagent/memory'
export type {
  AttachmentType,
  MemoryAttachment,
  AttachmentStorageProvider,
  MultiModalMemoryServiceConfig,
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Multi-network memory
// ---------------------------------------------------------------------------
export { MultiNetworkMemory, DEFAULT_NETWORK_CONFIGS } from '@dzipagent/memory'
export type {
  MemoryNetwork,
  NetworkConfig,
  NetworkMemoryRecord,
  MultiNetworkSearchResult,
  NetworkStats,
  MultiNetworkMemoryConfig,
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// Agent File export/import
// ---------------------------------------------------------------------------
export { AgentFileExporter, AgentFileImporter, AGENT_FILE_SCHEMA, AGENT_FILE_VERSION } from '@dzipagent/memory'
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
} from '@dzipagent/memory'

// ---------------------------------------------------------------------------
// MCP memory handler
// ---------------------------------------------------------------------------
export { MCPMemoryHandler, MCP_MEMORY_TOOLS } from '@dzipagent/memory'
export type {
  MCPToolDefinition,
  MCPToolResult as MCPMemoryToolResult,
  MCPMemoryServices,
} from '@dzipagent/memory'
