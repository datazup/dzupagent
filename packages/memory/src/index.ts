/**
 * @forgeagent/memory — Reusable memory management for LLM agents.
 *
 * Provides namespace-scoped memory service, decay engine, consolidation,
 * sanitization, staged writing, working memory, retrieval (vector, FTS,
 * graph, RRF fusion), and store backends.
 */

// --- Store ---
export { createStore } from './store-factory.js'
export type { StoreConfig, StoreIndexConfig } from './store-factory.js'

// --- Core Service ---
export { MemoryService } from './memory-service.js'

// --- Types ---
export type { NamespaceConfig, FormatOptions, DecayConfig, SemanticStoreAdapter } from './memory-types.js'

// --- Decay Engine ---
export { calculateStrength, reinforceMemory, createDecayMetadata, scoreWithDecay, findWeakMemories } from './decay-engine.js'
export type { DecayMetadata } from './decay-engine.js'

// --- Sanitization ---
export { sanitizeMemoryContent, stripInvisibleUnicode } from './memory-sanitizer.js'
export type { SanitizeResult } from './memory-sanitizer.js'

// --- Consolidation ---
export { consolidateNamespace, consolidateAll } from './memory-consolidation.js'
export type { ConsolidationConfig, ConsolidationResult } from './memory-consolidation.js'

// --- Semantic Consolidation (LLM-powered) ---
export { SemanticConsolidator, consolidateWithLLM } from './semantic-consolidation.js'
export type { SemanticConsolidationConfig, SemanticConsolidationResult, ConsolidationAction, ConsolidationDecision } from './semantic-consolidation.js'

// --- Healer ---
export { findDuplicates, findContradictions, findStaleRecords, healMemory } from './memory-healer.js'
export type { HealingIssue, HealingReport, MemoryHealerConfig } from './memory-healer.js'

// --- Working Memory ---
export { WorkingMemory } from './working-memory.js'
export type { WorkingMemoryConfig } from './working-memory.js'

// --- Versioned Working Memory ---
export { VersionedWorkingMemory } from './versioned-working-memory.js'
export type { VersionedWorkingMemoryConfig, WorkingMemoryDiff } from './versioned-working-memory.js'

// --- Observation Extractor ---
export { ObservationExtractor } from './observation-extractor.js'
export type { ObservationExtractorConfig, Observation, ObservationCategory } from './observation-extractor.js'

// --- Memory-Aware Extractor ---
export { MemoryAwareExtractor } from './memory-aware-extractor.js'
export type { MemoryAwareExtractorConfig, ExtractionResult } from './memory-aware-extractor.js'

// --- Frozen Snapshot ---
export { FrozenMemorySnapshot } from './frozen-snapshot.js'

// --- Staged Writer ---
export { StagedWriter } from './staged-writer.js'
export type { StagedRecord, MemoryStage, StagedWriterConfig } from './staged-writer.js'

// --- Policy-Aware Staged Writer ---
export { PolicyAwareStagedWriter } from './policy-aware-staged-writer.js'
export type { PolicyAwareStagedWriterConfig } from './policy-aware-staged-writer.js'

// --- Write Policy ---
export { defaultWritePolicy, composePolicies } from './write-policy.js'
export type { WritePolicy, WriteAction } from './write-policy.js'

// --- Retrieval ---
export { StoreVectorSearch } from './retrieval/vector-search.js'
export { VectorStoreSearch } from './retrieval/vector-store-search.js'
export type { VectorSearchResult, VectorSearchProvider } from './retrieval/vector-search.js'

export { KeywordFTSSearch } from './retrieval/fts-search.js'
export type { FTSSearchResult } from './retrieval/fts-search.js'

export { EntityGraphSearch } from './retrieval/graph-search.js'
export type { GraphSearchResult } from './retrieval/graph-search.js'

// --- Persistent Entity Graph ---
export { PersistentEntityGraph } from './retrieval/persistent-graph.js'
export type { EntityNode, GraphTraversalResult } from './retrieval/persistent-graph.js'

export { fusionSearch } from './retrieval/rrf-fusion.js'
export type { FusedResult } from './retrieval/rrf-fusion.js'

// --- Adaptive Retrieval ---
export { AdaptiveRetriever, WeightLearner, DEFAULT_STRATEGIES, classifyIntent } from './retrieval/adaptive-retriever.js'
export type {
  QueryIntent,
  RetrievalWeights,
  RetrievalStrategy,
  RetrievalProviders,
  AdaptiveRetrieverConfig,
  AdaptiveSearchResult,
  RetrievalEventEmitter,
  RetrievalWarning,
  ProviderHealthMetrics,
  WeightLearnerConfig,
  FeedbackQuality,
} from './retrieval/adaptive-retriever.js'

// --- Temporal Memory ---
export { TemporalMemoryService, createTemporalMeta, isActive, wasActiveAsOf, wasValidAt, filterByTemporal } from './temporal.js'
export type { TemporalMetadata, TemporalQuery, TemporalChange } from './temporal.js'

// --- Scoped Memory (Multi-Agent) ---
export { ScopedMemoryService, createAgentMemories, PolicyTemplates } from './scoped-memory.js'
export type { MemoryAccessPolicy, NamespaceAccess, AccessViolation } from './scoped-memory.js'

// --- Void Filter (ternary state filtering) ---
export { voidFilter } from './retrieval/void-filter.js'
export type { MemoryState, VoidFilterConfig, VoidFilterResult } from './retrieval/void-filter.js'

// --- Hub Dampening ---
export { applyHubDampening, getAccessCount } from './retrieval/hub-dampening.js'
export type { HubDampenedResult, HubDampeningConfig } from './retrieval/hub-dampening.js'

// --- Personalized PageRank ---
export { computePPR, queryPPR } from './retrieval/pagerank.js'
export type { PPRConfig, PPRResult } from './retrieval/pagerank.js'

// --- Cross-Encoder Reranking ---
export { rerank, createLLMReranker } from './retrieval/cross-encoder-rerank.js'
export type { CrossEncoderProvider, RerankerConfig, RerankedResult } from './retrieval/cross-encoder-rerank.js'

// --- Dual-Stream Writer (MAGMA fast/slow path) ---
export { DualStreamWriter } from './dual-stream-writer.js'
export type { DualStreamConfig, PendingRecord, IngestResult } from './dual-stream-writer.js'

// --- Sleep-Time Consolidation ---
export { SleepConsolidator, runSleepConsolidation } from './sleep-consolidator.js'
export type { SleepConsolidationConfig, SleepConsolidationReport, SleepPhase } from './sleep-consolidator.js'

// --- Community Detection ---
export { CommunityDetector } from './retrieval/community-detector.js'
export type { MemoryCommunity, CommunityDetectorConfig, CommunityDetectionResult } from './retrieval/community-detector.js'

// --- Observational Memory (Observer/Reflector) ---
export { ObservationalMemory } from './observational-memory.js'
export type { ObservationalMemoryConfig, ObservationalMemoryStats, ObserverResult, ReflectorResult } from './observational-memory.js'

// --- Relationship Store (Knowledge Graph Edges) ---
export { RelationshipStore } from './retrieval/relationship-store.js'
export type { RelationshipType, RelationshipEdge, EdgeMetadata, TraversalResult } from './retrieval/relationship-store.js'

// --- Multi-Network Memory ---
export { MultiNetworkMemory, DEFAULT_NETWORK_CONFIGS } from './multi-network-memory.js'
export type { MemoryNetwork, NetworkConfig, NetworkMemoryRecord, MultiNetworkSearchResult, NetworkStats, MultiNetworkMemoryConfig } from './multi-network-memory.js'

// --- Provenance ---
export { ProvenanceWriter, createProvenance, extractProvenance, createContentHash } from './provenance/index.js'
export type { MemoryProvenance, ProvenanceSource, ProvenanceWriteOptions, ProvenanceQuery } from './provenance/index.js'

// --- Convention Detection & Conformance ---
export { ConventionExtractor, ALL_CONVENTION_CATEGORIES } from './convention/index.js'
export type {
  ConventionCategory,
  DetectedConvention,
  ConventionCheckResult,
  ConventionFollowed,
  ConventionViolated,
  ConventionExtractorConfig,
  ConventionFilter,
  ConsolidateOptions,
} from './convention/index.js'

// --- Causal Graph ---
export { CausalGraph } from './causal/index.js'
export type { CausalRelation, CausalNode, CausalTraversalOptions, CausalGraphResult } from './causal/index.js'

// --- MCP Memory Server ---
export { MCPMemoryHandler, MCP_MEMORY_TOOLS } from './mcp-memory-server.js'
export type { MCPToolDefinition, MCPToolResult, MCPMemoryServices } from './mcp-memory-server.js'

// --- Encryption ---
export { EnvKeyProvider, EncryptedMemoryService } from './encryption/index.js'
export type {
  EncryptedEnvelope,
  EncryptionKeyDescriptor,
  EncryptionKeyProvider,
  EncryptedMemoryServiceConfig,
} from './encryption/index.js'

// --- Agent File (Export/Import) ---
export { AgentFileExporter } from './agent-file/index.js'
export type { AgentFileExporterConfig, ExportOptions } from './agent-file/index.js'
export { AgentFileImporter } from './agent-file/index.js'
export { AGENT_FILE_SCHEMA, AGENT_FILE_VERSION } from './agent-file/index.js'
export type {
  AgentFile,
  AgentFileAgentSection,
  AgentFileMemorySection,
  AgentFileMemoryRecord,
  AgentFilePromptsSection,
  AgentFileStateSection,
  ImportOptions,
  ImportResult,
} from './agent-file/index.js'

// --- CRDT (Conflict-Free Replicated Data Types) ---
export { HLC } from './crdt/index.js'
export { CRDTResolver } from './crdt/index.js'
export type {
  HLCTimestamp,
  LWWRegister,
  ORSetEntry,
  ORSet,
  LWWMap,
  MergeResult,
} from './crdt/index.js'

// --- Shared Memory Spaces ---
export { MemorySpaceManager } from './sharing/index.js'
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
} from './sharing/index.js'

// --- Multi-Modal Memory (ECO-060) ---
export { MultiModalMemoryService, InMemoryAttachmentStorage, inferAttachmentType } from './multi-modal/index.js'
export type {
  AttachmentType,
  MemoryAttachment,
  AttachmentStorageProvider,
  MultiModalMemoryServiceConfig,
} from './multi-modal/index.js'

// --- M4 Consolidation Types ---
export { parseMemoryEntry } from './consolidation-types.js'
export type {
  MemoryEntry,
  LessonDedupResult,
  DedupLesson,
  StalenessPruneResult,
  ExtractedConvention,
  ConventionExtractionResult,
} from './consolidation-types.js'

// --- M4 Lesson Deduplication ---
export { dedupLessons } from './lesson-dedup.js'

// --- M4 Convention Extraction from Memories ---
export { extractConventions } from './convention/convention-extractor-m4.js'

// --- M4 Staleness Pruner ---
export { pruneStaleMemories, computeStaleness } from './staleness-pruner.js'
export type { StalenessPrunerOptions } from './staleness-pruner.js'

// --- Shared Memory Namespace (Multi-Agent Collaboration) ---
export { SharedMemoryNamespace } from './shared-namespace.js'
export type {
  SharedEntry,
  SharedNamespaceConfig,
  AuditEntry,
  SharedNamespaceStats,
  MergeReport,
  ConflictEntry,
} from './shared-namespace.js'

// --- Vector Clock (Causal Ordering) ---
export { VectorClock } from './vector-clock.js'
export type { VectorClockComparison } from './vector-clock.js'

// --- CRDT Network Sync Protocol ---
export { MerkleDigest } from './sync/index.js'
export { SyncProtocol } from './sync/index.js'
export { SyncSession } from './sync/index.js'
export { WebSocketSyncTransport } from './sync/index.js'
export type { WebSocketLike } from './sync/index.js'
export type {
  SyncDigest,
  SyncDelta,
  SyncMessage,
  SyncHelloMessage,
  SyncDigestMessage,
  SyncRequestDeltaMessage,
  SyncDeltaMessage,
  SyncAckMessage,
  SyncErrorMessage,
  SyncSessionState,
  SyncConfig,
  SyncTransport,
  SyncEvent,
  SyncConnectedEvent,
  SyncDisconnectedEvent,
  SyncDeltaSentEvent,
  SyncDeltaReceivedEvent,
  SyncErrorEvent,
  SyncStats,
} from './sync/index.js'

// --- Team Memory Graph ---
export { TeamMemoryGraph } from './graph/index.js'
export { TrustScorer } from './graph/index.js'
export { ConflictResolver } from './graph/index.js'
export { GraphQuery } from './graph/index.js'
export type {
  GraphNode,
  GraphEdge,
  GraphNodeType,
  GraphEdgeType,
  GraphNodeProvenance,
  TrustProfile,
  ConflictRecord,
  GraphConflictStrategy,
  GraphQueryFilter,
  TeamGraphConfig,
} from './graph/index.js'
