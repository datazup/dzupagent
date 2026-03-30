/**
 * @dzipagent/agent-adapters
 *
 * AI agent CLI/SDK adapters for DzipAgent.
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
  AgentStartedEvent,
  AgentMessageEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentStreamDeltaEvent,
  TokenUsage,
  HealthStatus,
  SessionInfo,
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
export { QwenAdapter } from './qwen/qwen-adapter.js'
export { CrushAdapter } from './crush/crush-adapter.js'

// --- Registry & Router ---
export { AdapterRegistry } from './registry/adapter-registry.js'
export type { AdapterRegistryConfig } from './registry/adapter-registry.js'
export {
  TagBasedRouter,
  CostOptimizedRouter,
  RoundRobinRouter,
  CompositeRouter,
} from './registry/task-router.js'
export type { WeightedStrategy } from './registry/task-router.js'

// --- Event Bus Bridge ---
export { EventBusBridge } from './registry/event-bus-bridge.js'

// --- Middleware ---
export { CostTrackingMiddleware } from './middleware/cost-tracking.js'
export type { CostTrackingConfig, CostReport } from './middleware/cost-tracking.js'

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
export { AdapterWorkflowBuilder, AdapterWorkflow, defineWorkflow } from './workflow/adapter-workflow.js'
export type {
  AdapterWorkflowConfig,
  AdapterStepConfig,
  AdapterWorkflowResult,
  AdapterStepResult,
  AdapterWorkflowEvent,
  BranchCondition,
} from './workflow/adapter-workflow.js'

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

// --- Approval ---
export { AdapterApprovalGate } from './approval/adapter-approval.js'
export type {
  AdapterApprovalConfig,
  ApprovalContext,
  ApprovalRequest,
  ApprovalMode,
  ApprovalResult,
} from './approval/adapter-approval.js'

// --- Recovery ---
export { AdapterRecoveryCopilot, ExecutionTraceCapture } from './recovery/adapter-recovery.js'
export type {
  RecoveryStrategy,
  RecoveryConfig,
  FailureContext,
  RecoveryResult,
  ExecutionTrace,
  TraceDecision,
  TracedEvent,
} from './recovery/adapter-recovery.js'

// --- HTTP Handler ---
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
} from './http/adapter-http-handler.js'

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

// --- Utilities ---
export { isBinaryAvailable, spawnAndStreamJsonl } from './utils/process-helpers.js'
