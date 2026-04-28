/**
 * @dzupagent/core — Base agent infrastructure
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
export type { DzupEventBus } from './events/event-bus.js'
export type { DzupEvent, DzupEventOf, BudgetUsage, ToolStatSummary } from './events/event-types.js'
export { emitDegradedOperation } from './events/degraded-operation.js'
export { requireTerminalToolExecutionRunId } from './events/tool-event-correlation.js'
export type { TerminalToolExecutionRunIdOptions, TerminalToolEventType } from './events/tool-event-correlation.js'
export { AgentBus } from './events/agent-bus.js'
export type { AgentMessage, AgentMessageHandler } from './events/agent-bus.js'

// --- Hooks ---
export type { AgentHooks, HookContext } from './hooks/hook-types.js'
export { runHooks, runModifierHook, mergeHooks } from './hooks/hook-runner.js'

// --- Plugin ---
export type { DzupPlugin, PluginContext } from './plugin/plugin-types.js'
export { PluginRegistry } from './plugin/plugin-registry.js'
export { discoverPlugins, validateManifest, resolvePluginOrder } from './plugin/plugin-discovery.js'
export type { PluginManifest, DiscoveredPlugin, PluginDiscoveryConfig } from './plugin/plugin-discovery.js'
export { createManifest, serializeManifest } from './plugin/plugin-manifest.js'

// --- LLM ---
export { ModelRegistry } from './llm/model-registry.js'
export type {
  KnownLLMProvider,
  LLMProviderConfig,
  LLMProviderName,
  ModelTier,
  ModelSpec,
  ModelOverrides,
  ModelFactory,
  StructuredOutputStrategy,
  StructuredOutputModelCapabilities,
} from './llm/model-config.js'
export { CircuitBreaker, KeyedCircuitBreaker } from './llm/circuit-breaker.js'
export type { CircuitBreakerConfig, CircuitState } from './llm/circuit-breaker.js'
export { invokeWithTimeout, extractTokenUsage, estimateTokens } from './llm/invoke.js'
export type { TokenUsage, InvokeOptions } from './llm/invoke.js'
export { isTransientError, isContextLengthError, DEFAULT_RETRY_CONFIG } from './llm/retry.js'
export type { RetryConfig } from './llm/retry.js'
export type { RegistryMiddleware, MiddlewareContext, MiddlewareResult, MiddlewareTokenUsage } from './llm/registry-middleware.js'
export { EmbeddingRegistry, createDefaultEmbeddingRegistry, COMMON_EMBEDDING_MODELS } from './llm/embedding-registry.js'
export type { EmbeddingModelEntry } from './llm/embedding-registry.js'
export {
  attachStructuredOutputCapabilities,
  getProviderStructuredOutputDefaults,
  getStructuredOutputDefaultsForProviderName,
  isKnownLLMProvider,
  normalizeStructuredOutputCapabilities,
} from './llm/structured-output-capabilities.js'

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

// --- Memory and Context are intentionally NOT re-exported from core.
// --- They live in Layer 2 (@dzupagent/memory, @dzupagent/context) and must
// --- be imported directly. See MC-A01 (remove core -> memory/context layer
// --- inversion).

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
export { WorkingMemory, createWorkingMemory } from './persistence/working-memory.js'
export type { WorkingMemoryConfig, WorkingMemorySnapshot } from './persistence/working-memory-types.js'
export { InMemoryRunStore, InMemoryAgentStore } from './persistence/in-memory-store.js'
export type {
  RunStore, Run, CreateRunInput, RunFilter, RunStatus, LogEntry,
  AgentExecutionSpecStore, AgentExecutionSpec, AgentExecutionSpecFilter,

} from './persistence/store-interfaces.js'
export { InMemoryEventLog, EventLogSink } from './persistence/event-log.js'
export type { RunEvent, EventLogStore } from './persistence/event-log.js'
// --- Run Journal ---
export { InMemoryRunJournal } from './persistence/in-memory-run-journal.js'
export { RunJournalBridgeRunStore } from './persistence/run-journal-bridge.js'
export { createEntryBase, isTerminalEntry, deserializeEntry } from './persistence/run-journal.js'
export type {
  RunJournalEntryType,
  RunJournalEntryBase,
  RunJournalEntry,
  RunStartedEntry,
  StepStartedEntry,
  StepCompletedEntry,
  StepFailedEntry,
  StateUpdatedEntry,
  RunCompletedEntry,
  RunFailedEntry,
  RunPausedEntry,
  RunResumedEntry,
  RunSuspendedEntry,
  RunCancelledEntry,
  SnapshotEntry,
  UnknownEntry,
  RunJournalQuery,
  RunJournalPage,
  RunJournal,
  RunJournalConfig,
} from './persistence/run-journal-types.js'

// --- Run Record Persistence (legacy low-level LLM execution records) ---
export { InMemoryRunRecordStore } from './persistence/in-memory-run-store.js'
export type {
  RunRecordStore,
  RunRecord,
  StoredRunEvent,
  RunFilters,
  RunStatus as RunRecordStatus,
} from './persistence/run-store.js'

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
export type {
  StandardSSEEvent,
  StandardEventType,
  FileStreamStartPayload,
  FileStreamChunkPayload,
  FileStreamEndPayload,
} from './streaming/event-types.js'

// --- Sub-agents ---
export { SubAgentSpawner } from './subagent/subagent-spawner.js'
export { REACT_DEFAULTS } from './subagent/subagent-types.js'
export type { SubAgentConfig, SubAgentResult, SubAgentUsage } from './subagent/subagent-types.js'
export { mergeFileChanges, fileDataReducer } from './subagent/file-merge.js'

// --- Skills ---
export { SkillLoader } from './skills/skill-loader.js'
export { injectSkills } from './skills/skill-injector.js'
export type { SkillDefinition, SkillRegistryEntry, LoadedSkill, SkillMatch } from './skills/skill-types.js'
export { SkillRegistry } from './skills/skill-registry.js'
export { SkillDirectoryLoader, parseMarkdownSkill, parseJsonSkill } from './skills/skill-directory-loader.js'
export type { SkillDirectoryLoaderOptions } from './skills/skill-directory-loader.js'
export { SkillManager } from './skills/skill-manager.js'
export type { SkillManagerConfig, CreateSkillInput, PatchSkillInput, SkillWriteResult } from './skills/skill-manager.js'
export { SkillLearner } from './skills/skill-learner.js'
export type { SkillMetrics, SkillExecutionResult, SkillLearnerConfig } from './skills/skill-learner.js'
export type { SkillResolutionContext, FeatureBrief, WorkItem, PersonaProfile, PersonaRoleType, SkillLifecycleStatus, SkillScope, SkillReviewPolicy, SkillDefinitionV2, SkillUsageRecord, SkillReviewRecord } from './skills/skill-model-v2.js'
export { SKILL_LIFECYCLE_TRANSITIONS, isValidSkillTransition } from './skills/skill-model-v2.js'
export { createSkillChain, validateChain, SkillChainBuilder } from './skills/skill-chain.js'
export type { SkillChainStep, SkillChain, ChainValidationResult, RetryPolicy } from './skills/skill-chain.js'
export { parseAgentsMd, mergeAgentsMdConfigs } from './skills/agents-md-parser.js'
export type { AgentsMdConfig } from './skills/agents-md-parser.js'
export { discoverAgentConfigs } from './skills/hierarchical-walker.js'
export type { HierarchyLevel } from './skills/hierarchical-walker.js'
export { WorkflowCommandParser } from './skills/workflow-command-parser.js'
export type {
  WorkflowCommandParserConfig,
  WorkflowCommandParseResult,
  WorkflowCommandParseSuccess,
  WorkflowCommandParseFailure,
  WorkflowSeparatorStyle,
  ParsedStepToken,
  ParseConfidenceTier,
  CandidateInterpretation,
  WorkflowKeywordPattern,
  WorkflowAliasEntry,
} from './skills/workflow-command-parser.js'
export { WorkflowRegistry } from './skills/workflow-registry.js'
export type {
  WorkflowRegistryEntry,
  WorkflowRegistrySnapshot,
  WorkflowRegistrationOptions,
  WorkflowComposeOptions,
  WorkflowFindResult,
  WorkflowListEntry,
} from './skills/workflow-registry.js'

// --- MCP ---
export { MCPClient } from './mcp/mcp-client.js'
export { mcpToolToLangChain, mcpToolsToLangChain, langChainToolToMcp } from './mcp/mcp-tool-bridge.js'
export { DeferredToolLoader } from './mcp/deferred-loader.js'
export { DzupAgentMCPServer, isMCPRequest } from './mcp/mcp-server.js'
export type {
  MCPServerOptions,
  MCPExposedTool,
  MCPExposedResource,
  MCPExposedResourceTemplate,
  MCPServerCapabilities,
  MCPInitializeResult,
  MCPRequest,
  MCPRequestId,
  MCPResponse,
} from './mcp/mcp-server.js'
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
// MCP Reliability
export { McpReliabilityManager } from './mcp/mcp-reliability.js'
export type { McpServerHealth, McpReliabilityConfig } from './mcp/mcp-reliability.js'
export { InMemoryMcpManager } from './mcp/mcp-manager.js'
export type { McpManager, InMemoryMcpManagerOptions } from './mcp/mcp-manager.js'
export { McpServerDefinitionSchema, McpProfileSchema } from './mcp/mcp-registry-types.js'
export type { McpServerDefinition, McpProfile, McpServerInput, McpServerPatch, McpTestResult } from './mcp/mcp-registry-types.js'
// MCP Security
export { validateMcpExecutablePath, sanitizeMcpEnv } from './mcp/mcp-security.js'
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
  // A2A JSON-RPC 2.0
  JSON_RPC_ERRORS,
  A2A_ERRORS,
  createJsonRpcError,
  createJsonRpcSuccess,
  validateJsonRpcRequest,
  validateJsonRpcBatch,
  // A2A Push Notifications
  PushNotificationService,
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
  // A2A JSON-RPC 2.0 types
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcResponse,
  JsonRpcValidationResult,
  JsonRpcBatchValidationResult,
  // A2A Push Notification types
  PushNotificationEvent,
  PushNotificationConfig,
  PushNotification,
  PushNotificationResult,
  PushNotificationServiceConfig,
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

// --- Flow handle types (Stage 3/4 boundary for @dzupagent/flow-compiler) ---
export type {
  SkillHandle,
  McpToolHandle,
  WorkflowHandle,
  ResolvedAgentHandle,
  AgentHandle,
  FlowHandle,
  McpInvocationResult,
  AgentInvocation,
  AgentInvocationResult,
  SkillExecutionContext,
} from './flow/index.js'

// --- Pipeline ---
export type {
  NodeRetryPolicy,
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
  zodToJsonSchema, jsonSchemaToZod, toOpenAISafeSchema,
  toStructuredOutputJsonSchema, describeStructuredOutputSchema,
  buildStructuredOutputSchemaName, attachStructuredOutputErrorContext,
  detectStructuredOutputStrategy, resolveStructuredOutputCapabilities,
  resolveStructuredOutputSchemaProvider, shouldAttemptNativeStructuredOutput,
  prepareStructuredOutputSchemaContract, unwrapStructuredEnvelope,
  executeStructuredParseLoop, executeStructuredParseStreamLoop,
  buildStructuredOutputCorrectionPrompt, buildStructuredOutputExhaustedError,
  isStructuredOutputExhaustedErrorMessage,
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
  // Structured output
  StructuredOutputSchemaSummary, StructuredOutputSchemaDescriptor,
  StructuredOutputErrorSchemaRef, StructuredOutputFailureCategory, StructuredOutputErrorContextInput,
  StructuredOutputProvider, StructuredOutputRuntimeMeta, StructuredOutputSchemaContract,
  StructuredOutputSchemaRef, StructuredParseAttempt, StructuredParseLoopSuccess,
  StructuredParseLoopFailure, StructuredParseLoopResult, ExecuteStructuredParseLoopInput,
  ExecuteStructuredParseStreamLoopInput, StructuredParseStreamLoopEvent,
  // Tool adapter types
  ToolSchemaDescriptor, MCPToolDescriptorCompat,
  // AGENTS.md V2 types
  AgentsMdDocument, AgentsMdMetadata, AgentsMdCapability as AgentsMdCapabilityV2,
  AgentsMdMemoryConfig, AgentsMdSecurityConfig,
} from './formats/index.js'

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
  TurbopufferAdapter,
  translateTurbopufferFilter,
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
  TurbopufferAdapterConfig,
} from './vectordb/index.js'

// --- Connector Contract ---
export type { BaseConnectorTool } from './tools/connector-contract.js'
export { isBaseConnectorTool, normalizeBaseConnectorTool, normalizeBaseConnectorTools } from './tools/connector-contract.js'

// --- Tool Factory ---
export { createForgeTool } from './tools/create-tool.js'
export type { ForgeToolConfig } from './tools/create-tool.js'

// --- Tool Stats ---
export { ToolStatsTracker } from './tools/tool-stats-tracker.js'
export type {
  ToolCallRecord,
  ToolStats,
  ToolRanking,
  ToolStatsTrackerConfig,
} from './tools/tool-stats-tracker.js'

// --- Tool Governance ---
export { ToolGovernance } from './tools/tool-governance.js'
export type {
  ToolGovernanceConfig,
  ToolValidationResult,
  ToolAuditHandler,
  ToolAuditEntry,
  ToolResultAuditEntry,
  ToolAccessResult,
} from './tools/tool-governance.js'

// --- Human Contact (human-in-the-loop) ---
export type {
  ContactType,
  ContactChannel,
  ApprovalRequest,
  ClarificationRequest,
  InputRequest,
  EscalationRequest,
  GenericContactRequest,
  HumanContactRequest,
  ApprovalResponse,
  ClarificationResponse,
  InputResponse,
  EscalationResponse,
  TimeoutResponse,
  LateResponse,
  GenericContactResponse,
  HumanContactResponse,
  PendingHumanContact,
} from './tools/human-contact-types.js'

// --- Telemetry (lightweight trace propagation — no OTel SDK dependency) ---
export { injectTraceContext, extractTraceContext, formatTraceparent, parseTraceparent } from './telemetry/trace-propagation.js'
export type { TraceContext } from './telemetry/trace-propagation.js'

// --- Utils ---
export { defaultLogger, noopLogger } from './utils/logger.js'
export type { FrameworkLogger } from './utils/logger.js'
export { calculateBackoff } from './utils/backoff.js'
export type { BackoffConfig } from './utils/backoff.js'

// --- Version ---
export const dzupagent_CORE_VERSION = '0.2.0'
