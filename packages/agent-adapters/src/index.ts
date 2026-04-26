/**
 * @dzupagent/agent-adapters
 *
 * AI agent CLI/SDK adapters for DzupAgent.
 * Enables orchestration of multiple AI agents:
 * - Claude (via @anthropic-ai/claude-agent-sdk)
 * - Codex (via @openai/codex-sdk)
 * - Gemini (via gemini CLI)
 * - Qwen (via OpenAI-compatible API / qwen CLI)
 * - Crush (via crush CLI)
 */

// --- Core types ---
export type {
  AdapterProviderId,
  AdapterCapabilityProfile,
  AgentInput,
  AgentEvent,
  AgentStreamEvent,
  AgentStartedEvent,
  AgentMessageEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentStreamDeltaEvent,
  AgentProgressEvent,
  GovernanceEvent,
  GovernanceEventKind,
  TokenUsage,
  HealthStatus,
  SessionInfo,
  EnvFilterConfig,
  AdapterConfig,
  AgentCLIAdapter,
  TaskDescriptor,
  RoutingDecision,
  TaskRoutingStrategy,
} from './types.js'

// --- Adapters ---
export { ClaudeAgentAdapter } from './claude/claude-adapter.js'
export { CodexAdapter } from './codex/codex-adapter.js'
export { GeminiCLIAdapter } from './gemini/gemini-adapter.js'
export { GeminiSDKAdapter } from './gemini/gemini-sdk-adapter.js'
export type { GeminiSDKAdapterConfig } from './gemini/gemini-sdk-adapter.js'
export { QwenAdapter } from './qwen/qwen-adapter.js'
export { CrushAdapter } from './crush/crush-adapter.js'
export { GooseAdapter } from './goose/goose-adapter.js'
export { OpenRouterAdapter } from './openrouter/openrouter-adapter.js'
export type { OpenRouterConfig } from './openrouter/openrouter-adapter.js'

// --- Prompts ---
export { SystemPromptBuilder } from './prompts/system-prompt-builder.js'
export type {
  SystemPromptPayload,
  ClaudeAppendPayload,
  ClaudeReplacePayload,
  CodexPromptPayload,
  StringPromptPayload,
  SystemPromptBuilderOptions,
  PersonaTemplateContext,
} from './prompts/system-prompt-builder.js'
export { resolvePersonaTemplate } from './prompts/system-prompt-builder.js'

// --- Registry & Router ---
export { ProviderAdapterRegistry } from './registry/adapter-registry.js'
export type {
  ProviderAdapterRegistryConfig,
  ProviderAdapterRegistryHealthStatus,
  ProviderAdapterHealthDetail,
} from './registry/adapter-registry.js'
export {
  TagBasedRouter,
  CostOptimizedRouter,
  RoundRobinRouter,
  CompositeRouter,
} from './registry/task-router.js'
export type { WeightedStrategy } from './registry/task-router.js'
export { LearningRouter } from './registry/learning-router.js'
export type { LearningRouterConfig } from './registry/learning-router.js'

// --- Event Bus Bridge ---
export { EventBusBridge } from './registry/event-bus-bridge.js'

// --- Middleware ---
export { withMemoryEnrichment, withHierarchicalMemoryEnrichment } from './middleware/memory-enrichment.js'
export type { MemoryServiceLike, MemoryEnrichmentOptions, HierarchicalMemoryEnrichmentOptions, HierarchicalMemorySource, MemoryLevel } from './middleware/memory-enrichment.js'
export { CostTrackingMiddleware } from './middleware/cost-tracking.js'
export type { CostTrackingConfig, CostReport } from './middleware/cost-tracking.js'
export { MiddlewarePipeline } from './middleware/middleware-pipeline.js'
export type { AdapterMiddleware, MiddlewareContext } from './middleware/middleware-pipeline.js'
export { createCostTrackingMiddleware, createGuardrailsMiddleware } from './middleware/middleware-factories.js'
export { sanitizeContent, createContentSanitizerMiddleware } from './middleware/content-sanitizer.js'
export type { ContentSanitizerConfig } from './middleware/content-sanitizer.js'

// --- Orchestration ---
export { SupervisorOrchestrator, KeywordTaskDecomposer } from './orchestration/supervisor.js'
export type {
  SupervisorConfig,
  SupervisorOptions,
  SupervisorResult,
  SubTask,
  SubTaskResult,
  TaskDecomposer,
} from './orchestration/supervisor.js'
export { ParallelExecutor } from './orchestration/parallel-executor.js'
export type {
  ParallelExecutorConfig,
  ParallelExecutionOptions,
  ParallelExecutionResult,
  ProviderResult,
  MergeStrategy,
} from './orchestration/parallel-executor.js'
export { MapReduceOrchestrator, LineChunker, DirectoryChunker } from './orchestration/map-reduce.js'
export type {
  MapReduceConfig,
  MapReduceOptions,
  MapReduceResult,
  MapChunkResult,
  Chunker,
  MapperFn,
  ReducerFn,
} from './orchestration/map-reduce.js'
export { ContractNetOrchestrator, StaticBidStrategy } from './orchestration/contract-net.js'
export type {
  ContractNetConfig,
  ContractNetOptions,
  ContractNetResult,
  Bid,
  BidStrategy,
  BidSelectionCriteria,
} from './orchestration/contract-net.js'

// --- Session & State Management ---
export { SessionRegistry } from './session/session-registry.js'
export type {
  WorkflowSession,
  ProviderSession,
  ConversationEntry,
  SessionRegistryConfig,
  MultiTurnOptions,
} from './session/session-registry.js'
export { WorkflowCheckpointer, InMemoryCheckpointStore } from './session/workflow-checkpointer.js'
export { ConversationCompressor } from './session/conversation-compressor.js'
export type { ConversationTurn, ConversationCompressorOptions } from './session/conversation-compressor.js'
export { DefaultCompactionStrategy } from './session/compaction-strategy.js'
export type {
  CompactionStrategy,
  CompactionRequest,
  CompactionType,
  CompactionSessionInfo,
  DefaultCompactionConfig,
} from './session/compaction-strategy.js'
export type {
  WorkflowCheckpoint,
  StepDefinition,
  StepResult,
  SerializedProviderSession,
  CheckpointStore,
  CheckpointerConfig,
} from './session/workflow-checkpointer.js'

// --- Testing / A/B ---
export { ABTestRunner, LengthScorer, ExactMatchScorer, ContainsKeywordsScorer } from './testing/ab-test-runner.js'
export type {
  ABTestConfig,
  ABTestCase,
  ABTestVariant,
  ABTestScorer,
  ABTestPlan,
  VariantResult,
  ABTestReport,
  ABVariantSummary,
  ABComparison,
} from './testing/ab-test-runner.js'

// --- Cost Models ---
export { CostModelRegistry } from './middleware/cost-models.js'
export type {
  TokenRates,
  CostEstimationInput,
  CostEstimate,
  CostCalculation,
  ProviderCostModel,
} from './middleware/cost-models.js'

// --- Cost Optimization ---
export { CostOptimizationEngine } from './middleware/cost-optimization.js'
export type {
  CostOptimizationConfig,
  ProviderPerformanceRecord,
  ProviderStats,
  OptimizationDecision,
} from './middleware/cost-optimization.js'

// --- MCP Tool Sharing ---
export { MCPToolSharingBridge } from './mcp/mcp-tool-sharing.js'
export type {
  MCPToolSharingConfig,
  SharedTool,
  ToolSharingStats,
} from './mcp/mcp-tool-sharing.js'

// --- MCP Adapter Management ---
export { InMemoryMcpAdapterManager } from './mcp/mcp-adapter-manager.js'
export type {
  AdapterMcpServer,
  AdapterMcpBinding,
  McpServerTestResult,
  EffectiveMcpConfig,
} from './mcp/mcp-adapter-types.js'

// --- Capability Router ---
export { CapabilityRouter } from './registry/capability-router.js'
export type {
  ProviderCapability,
  ProviderCapabilityTag,
  CapabilityRouterConfig,
} from './registry/capability-router.js'

// --- Plugin ---
export { createAdapterPlugin } from './plugin/adapter-plugin.js'
export type {
  AdapterPluginConfig,
  AdapterPluginInstance,
} from './plugin/adapter-plugin.js'

// --- Plugin SDK ---
export { defineAdapterPlugin, isAdapterPlugin } from './plugin/adapter-plugin-sdk.js'
export type { AdapterPluginDefinition, AdapterPlugin } from './plugin/adapter-plugin-sdk.js'
export { AdapterPluginLoader } from './plugin/adapter-plugin-loader.js'

// --- Facade ---
export { OrchestratorFacade, createOrchestrator } from './facade/orchestrator-facade.js'
export type { OrchestratorConfig } from './facade/orchestrator-facade.js'

// --- Integration Bridge ---
export { AgentIntegrationBridge, AdapterAsToolWrapper } from './integration/agent-bridge.js'
export type {
  AdapterToolConfig,
  ToolInvocationResult,
  AdapterToolSchema,
  ToolInvocationArgs,
} from './integration/agent-bridge.js'
export { RegistryExecutionPort } from './integration/index.js'

// --- Guardrails ---
export { AdapterGuardrails, AdapterStuckDetector } from './guardrails/adapter-guardrails.js'
export type {
  AdapterGuardrailsConfig,
  StuckDetectorConfig as AdapterStuckDetectorConfig,
  GuardrailStatus,
  GuardrailViolation,
  BudgetState as GuardrailBudgetState,
  StuckStatus,
} from './guardrails/adapter-guardrails.js'

// --- Workflow DSL ---
export { AdapterWorkflowBuilder, AdapterWorkflow, defineWorkflow, typedStep } from './workflow/adapter-workflow.js'
export type {
  AdapterWorkflowConfig,
  AdapterStepConfig,
  AdapterWorkflowResult,
  AdapterStepResult,
  AdapterWorkflowEvent,
  BranchCondition,
  LoopConfig,
} from './workflow/adapter-workflow.js'
export { WorkflowStepResolver } from './workflow/template-resolver.js'
export type { TemplateContext, TemplateReference } from './workflow/template-resolver.js'
export { WorkflowValidator } from './workflow/workflow-validator.js'
export type { ValidationError, ValidationResult } from './workflow/workflow-validator.js'

// --- Streaming ---
export { StreamingHandler } from './streaming/streaming-handler.js'
export type {
  StreamFormat,
  StreamingConfig,
  StreamOutputEvent,
  StreamEventData,
  ProgressState,
} from './streaming/streaming-handler.js'

// --- Observability ---
export { AdapterTracer } from './observability/adapter-tracer.js'
export type {
  TraceSpan,
  SpanEvent,
  AdapterTracerConfig,
  TraceContext,
} from './observability/adapter-tracer.js'
export { createTracingMiddleware } from './observability/tracing-middleware.js'

// --- Approval ---
export { AdapterApprovalGate } from './approval/adapter-approval.js'
export type {
  AdapterApprovalConfig,
  ApprovalContext,
  ApprovalRequest,
  ApprovalMode,
  ApprovalResult,
} from './approval/adapter-approval.js'
export { InMemoryApprovalAuditStore } from './approval/approval-audit.js'
export type {
  ApprovalAuditEntry,
  AuditQueryFilters,
  ApprovalAuditStore,
} from './approval/approval-audit.js'
export { createPolicyCondition, compareBlastRadius } from './approval/policy-driven-approval.js'
export type { PolicyConditionConfig } from './approval/policy-driven-approval.js'

// --- Recovery ---
export { AdapterRecoveryCopilot, ExecutionTraceCapture } from './recovery/adapter-recovery.js'
export type {
  RecoveryStrategy,
  RecoveryConfig,
  TraceEvictionConfig,
  FailureContext,
  RecoverySuccessResult,
  RecoveryFailureResult,
  RecoveryCancelledResult,
  RecoveryResult,
  ExecutionTrace,
  TraceDecision,
  TracedEvent,
} from './recovery/adapter-recovery.js'

// --- Recovery Policies ---
export { RecoveryPolicySelector, RECOVERY_POLICIES } from './recovery/recovery-policies.js'
export type { RecoveryPolicy, RecoveryStrategyConfig, PolicyContext } from './recovery/recovery-policies.js'

// --- Escalation ---
export { EventBusEscalationHandler, WebhookEscalationHandler } from './recovery/escalation-handler.js'
export { CrossProviderHandoff } from './recovery/cross-provider-handoff.js'
export type { HandoffItem, CrossProviderHandoffOptions } from './recovery/cross-provider-handoff.js'
export type {
  EscalationHandler,
  EscalationContext,
  EscalationResolution,
  RecoveryAttemptSummary,
} from './recovery/escalation-handler.js'

// --- HTTP Handler ---
export { SlidingWindowRateLimiter } from './http/rate-limiter.js'
export type { RateLimitConfig } from './http/rate-limiter.js'
export { AdapterHttpHandler } from './http/adapter-http-handler.js'
export type {
  AdapterHttpConfig,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
  HttpResult,
  RunRequestBody,
  SupervisorRequestBody,
  ParallelRequestBody,
  BidRequestBody,
  HealthResponse,
  TokenValidationResult,
} from './http/adapter-http-handler.js'
export {
  RunRequestSchema,
  SupervisorRequestSchema,
  ParallelRequestSchema,
  BidRequestSchema,
  ApproveRequestSchema,
} from './http/request-schemas.js'
export type {
  RunRequest,
  SupervisorRequest,
  ParallelRequest,
  BidRequest,
  ApproveRequest,
} from './http/request-schemas.js'

// --- Context-Aware Routing ---
export { ContextAwareRouter, ContextInjectionMiddleware } from './context/context-aware-router.js'
export type {
  ContextEstimate,
  ContextAwareRouterConfig,
  ContextInjection,
  ContextInjectionConfig,
} from './context/context-aware-router.js'

// --- Structured Output ---
export { StructuredOutputAdapter, JsonOutputSchema, RegexOutputSchema } from './output/structured-output.js'
export type {
  OutputSchema,
  StructuredOutputConfig,
  ParseResult,
  StructuredRunResult,
} from './output/structured-output.js'

// --- Persistence ---
export { FileCheckpointStore } from './persistence/persistent-checkpoint-store.js'
export type { FileCheckpointStoreConfig } from './persistence/persistent-checkpoint-store.js'
export { RunManager } from './persistence/run-manager.js'
export type {
  AdapterRun,
  RunStatus,
  RunManagerConfig,
  RunStats,
} from './persistence/run-manager.js'

// --- Learning ---
export { AdapterLearningLoop, ExecutionAnalyzer } from './learning/adapter-learning-loop.js'
export type {
  ExecutionRecord,
  ProviderProfile,
  FailurePattern,
  RecoverySuggestion,
  LearningConfig,
  PerformanceReport,
  ProviderComparison,
} from './learning/adapter-learning-loop.js'
export { InMemoryLearningStore } from './learning/in-memory-learning-store.js'
export { FileLearningStore } from './learning/file-learning-store.js'
export type { LearningStore, LearningSnapshot } from './learning/learning-store.js'

// --- Error Aliases ---
export { DzupError } from './utils/errors.js'
export type { DzupErrorOptions } from './utils/errors.js'

// --- Utilities ---
export { isBinaryAvailable, spawnAndStreamJsonl } from './utils/process-helpers.js'
export { filterSensitiveEnvVars } from './base/base-cli-adapter.js'
export { validateWebhookUrl } from './utils/url-validator.js'
export { resolveFallbackProviderId, requireFallbackProviderId } from './utils/provider-helpers.js'
export type { UrlValidationOptions } from './utils/url-validator.js'

// --- Skill Projection ---
export { SkillProjector } from './skills/skill-projector.js'
export type { SkillProjection, ProjectionOptions } from './skills/skill-projector.js'

// --- Adapter Skill Bundle & Compilers ---
export type {
  AdapterSkillBundle,
  CompiledAdapterSkill,
  AdapterSkillCompiler,
  ProjectionUsageRecord,
} from './skills/adapter-skill-types.js'
export { AdapterSkillRegistry, createDefaultSkillRegistry } from './skills/adapter-skill-registry.js'
export type { VersionedProjection, AdapterSkillVersionStore } from './skills/adapter-skill-version-store.js'
export { InMemoryAdapterSkillVersionStore, FileAdapterSkillVersionStore } from './skills/adapter-skill-version-store.js'
export type {
  ProjectionTelemetryRecord,
  ProjectionUsageStats,
  AdapterSkillTelemetry,
} from './skills/adapter-skill-telemetry.js'
export { InMemoryAdapterSkillTelemetry } from './skills/adapter-skill-telemetry.js'
export { SkillCapabilityMatrixBuilder } from './skills/skill-capability-matrix.js'
export type { SkillCapabilityMatrix, ProviderCapabilityRow, CapabilityStatus } from '@dzupagent/adapter-types'
export { CodexSkillCompiler } from './skills/compilers/codex-skill-compiler.js'
export { ClaudeSkillCompiler } from './skills/compilers/claude-skill-compiler.js'
export { CliSkillCompiler, isCliProviderId } from './skills/compilers/cli-skill-compiler.js'

// --- Policy Compiler & Conformance ---
export { compilePolicyForProvider, compilePolicyForAll } from './policy/index.js'
export type { AdapterPolicy, CompiledPolicyOverrides, CompiledGuardrailHints } from './policy/index.js'
export { PolicyConformanceChecker } from './policy/index.js'
export type { PolicyViolation, PolicyViolationSeverity, PolicyConformanceResult } from './policy/index.js'

// --- Batched Event Emitter ---
export { BatchedEventEmitter } from './utils/batched-event-emitter.js'
export type { BatchConfig } from './utils/batched-event-emitter.js'

// --- DzupAgent Unified Capability Layer ---
export {
  WorkspaceResolver,
  loadDzupAgentConfig,
  getCodexMemoryStrategy,
  getMaxMemoryTokens,
  parseMarkdownFile,
  DzupAgentFileLoader,
  DzupAgentMemoryLoader,
  DzupAgentImporter,
  DzupAgentAgentLoader,
  agentDefinitionsToSupervisorConfig,
  DzupAgentSyncer,
  DryRunReporter,
} from './dzupagent/index.js'
export type {
  DryRunReporterMode,
  DryRunReporterOptions,
  DryRunEntry,
  DryRunEntryType,
  ParsedFrontmatter,
  ParsedSection,
  ParsedMarkdownFile,
  FrontmatterValue,
  FileLoaderOptions,
  ParsedSkillFile,
  MemoryEntry,
  DzupAgentMemoryLoaderOptions,
  ImportPlan,
  ImportResult,
  ImportSource,
  DzupAgentImporterOptions,
  AgentDefinition,
  DzupAgentAgentLoaderOptions,
  SyncPlan,
  SyncPlanEntry,
  SyncDivergedEntry,
  SyncResult,
  SyncResultWritten,
  SyncResultSkipped,
  SyncResultDiverged,
  SyncTarget,
  DzupAgentSyncerOptions,
} from './dzupagent/index.js'

// --- Interaction Policy ---
export { InteractionResolver } from './interaction/interaction-resolver.js'
export { classifyInteractionText, detectCliInteraction } from './interaction/interaction-detector.js'
export type { InteractionKind } from './interaction/interaction-detector.js'
export type { InteractionRequest, InteractionResult } from './interaction/interaction-resolver.js'

// --- Run Event Store ---
export { RunEventStore } from './runs/run-event-store.js'
export { runLogRoot } from './runs/run-log-root.js'
export type { RawAgentEvent, ProviderRawStreamEvent, AgentArtifactEvent, RunSummary } from '@dzupagent/adapter-types'

// --- Provider Catalog ---
export {
  PROVIDER_CATALOG,
  getMonitorableProviders,
  getProductProviders,
  getProviderCapabilities,
} from './provider-catalog.js'
export type { ProviderCapabilities, MonitorTier } from './provider-catalog.js'

// --- Unified Event Normalization ---
export { normalizeEvent } from './normalize.js'
export type { Provider as NormalizeProvider } from './normalize.js'

// --- Enrichment Pipeline ---
export { EnrichmentPipeline } from './enrichment/enrichment-pipeline.js'
export type {
  EnrichmentContext,
  EnrichmentResult,
} from './enrichment/enrichment-pipeline.js'
