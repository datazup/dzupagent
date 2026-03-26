/**
 * @forgeagent/core — Base agent infrastructure
 *
 * Reusable LLM agent engine: model registry, prompt management,
 * memory, context engineering, middleware, persistence, routing,
 * streaming, sub-agents, and skills.
 */

// --- Config / DI ---
export { ForgeContainer, createContainer } from './config/container.js'

// --- Errors ---
export { ForgeError } from './errors/forge-error.js'
export type { ForgeErrorOptions } from './errors/forge-error.js'
export type { ForgeErrorCode } from './errors/error-codes.js'

// --- Events ---
export { createEventBus } from './events/event-bus.js'
export type { ForgeEventBus } from './events/event-bus.js'
export type { ForgeEvent, ForgeEventOf, BudgetUsage, ToolStatSummary } from './events/event-types.js'
export { AgentBus } from './events/agent-bus.js'
export type { AgentMessage, AgentMessageHandler } from './events/agent-bus.js'

// --- Hooks ---
export type { AgentHooks, HookContext } from './hooks/hook-types.js'
export { runHooks, runModifierHook, mergeHooks } from './hooks/hook-runner.js'

// --- Plugin ---
export type { ForgePlugin, PluginContext } from './plugin/plugin-types.js'
export { PluginRegistry } from './plugin/plugin-registry.js'
export { discoverPlugins, validateManifest, resolvePluginOrder } from './plugin/plugin-discovery.js'
export type { PluginManifest, DiscoveredPlugin, PluginDiscoveryConfig } from './plugin/plugin-discovery.js'
export { createManifest, serializeManifest } from './plugin/plugin-manifest.js'

// --- LLM ---
export { ModelRegistry } from './llm/model-registry.js'
export type { LLMProviderConfig, ModelTier, ModelSpec, ModelOverrides, ModelFactory } from './llm/model-config.js'
export { CircuitBreaker } from './llm/circuit-breaker.js'
export type { CircuitBreakerConfig, CircuitState } from './llm/circuit-breaker.js'
export { invokeWithTimeout, extractTokenUsage, estimateTokens } from './llm/invoke.js'
export type { TokenUsage, InvokeOptions } from './llm/invoke.js'
export { isTransientError, DEFAULT_RETRY_CONFIG } from './llm/retry.js'
export type { RetryConfig } from './llm/retry.js'

// --- Prompt ---
export {
  FRAGMENT_CORE_PRINCIPLES,
  FRAGMENT_SECURITY_CHECKLIST,
  FRAGMENT_SIMPLICITY,
  FRAGMENT_READ_DISCIPLINE,
  FRAGMENT_SCOPE_BOUNDARY,
  FRAGMENT_VERIFICATION_MINDSET,
  FRAGMENT_BLOCKED_HANDLING,
  FRAGMENT_OUTPUT_EFFICIENCY,
  FRAGMENT_WORKER_REPORT,
  PROMPT_FRAGMENTS,
  composeFragments,
} from './prompt/prompt-fragments.js'
export { composeAdvancedFragments, validateFragments } from './prompt/fragment-composer.js'
export type { ComposableFragment, ComposeResult } from './prompt/fragment-composer.js'
export { resolveTemplate, extractVariables, validateTemplate, flattenContext } from './prompt/template-engine.js'
export { PromptResolver } from './prompt/template-resolver.js'
export type { PromptStore, ResolutionLevel } from './prompt/template-resolver.js'
export { PromptCache } from './prompt/template-cache.js'
export type {
  TemplateVariable,
  TemplateContext,
  ResolvedPrompt,
  StoredTemplate,
  PromptResolveQuery,
  BulkPromptQuery,
} from './prompt/template-types.js'

// --- Memory (re-exported from @forgeagent/memory) ---
export {
  // Core
  createStore,
  MemoryService,
  // Decay
  calculateStrength, reinforceMemory, createDecayMetadata, scoreWithDecay, findWeakMemories,
  // Sanitization
  sanitizeMemoryContent, stripInvisibleUnicode,
  // Consolidation (heuristic)
  consolidateNamespace, consolidateAll,
  // Consolidation (LLM-powered) — Sprint 1
  SemanticConsolidator, consolidateWithLLM,
  // Healer
  findDuplicates, findContradictions, findStaleRecords, healMemory,
  // Working Memory
  WorkingMemory,
  VersionedWorkingMemory,
  // Observation Extractors
  ObservationExtractor,
  MemoryAwareExtractor,
  // Frozen Snapshot
  FrozenMemorySnapshot,
  // Staged Writers
  StagedWriter,
  PolicyAwareStagedWriter,
  // Write Policy
  defaultWritePolicy, composePolicies,
  // Retrieval — base
  StoreVectorSearch,
  VectorStoreSearch,
  KeywordFTSSearch,
  EntityGraphSearch,
  fusionSearch,
  // Retrieval — persistent graph (Sprint 2)
  PersistentEntityGraph,
  // Retrieval — adaptive (Sprint 2)
  AdaptiveRetriever, DEFAULT_STRATEGIES, classifyIntent,
  // Retrieval — void filter (Sprint 4)
  voidFilter,
  // Retrieval — hub dampening (Sprint 4)
  applyHubDampening, getAccessCount,
  // Retrieval — PageRank (Sprint 4)
  computePPR, queryPPR,
  // Retrieval — cross-encoder reranking (Sprint 4)
  rerank, createLLMReranker,
  // Retrieval — relationship store (Sprint 5)
  RelationshipStore,
  // Retrieval — community detection (Sprint 5)
  CommunityDetector,
  // Temporal memory (Sprint 2)
  TemporalMemoryService, createTemporalMeta, isActive, wasActiveAsOf, wasValidAt, filterByTemporal,
  // Scoped memory / multi-agent (Sprint 3)
  ScopedMemoryService, createAgentMemories, PolicyTemplates,
  // Dual-stream writer (Sprint 4)
  DualStreamWriter,
  // Sleep-time consolidation (Sprint 5)
  SleepConsolidator, runSleepConsolidation,
  // Observational memory (Sprint 5)
  ObservationalMemory,
  // Provenance tracking
  ProvenanceWriter, createProvenance, extractProvenance, createContentHash,
  // MCP memory server (Sprint 6)
  MCPMemoryHandler, MCP_MEMORY_TOOLS,
  // Multi-network memory (Sprint 6)
  MultiNetworkMemory, DEFAULT_NETWORK_CONFIGS,
  // Encryption (ECO-041/042)
  EnvKeyProvider, EncryptedMemoryService,
  // Convention detection (ECO-039/040)
  ConventionExtractor, ALL_CONVENTION_CATEGORIES,
  // Causal graph (ECO-037/038)
  CausalGraph,
  // Agent File export/import (ECO-046/047)
  AgentFileExporter, AgentFileImporter, AGENT_FILE_SCHEMA, AGENT_FILE_VERSION,
  // Shared memory spaces (ECO-043/044/045)
  MemorySpaceManager,
  // CRDT conflict resolution (ECO-057/058/059)
  HLC, CRDTResolver,
  // Multi-modal memory (ECO-060)
  MultiModalMemoryService, InMemoryAttachmentStorage, inferAttachmentType,
} from '@forgeagent/memory'
export type {
  // Core types
  StoreConfig, StoreIndexConfig,
  NamespaceConfig, FormatOptions, DecayConfig, SemanticStoreAdapter,
  DecayMetadata,
  SanitizeResult,
  ConsolidationConfig, ConsolidationResult,
  // Semantic consolidation types
  SemanticConsolidationConfig, SemanticConsolidationResult, ConsolidationAction, ConsolidationDecision,
  // Healer types
  HealingIssue, HealingReport, MemoryHealerConfig,
  // Working memory types
  WorkingMemoryConfig,
  VersionedWorkingMemoryConfig, WorkingMemoryDiff,
  // Observation types
  ObservationExtractorConfig, Observation, ObservationCategory,
  MemoryAwareExtractorConfig, ExtractionResult,
  // Staged writer types
  StagedRecord, MemoryStage, StagedWriterConfig,
  PolicyAwareStagedWriterConfig,
  // Write policy types
  WritePolicy, WriteAction,
  // Retrieval types — base
  VectorSearchResult, VectorSearchProvider,
  FTSSearchResult,
  GraphSearchResult,
  FusedResult,
  // Retrieval types — persistent graph
  EntityNode, GraphTraversalResult,
  // Retrieval types — adaptive
  QueryIntent, RetrievalWeights, RetrievalStrategy, RetrievalProviders, AdaptiveRetrieverConfig, AdaptiveSearchResult,
  // Retrieval types — void filter
  MemoryState, VoidFilterConfig, VoidFilterResult,
  // Retrieval types — hub dampening
  HubDampenedResult, HubDampeningConfig,
  // Retrieval types — PageRank
  PPRConfig, PPRResult,
  // Retrieval types — cross-encoder
  CrossEncoderProvider, RerankerConfig, RerankedResult,
  // Retrieval types — relationships
  RelationshipType, RelationshipEdge, EdgeMetadata, TraversalResult,
  // Retrieval types — community
  MemoryCommunity, CommunityDetectorConfig, CommunityDetectionResult,
  // Temporal types
  TemporalMetadata, TemporalQuery, TemporalChange,
  // Scoped memory types
  MemoryAccessPolicy, NamespaceAccess, AccessViolation,
  // Dual-stream types
  DualStreamConfig, PendingRecord, IngestResult,
  // Sleep consolidation types
  SleepConsolidationConfig, SleepConsolidationReport, SleepPhase,
  // Observational memory types
  ObservationalMemoryConfig, ObservationalMemoryStats, ObserverResult, ReflectorResult,
  // Provenance types
  MemoryProvenance, ProvenanceSource, ProvenanceWriteOptions, ProvenanceQuery,
  // MCP types
  MCPToolDefinition, MCPToolResult as MCPMemoryToolResult, MCPMemoryServices,
  // Multi-network types
  MemoryNetwork, NetworkConfig, NetworkMemoryRecord, MultiNetworkSearchResult, NetworkStats, MultiNetworkMemoryConfig,
  // Encryption types
  EncryptedEnvelope, EncryptionKeyDescriptor, EncryptionKeyProvider, EncryptedMemoryServiceConfig,
  // Convention types (ECO-039/040)
  ConventionCategory, DetectedConvention, ConventionCheckResult, ConventionFollowed,
  ConventionViolated, ConventionExtractorConfig, ConventionFilter, ConsolidateOptions,
  // Causal graph types (ECO-037/038)
  CausalRelation, CausalNode, CausalTraversalOptions, CausalGraphResult,
  // Agent File types (ECO-046/047)
  AgentFile, AgentFileAgentSection, AgentFileMemorySection, AgentFileMemoryRecord,
  AgentFilePromptsSection, AgentFileStateSection, ImportOptions, ImportResult,
  AgentFileExporterConfig, ExportOptions,
  // Shared memory space types (ECO-043/044/045)
  MemorySpaceManagerConfig,
  SpacePermission, ConflictStrategy, ShareMode,
  MemoryParticipant, RetentionPolicy, SharedMemorySpace,
  MemoryShareRequest, PendingShareRequest, SharedMemoryEvent,
  // CRDT types (ECO-057/058/059)
  HLCTimestamp, LWWRegister, ORSetEntry, ORSet, LWWMap, MergeResult,
  // Multi-modal memory types (ECO-060)
  AttachmentType, MemoryAttachment, AttachmentStorageProvider, MultiModalMemoryServiceConfig,
} from '@forgeagent/memory'

// --- Context (re-exported from @forgeagent/context) ---
export {
  // Message management
  shouldSummarize,
  summarizeAndTrim,
  formatSummaryContext,
  pruneToolResults,
  repairOrphanedToolPairs,
  // Completeness
  scoreCompleteness,
  // Eviction
  evictIfNeeded,
  // System reminders
  SystemReminderInjector,
  // Prompt cache
  applyAnthropicCacheControl,
  applyCacheBreakpoints,
  // Auto-compress + extraction bridge (Sprint 2)
  autoCompress,
  FrozenSnapshot,
  createExtractionHook,
  // Phase-aware windowing (Sprint 3)
  PhaseAwareWindowManager, DEFAULT_PHASES,
  // Progressive compression (Sprint 3)
  compressToLevel, compressToBudget, selectCompressionLevel,
  // Context transfer (Sprint 3)
  ContextTransferService,
} from '@forgeagent/context'
export type {
  MessageManagerConfig,
  CompletenessResult, DescriptionInput,
  EvictionConfig, EvictionResult,
  SystemReminderConfig, ReminderContent,
  // Auto-compress types
  AutoCompressConfig, CompressResult,
  MessageExtractionFn,
  // Phase-aware types
  ConversationPhase, PhaseConfig, MessageRetention, PhaseDetection, PhaseWindowConfig,
  // Progressive compression types
  CompressionLevel, ProgressiveCompressConfig, ProgressiveCompressResult,
  // Context transfer types
  IntentContext, IntentType, ContextTransferConfig, IntentRelevanceRule, TransferScope,
} from '@forgeagent/context'

// --- Run Context Transfer ---
export { RunContextTransfer, INTENT_CONTEXT_CHAINS } from './context/run-context-transfer.js'
export type { RunContextTransferConfig, PersistedIntentContext } from './context/run-context-transfer.js'

// --- Middleware ---
export type { AgentMiddleware } from './middleware/types.js'
export { calculateCostCents, getModelCosts } from './middleware/cost-tracking.js'
export type { CostTracker } from './middleware/cost-tracking.js'
export { createLangfuseHandler } from './middleware/langfuse.js'
export type { LangfuseConfig, LangfuseHandlerOptions } from './middleware/langfuse.js'
export { CostAttributionCollector } from './middleware/cost-attribution.js'
export type { CostAttribution, CostReport, CostBucket, CostAttributionConfig } from './middleware/cost-attribution.js'

// --- Persistence ---
export { createCheckpointer } from './persistence/checkpointer.js'
export type { CheckpointerConfig } from './persistence/checkpointer.js'
export { SessionManager } from './persistence/session.js'
export { InMemoryRunStore, InMemoryAgentStore } from './persistence/in-memory-store.js'
export type {
  RunStore, Run, CreateRunInput, RunFilter, RunStatus, LogEntry,
  AgentStore, AgentDefinition, AgentFilter,
} from './persistence/store-interfaces.js'
export { InMemoryEventLog, EventLogSink } from './persistence/event-log.js'
export type { RunEvent, EventLogStore } from './persistence/event-log.js'

// --- Router ---
export { IntentRouter } from './router/intent-router.js'
export type { IntentRouterConfig, ClassificationResult } from './router/intent-router.js'
export { KeywordMatcher } from './router/keyword-matcher.js'
export { LLMClassifier } from './router/llm-classifier.js'
export { CostAwareRouter, isSimpleTurn, scoreComplexity } from './router/cost-aware-router.js'
export type { CostAwareResult, CostAwareRouterConfig, ComplexityLevel } from './router/cost-aware-router.js'
export { ModelTierEscalationPolicy } from './router/escalation-policy.js'
export type { EscalationPolicyConfig, EscalationResult } from './router/escalation-policy.js'

// --- Streaming ---
export { SSETransformer } from './streaming/sse-transformer.js'
export type { StandardSSEEvent, StandardEventType } from './streaming/event-types.js'

// --- Sub-agents ---
export { SubAgentSpawner } from './subagent/subagent-spawner.js'
export { REACT_DEFAULTS } from './subagent/subagent-types.js'
export type { SubAgentConfig, SubAgentResult, SubAgentUsage } from './subagent/subagent-types.js'
export { mergeFileChanges, fileDataReducer } from './subagent/file-merge.js'

// --- Skills ---
export { SkillLoader } from './skills/skill-loader.js'
export { injectSkills } from './skills/skill-injector.js'
export type { SkillDefinition } from './skills/skill-types.js'
export { SkillManager } from './skills/skill-manager.js'
export type { SkillManagerConfig, CreateSkillInput, PatchSkillInput, SkillWriteResult } from './skills/skill-manager.js'
export { SkillLearner } from './skills/skill-learner.js'
export type { SkillMetrics, SkillExecutionResult, SkillLearnerConfig } from './skills/skill-learner.js'
export { createSkillChain, validateChain } from './skills/skill-chain.js'
export type { SkillChainStep, SkillChain, ChainValidationResult } from './skills/skill-chain.js'
export { parseAgentsMd, mergeAgentsMdConfigs } from './skills/agents-md-parser.js'
export type { AgentsMdConfig } from './skills/agents-md-parser.js'
export { discoverAgentConfigs } from './skills/hierarchical-walker.js'
export type { HierarchyLevel } from './skills/hierarchical-walker.js'

// --- MCP ---
export { MCPClient } from './mcp/mcp-client.js'
export { mcpToolToLangChain, mcpToolsToLangChain, langChainToolToMcp } from './mcp/mcp-tool-bridge.js'
export { DeferredToolLoader } from './mcp/deferred-loader.js'
export { ForgeAgentMCPServer } from './mcp/mcp-server.js'
export type { MCPServerOptions, MCPExposedTool, MCPRequest, MCPResponse } from './mcp/mcp-server.js'
export type {
  MCPTransport,
  MCPServerConfig,
  MCPToolDescriptor,
  MCPToolParameter,
  MCPToolResult,
  MCPConnectionState,
  MCPServerStatus,
} from './mcp/mcp-types.js'
export type { DeferredLoaderConfig } from './mcp/deferred-loader.js'
// MCP Resources
export { MCPResourceClient } from './mcp/mcp-resources.js'
export type { MCPResourceClientConfig } from './mcp/mcp-resources.js'
export type {
  MCPResource,
  MCPResourceTemplate,
  MCPResourceContent,
  ResourceSubscription,
  ResourceChangeHandler,
} from './mcp/mcp-resource-types.js'
// MCP Sampling
export { createSamplingHandler, registerSamplingHandler } from './mcp/mcp-sampling.js'
export type {
  MCPSamplingConfig,
  LLMInvokeMessage,
  LLMInvokeOptions,
  LLMInvokeResult,
  LLMInvokeFn,
  SamplingRegistration,
} from './mcp/mcp-sampling.js'
export type {
  MCPSamplingRequest,
  MCPSamplingResponse,
  MCPSamplingContent,
  MCPSamplingMessage,
  MCPModelPreferences,
  SamplingHandler,
} from './mcp/mcp-sampling-types.js'

// --- Security ---
export { createRiskClassifier } from './security/risk-classifier.js'
export type { RiskTier, RiskClassification, RiskClassifierConfig, RiskClassifier } from './security/risk-classifier.js'
export {
  DEFAULT_AUTO_APPROVE_TOOLS,
  DEFAULT_LOG_TOOLS,
  DEFAULT_REQUIRE_APPROVAL_TOOLS,
} from './security/tool-permission-tiers.js'
export { scanForSecrets, redactSecrets } from './security/secrets-scanner.js'
export type { SecretMatch, ScanResult } from './security/secrets-scanner.js'
export { detectPII, redactPII } from './security/pii-detector.js'
export type { PIIType, PIIMatch, PIIDetectionResult } from './security/pii-detector.js'
export { OutputPipeline, createDefaultPipeline } from './security/output-pipeline.js'
export type { SanitizationStage, OutputPipelineConfig, PipelineResult } from './security/output-pipeline.js'
// Compliance Audit Trail (ECO-145)
export { InMemoryAuditStore, ComplianceAuditLogger } from './security/audit/index.js'
export type {
  AuditActorType, AuditActor, AuditResult,
  ComplianceAuditEntry, AuditFilter, AuditRetentionPolicy,
  IntegrityCheckResult, ComplianceAuditStore, AuditLoggerConfig,
} from './security/audit/index.js'
// Policy engine (ECO-140/141/143)
export { InMemoryPolicyStore, PolicyEvaluator, PolicyTranslator } from './security/policy/index.js'
export type {
  PolicyEffect,
  PrincipalType,
  ConditionOperator,
  PolicyCondition,
  PolicyPrincipal,
  PolicyRule,
  PolicySet,
  PolicyContext,
  PolicyDecision,
  PolicyStore,
  PolicyTranslatorConfig,
  PolicyTranslationResult,
} from './security/policy/index.js'
// Safety Monitor (ECO-144)
export { createSafetyMonitor, getBuiltInRules } from './security/monitor/index.js'
export type {
  SafetyMonitor, SafetyMonitorConfig,
  SafetyCategory, SafetySeverity, SafetyAction, SafetyViolation, SafetyRule,
} from './security/monitor/index.js'
// Memory Poisoning Defense (ECO-147)
export { createMemoryDefense } from './security/memory/index.js'
export type {
  MemoryDefense, MemoryDefenseConfig, MemoryDefenseResult,
  MemoryThreat, MemoryThreatAction, EncodedContentMatch,
} from './security/memory/index.js'
// Enhanced Output Filters (ECO-149)
export { createHarmfulContentFilter, createClassificationAwareRedactor } from './security/output/index.js'
export type { HarmfulContentCategory } from './security/output/index.js'
// Data Classification (ECO-182)
export { DataClassifier, DEFAULT_CLASSIFICATION_PATTERNS } from './security/classification/index.js'
export type {
  ClassificationLevel,
  DataClassificationTag,
  ClassificationPattern,
  ClassificationConfig,
} from './security/classification/index.js'

// --- Observability ---
export { MetricsCollector, globalMetrics } from './observability/metrics-collector.js'
export type { MetricType } from './observability/metrics-collector.js'
export { HealthAggregator } from './observability/health-aggregator.js'
export type { HealthStatus, HealthCheck, HealthReport, HealthCheckFn } from './observability/health-aggregator.js'

// --- Concurrency ---
export { Semaphore } from './concurrency/semaphore.js'
export { ConcurrencyPool } from './concurrency/pool.js'
export type { PoolConfig, PoolStats } from './concurrency/pool.js'

// --- Output ---
export type { OutputFormat, FormatAdapter, FormatValidationResult } from './output/format-adapter.js'
export { FORMAT_ADAPTERS, validateFormat, detectFormat } from './output/format-adapter.js'

// --- i18n ---
export type { Locale, LocaleConfig, LocaleStrings } from './i18n/locale-manager.js'
export { EN_STRINGS, LocaleManager } from './i18n/locale-manager.js'

// --- Config ---
export {
  DEFAULT_CONFIG,
  loadEnvConfig,
  loadFileConfig,
  mergeConfigs,
  resolveConfig,
  validateConfig,
  getConfigValue,
} from './config/index.js'
export type {
  ForgeConfig,
  ProviderConfig,
  RateLimitConfig,
  ConfigLayer,
} from './config/index.js'

// --- Identity ---
export { toIdentityRef } from './identity/index.js'
export type {
  ForgeIdentity,
  ForgeCredential,
  ForgeCapability,
  ForgeIdentityRef,
  CredentialType,
} from './identity/index.js'
export {
  ForgeIdentitySchema,
  ForgeCapabilitySchema,
  ForgeCredentialSchema,
  ForgeIdentityRefSchema,
} from './identity/index.js'
export {
  parseForgeUri,
  buildForgeUri,
  isForgeUri,
  toAgentUri,
  fromAgentUri,
  createUriResolver,
  ForgeUriSchema,
} from './identity/index.js'
export type {
  ParsedForgeUri,
  UriResolver,
  UriResolverStrategy,
  UriResolverConfig,
} from './identity/index.js'

// --- Identity: Signing ---
export { createKeyManager, InMemoryKeyStore } from './identity/index.js'
export type {
  SigningKeyPair,
  SigningKeyStatus,
  SignedDocument,
  SignedAgentCard,
  KeyStore,
  KeyManagerConfig,
  KeyManager,
} from './identity/index.js'

// --- Identity: Resolution ---
export { CompositeIdentityResolver } from './identity/index.js'
export type {
  IdentityResolutionContext,
  IdentityResolver,
} from './identity/index.js'
export { createAPIKeyResolver, hashAPIKey } from './identity/index.js'
export type {
  APIKeyRecord,
  APIKeyResolverConfig,
  APIKeyIdentityResolver,
} from './identity/index.js'

// --- Identity: Delegation ---
export { InMemoryDelegationTokenStore, DelegationManager } from './identity/index.js'
export type {
  DelegationToken,
  DelegationConstraint,
  DelegationChain,
  DelegationTokenStore,
  DelegationManagerConfig,
  IssueDelegationParams,
} from './identity/index.js'

// --- Identity: Capability Checker ---
export { createCapabilityChecker } from './identity/index.js'
export type {
  CapabilityCheckResult,
  CapabilityCheckerConfig,
  CapabilityCheckParams,
  CapabilityChecker,
} from './identity/index.js'

// --- Identity: Trust Scoring ---
export { createTrustScorer, InMemoryTrustScoreStore } from './identity/index.js'
export type {
  TrustSignals,
  TrustScoreBreakdown,
  TrustScorerConfig,
  TrustScoreStore,
  TrustScorer,
} from './identity/index.js'

// --- Protocol ---
export {
  ForgeMessageUriSchema,
  ForgeMessageMetadataSchema,
  ForgePayloadSchema,
  ForgeMessageSchema,
  createMessageId,
  createForgeMessage,
  createResponse,
  createErrorResponse,
  isMessageAlive,
  validateForgeMessage,
  InternalAdapter,
  extractAgentId,
  ProtocolRouter,
  A2AClientAdapter,
  streamA2ATask,
  parseSSEEvents,
  JSONSerializer,
  defaultSerializer,
  ProtocolBridge,
} from './protocol/index.js'
export type {
  ForgeMessageId,
  ForgeMessageType,
  ForgeProtocol,
  MessagePriority,
  MessageBudget,
  ForgeMessageMetadata,
  ForgePayload,
  ForgeMessage,
  CreateMessageParams,
  ValidationResult,
  AdapterState,
  AdapterHealthStatus,
  SendOptions,
  MessageHandler,
  Subscription,
  ProtocolAdapter,
  InternalAdapterConfig,
  ProtocolRouterConfig,
  A2AClientConfig,
  A2ASSEConfig,
  SSEEvent,
  MessageSerializer,
  ProtocolBridgeConfig,
  BridgeDirection,
} from './protocol/index.js'

// --- Registry ---
export { InMemoryRegistry } from './registry/index.js'
export { CapabilityMatcher, compareSemver } from './registry/index.js'
export {
  STANDARD_CAPABILITIES,
  isStandardCapability,
  getCapabilityDescription,
  listStandardCapabilities,
} from './registry/index.js'
export type {
  CapabilityDescriptor,
  AgentHealthStatus,
  DeregistrationReason,
  AgentHealth,
  AgentSLA,
  AgentAuthentication,
  RegisteredAgent,
  RegisterAgentInput,
  DiscoveryQuery,
  ScoreBreakdown,
  DiscoveryResult,
  DiscoveryResultPage,
  RegistryStats,
  RegistryEventType,
  RegistrySubscriptionFilter,
  RegistryEvent,
  AgentRegistryConfig,
  AgentRegistry,
} from './registry/index.js'
export type { CapabilityTree, CapabilityTreeNode } from './registry/index.js'
// Registry — semantic search (ECO-050)
export { KeywordFallbackSearch, createKeywordFallbackSearch } from './registry/index.js'
export type { SemanticSearchProvider } from './registry/index.js'
// Registry — vector-backed semantic search (VEC-011)
export { VectorStoreSemanticSearch } from './registry/index.js'

// --- Pipeline ---
export type {
  PipelineNodeBase,
  AgentNode,
  ToolNode,
  TransformNode,
  GateNode,
  ForkNode,
  JoinNode,
  LoopNode,
  SuspendNode,
  PipelineNode,
  SequentialEdge,
  ConditionalEdge,
  ErrorEdge,
  PipelineEdge,
  CheckpointStrategy,
  PipelineDefinition,
  PipelineValidationError,
  PipelineValidationWarning,
  PipelineValidationResult,
  PipelineCheckpoint,
  PipelineCheckpointSummary,
  PipelineCheckpointStore,
} from './pipeline/index.js'
export {
  AgentNodeSchema,
  ToolNodeSchema,
  TransformNodeSchema,
  GateNodeSchema,
  ForkNodeSchema,
  JoinNodeSchema,
  LoopNodeSchema,
  SuspendNodeSchema,
  PipelineNodeSchema,
  SequentialEdgeSchema,
  ConditionalEdgeSchema,
  ErrorEdgeSchema,
  PipelineEdgeSchema,
  PipelineCheckpointSchema,
  PipelineDefinitionSchema,
  serializePipeline,
  deserializePipeline,
  // Layout (ECO-184)
  autoLayout,
} from './pipeline/index.js'
export type { NodePosition, ViewportState, PipelineLayout } from './pipeline/index.js'

// --- Formats ---
export {
  // Agent Card V2
  AgentCardV2Schema, validateAgentCard,
  // Tool Format Adapters
  zodToJsonSchema, jsonSchemaToZod,
  toOpenAIFunction, toOpenAITool, fromOpenAIFunction,
  toMCPToolDescriptor, fromMCPToolDescriptor,
  // AGENTS.md V2 Parser
  parseAgentsMdV2, generateAgentsMd, toLegacyConfig,
} from './formats/index.js'
export type {
  // Agent Card V2 types
  ContentMode, AgentCardV2, AgentCardCapability, AgentCardSkill,
  AgentAuthScheme, AgentCardAuthentication, AgentCardSLA, AgentCardProvider,
  AgentCardValidationResult,
  // OpenAI types
  OpenAIFunctionDefinition, OpenAIToolDefinition,
  // Tool adapter types
  ToolSchemaDescriptor, MCPToolDescriptorCompat,
  // AGENTS.md V2 types
  AgentsMdDocument, AgentsMdMetadata, AgentsMdCapability as AgentsMdCapabilityV2,
  AgentsMdMemoryConfig, AgentsMdSecurityConfig,
} from './formats/index.js'

// --- Memory IPC (optional, requires @forgeagent/memory-ipc peer) ---
export * from './memory-ipc.js'

// --- VectorDB ---
export type {
  DistanceMetric,
  CollectionConfig,
  VectorEntry,
  VectorQuery,
  VectorSearchResult as VectorDBSearchResult,
  VectorDeleteFilter,
  MetadataFilter,
  VectorStoreHealth,
  VectorStore,
} from './vectordb/index.js'
export type {
  EmbeddingProvider,
  EmbeddingProviderConfig,
} from './vectordb/index.js'
export {
  createOpenAIEmbedding,
  createVoyageEmbedding,
  createCohereEmbedding,
  createOllamaEmbedding,
  createCustomEmbedding,
  createAutoEmbeddingProvider,
  detectVectorProvider,
  createAutoSemanticStore,
  cosineSimilarity,
  evaluateFilter,
  InMemoryVectorStore,
  SemanticStore,
  PgVectorAdapter,
  ChromaDBAdapter,
  QdrantAdapter,
  translateQdrantFilter,
  PineconeAdapter,
  translatePineconeFilter,
} from './vectordb/index.js'
export type {
  OpenAIEmbeddingConfig,
  VoyageEmbeddingConfig,
  CohereEmbeddingConfig,
  OllamaEmbeddingConfig,
  CustomEmbeddingConfig,
  AutoDetectResult,
  SemanticStoreConfig,
  Document as SemanticDocument,
  ScoredDocument,
  PgVectorAdapterConfig,
  ChromaDBAdapterConfig,
  QdrantAdapterConfig,
  PineconeAdapterConfig,
} from './vectordb/index.js'

// --- Tool Stats ---
export { ToolStatsTracker } from './tools/tool-stats-tracker.js'
export type {
  ToolCallRecord,
  ToolStats,
  ToolRanking,
  ToolStatsTrackerConfig,
} from './tools/tool-stats-tracker.js'

// --- Telemetry (lightweight trace propagation — no OTel SDK dependency) ---
export { injectTraceContext, extractTraceContext, formatTraceparent, parseTraceparent } from './telemetry/trace-propagation.js'
export type { TraceContext } from './telemetry/trace-propagation.js'

// --- Version ---
export const FORGEAGENT_CORE_VERSION = '0.1.0'
