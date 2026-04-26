/**
 * @dzupagent/agent — Top-level agent abstraction
 *
 * Provides: DzupAgent class (generate/stream/asTool), guardrails
 * with iteration budgets, generic tool factory, auto-compression,
 * and structured output support.
 */

// --- Agent ---
export { DzupAgent } from './agent/dzip-agent.js'
export { createAgentWithMemory } from './agent/agent-factory.js'
export type {
  DzupAgentConfig,
  AgentMailboxConfig,
  ArrowMemoryConfig,
  GenerateOptions,
  GenerateResult,
  AgentStreamEvent,
  CompressionLogEntry,
} from './agent/agent-types.js'
export { getMemoryProfilePreset, resolveArrowMemoryConfig } from './agent/memory-profiles.js'
export type { MemoryProfile, MemoryProfilePreset } from './agent/memory-profiles.js'
export { runToolLoop } from './agent/tool-loop.js'
export type { ToolLoopConfig, ToolLoopResult, ToolStat, StopReason } from './agent/tool-loop.js'

// --- RunHandle ---
export type {
  RunHandle,
  RunResult,
  LaunchOptions,
  Unsubscribe,
  CheckpointInfo,
} from './agent/run-handle-types.js'
export {
  InvalidRunStateError,
  CheckpointExpiredError,
  ForkLimitExceededError,
  RunNotFoundError,
} from './agent/run-handle-types.js'
export { ConcreteRunHandle } from './agent/run-handle.js'

// --- Parallel Executor ---
export { executeToolsParallel } from './agent/parallel-executor.js'
export type {
  ParallelToolCall,
  ToolExecutionResult,
  ToolLookup,
  ParallelExecutorOptions,
} from './agent/parallel-executor.js'

// --- Tool Arg Validation ---
export { validateAndRepairToolArgs, formatSchemaHint } from './agent/tool-arg-validator.js'
export type { ValidationResult, ToolArgValidatorConfig } from './agent/tool-arg-validator.js'

// --- Guardrails ---
export { IterationBudget } from './guardrails/iteration-budget.js'
export { StuckDetector } from './guardrails/stuck-detector.js'
export type { StuckDetectorConfig, StuckStatus } from './guardrails/stuck-detector.js'
export { StuckError } from './agent/stuck-error.js'
export type { EscalationLevel, RecoveryAction as StuckRecoveryAction } from './agent/stuck-error.js'
export { CascadingTimeout } from './guardrails/cascading-timeout.js'
export type { CascadingTimeoutConfig } from './guardrails/cascading-timeout.js'
export type {
  GuardrailConfig,
  BudgetState,
  BudgetWarning,
} from './guardrails/guardrail-types.js'

// --- Workflow ---
export { WorkflowBuilder, CompiledWorkflow, createWorkflow } from './workflow/workflow-builder.js'
export type { WorkflowConfig } from './workflow/workflow-builder.js'
export type {
  WorkflowStep,
  WorkflowContext,
  WorkflowEvent,
  MergeStrategy,
} from './workflow/workflow-types.js'

// --- Orchestration ---
export { AgentOrchestrator } from './orchestration/orchestrator.js'
export type { MergeFn, SupervisorConfig, SupervisorResult } from './orchestration/orchestrator.js'
export { OrchestrationError } from './orchestration/orchestration-error.js'
export type { OrchestrationPattern } from './orchestration/orchestration-error.js'
export { mapReduce, mapReduceMulti } from './orchestration/map-reduce.js'
export type { MapReduceConfig, MapReduceResult, AgentOutput } from './orchestration/map-reduce.js'
export {
  concatMerge,
  voteMerge,
  numberedMerge,
  jsonArrayMerge,
  getMergeStrategy,
} from './orchestration/merge-strategies.js'
export type { MergeStrategyFn } from './orchestration/merge-strategies.js'
export { ContractNetManager } from './orchestration/contract-net/contract-net-manager.js'
export {
  lowestCostStrategy,
  fastestStrategy,
  highestQualityStrategy,
  createWeightedStrategy,
} from './orchestration/contract-net/bid-strategies.js'
export type {
  ContractNetPhase,
  CallForProposals,
  ContractBid,
  ContractAward,
  ContractResult,
  ContractNetState,
  BidEvaluationStrategy,
  ContractNetConfig,
} from './orchestration/contract-net/contract-net-types.js'
export { DelegatingSupervisor } from './orchestration/delegating-supervisor.js'
export type {
  DelegatingSupervisorConfig,
  TaskAssignment,
  AggregatedDelegationResult,
  PlanAndDelegateOptions,
} from './orchestration/delegating-supervisor.js'
export { PlanningAgent, buildExecutionLevels, validatePlanStructure, PlanNodeSchema, DecompositionSchema } from './orchestration/planning-agent.js'
export type {
  PlanNode,
  ExecutionPlan,
  PlanExecutionResult,
  PlanningAgentConfig,
  DecompositionResult,
  DecomposeOptions,
} from './orchestration/planning-agent.js'
export { SimpleDelegationTracker } from './orchestration/delegation.js'
export type {
  DelegationRequest,
  DelegationResult,
  DelegationContext,
  DelegationMetadata,
  DelegationStatus,
  DelegationTracker,
  DelegationExecutor,
  ActiveDelegation,
  SimpleDelegationTrackerConfig,
} from './orchestration/delegation.js'
export { TopologyAnalyzer } from './orchestration/topology/topology-analyzer.js'
export { TopologyExecutor } from './orchestration/topology/topology-executor.js'
export type { MeshResult, RingResult, ExecuteResult } from './orchestration/topology/topology-executor.js'
export type {
  TopologyType,
  TaskCharacteristics,
  TopologyRecommendation,
  TopologyMetrics,
  TopologyExecutorConfig,
} from './orchestration/topology/topology-types.js'

// --- Routing Policy ---
export type {
  AgentSpec,
  AgentTask,
  RoutingDecision,
  RoutingPolicy,
  RuleBasedRoutingConfig,
  HashRoutingConfig,
} from './orchestration/routing-policy-types.js'

// --- Orchestration Merge Strategy ---
export type {
  AgentResult,
  MergedResult,
  OrchestrationMergeStrategy,
  BuiltInMergeStrategyName,
} from './orchestration/orchestration-merge-strategy-types.js'

// --- Routing Policies ---
export { RuleBasedRouting } from './orchestration/routing/rule-based-routing.js'
export { HashRouting } from './orchestration/routing/hash-routing.js'
export { LLMRouting } from './orchestration/routing/llm-routing.js'
export { RoundRobinRouting } from './orchestration/routing/round-robin-routing.js'

// --- Orchestration Merge Strategies ---
export { AllRequiredMergeStrategy } from './orchestration/merge/all-required.js'
export { UsePartialMergeStrategy } from './orchestration/merge/use-partial.js'
export { FirstWinsMergeStrategy } from './orchestration/merge/first-wins.js'

// --- Circuit Breaker ---
export { AgentCircuitBreaker } from './orchestration/circuit-breaker.js'
export type { CircuitState, CircuitBreakerConfig } from './orchestration/circuit-breaker.js'

// --- Provider Adapter Port ---
export type {
  ProviderExecutionPort,
  ProviderExecutionResult,
} from './orchestration/provider-adapter/index.js'

// --- Context ---
export { autoCompress, FrozenSnapshot } from './context/auto-compress.js'
export type { AutoCompressConfig, CompressResult } from './context/auto-compress.js'
export { withTokenLifecycle } from './context/token-lifecycle-integration.js'
export type {
  TokenLifecycleHooks,
  TokenLifecyclePhase,
  TokenPressureListener,
} from './context/token-lifecycle-integration.js'

// --- Approval ---
export { ApprovalGate } from './approval/approval-gate.js'
export type { ApprovalConfig, ApprovalMode, ApprovalResult } from './approval/approval-types.js'

// --- Tool Registry ---
export { DynamicToolRegistry } from './agent/tool-registry.js'
export type { ToolRegistryEvent } from './agent/tool-registry.js'

// --- Tools ---
export { createForgeTool } from './tools/create-tool.js'
export type { ForgeToolConfig } from './tools/create-tool.js'
export { createHumanContactTool, InMemoryPendingContactStore } from './tools/human-contact-tool.js'
export type { HumanContactInput, HumanContactToolConfig, PendingContactStore } from './tools/human-contact-tool.js'

// --- State (legacy) ---
export { serializeMessages, deserializeMessages } from './agent/agent-state.js'
export type {
  AgentStateSnapshot as LegacyAgentStateSnapshot,
  SerializedMessage as LegacySerializedMessage,
} from './agent/agent-state.js'

// --- Enhanced Snapshot ---
export {
  createSnapshot,
  verifySnapshot,
  compressSnapshot,
  decompressSnapshot,
} from './snapshot/agent-snapshot.js'
export type {
  AgentStateSnapshot,
  CreateSnapshotParams,
} from './snapshot/agent-snapshot.js'

// --- Enhanced Message Format ---
export {
  serializeMessage,
  migrateMessages,
} from './snapshot/serialized-message.js'
export type {
  SerializedMessage,
  MultimodalContent,
} from './snapshot/serialized-message.js'

// --- Structured Output ---
export {
  generateStructured as generateStructuredOutput,
  detectStrategy,
} from './structured/index.js'
export type {
  StructuredOutputStrategy,
  StructuredOutputCapabilities,
  StructuredOutputConfig,
  StructuredOutputResult,
  StructuredLLM,
  StructuredLLMWithMeta,
} from './structured/index.js'

// --- Tool Schema Registry ---
export { ToolSchemaRegistry } from './tools/tool-schema-registry.js'
export type {
  ToolSchemaEntry,
  CompatCheckResult,
} from './tools/tool-schema-registry.js'

// --- Streaming ---
export { StreamActionParser } from './streaming/stream-action-parser.js'
export type {
  StreamedToolCall,
  StreamActionEvent,
  StreamActionParserConfig,
} from './streaming/stream-action-parser.js'
export type {
  StreamEvent,
  TextDeltaEvent,
  ToolCallStartEvent,
  ToolCallEndEvent,
  DoneEvent,
  ErrorEvent,
} from './streaming/streaming-types.js'
export { TextDeltaBuffer } from './streaming/text-delta-buffer.js'
export { StreamingRunHandle } from './streaming/streaming-run-handle.js'
export type { StreamingStatus, StreamingRunHandleOptions } from './streaming/streaming-run-handle.js'

// --- Templates ---
export { AGENT_TEMPLATES, ALL_AGENT_TEMPLATES, getAgentTemplate, listAgentTemplates } from './templates/agent-templates.js'
export type { AgentTemplate, AgentTemplateCategory } from './templates/agent-templates.js'
export { composeTemplates } from './templates/template-composer.js'
export { TemplateRegistry } from './templates/template-registry.js'

// --- Pipeline ---
export { validatePipeline } from './pipeline/pipeline-validator.js'
export { InMemoryPipelineCheckpointStore } from './pipeline/in-memory-checkpoint-store.js'
export { PipelineRuntime } from './pipeline/pipeline-runtime.js'
export { executeLoop, stateFieldTruthy, qualityBelow, hasErrors } from './pipeline/loop-executor.js'
export type {
  PipelineState,
  NodeResult,
  PipelineRunResult,
  NodeExecutor,
  NodeExecutionContext,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
  LoopMetrics,
  RetryPolicy,
  OTelSpanLike,
  PipelineTracer,
} from './pipeline/pipeline-runtime-types.js'

// --- Step Type Registry ---
export { StepTypeRegistry, defaultStepTypeRegistry } from './pipeline/step-type-registry.js'
export type { StepContext, StepTypeDescriptor } from './pipeline/step-type-registry.js'

// --- Pipeline Retry ---
export {
  DEFAULT_RETRY_POLICY,
  calculateBackoff,
  isRetryable,
  resolveRetryPolicy,
} from './pipeline/retry-policy.js'

// --- Pipeline Templates ---
export {
  createCodeReviewPipeline,
  createFeatureGenerationPipeline,
  createTestGenerationPipeline,
  createRefactoringPipeline,
} from './pipeline/pipeline-templates.js'
export type {
  CodeReviewPipelineOptions,
  FeatureGenerationPipelineOptions,
  TestGenerationPipelineOptions,
  RefactoringPipelineOptions,
} from './pipeline/pipeline-templates.js'

// --- Security ---
export { AgentAuth } from './security/agent-auth.js'
export type {
  AgentCredential,
  SignedAgentMessage,
  AgentAuthConfig,
} from './security/agent-auth.js'

// --- Pipeline Analytics ---
export { PipelineAnalytics } from './pipeline/pipeline-analytics.js'
export type {
  NodeMetrics,
  BottleneckEntry,
  PipelineAnalyticsReport,
  AnalyticsNodeResult,
  AnalyticsRunInput,
} from './pipeline/pipeline-analytics.js'

// --- Playground ---
export { AgentPlayground } from './playground/playground.js'
export type { PlaygroundConfig } from './playground/playground.js'
export { SharedWorkspace } from './playground/shared-workspace.js'
export { TeamCoordinator } from './playground/team-coordinator.js'
export type {
  AgentRole,
  AgentSpawnConfig,
  CoordinationPattern,
  TeamConfig,
  AgentStatus,
  SpawnedAgent,
  PlaygroundEvent,
  TeamRunResult,
} from './playground/types.js'

// --- TeamRuntime (declarative team execution engine) ---
export {
  TeamRuntime,
  DEFAULT_ROUTER_MODEL,
  DEFAULT_PARTICIPANT_MODEL,
  DEFAULT_GOVERNANCE_MODEL,
} from './orchestration/team/team-runtime.js'
export type {
  TeamRuntimeEvent,
  TeamRuntimeEventEmitter,
  TeamRuntimeOptions,
  ParticipantResolver,
  TeamRuntimeTracer,
  TeamOTelSpanLike,
} from './orchestration/team/team-runtime.js'
export type {
  CoordinatorPattern as TeamCoordinatorPattern,
  ParticipantDefinition,
  TeamDefinition,
} from './orchestration/team/team-definition.js'
export type {
  ExecutionPolicy,
  GovernancePolicy,
  MemoryPolicy,
  IsolationPolicy,
  MailboxPolicy,
  EvaluationPolicy,
  TeamPolicies,
} from './orchestration/team/team-policy.js'
export type { TeamPhase, TeamPhaseModel } from './orchestration/team/team-phase.js'
export type { TeamCheckpoint, ResumeContract } from './orchestration/team/team-checkpoint.js'
export type {
  SupervisionPolicy,
  AgentBreakerState,
} from './orchestration/team/supervision-policy.js'

// --- Reflection ---
export { RunReflector } from './reflection/run-reflector.js'
export type {
  ReflectionScore,
  ReflectionDimensions,
  ReflectionInput,
  ReflectorConfig,
} from './reflection/run-reflector.js'
export { ReflectionAnalyzer } from './reflection/reflection-analyzer.js'
export type { ReflectionAnalyzerConfig } from './reflection/reflection-analyzer.js'
export { InMemoryReflectionStore } from './reflection/in-memory-reflection-store.js'
export type {
  ReflectionPattern,
  ReflectionSummary,
  RunReflectionStore,
} from './reflection/reflection-types.js'
export { createReflectionLearningBridge, buildWorkflowEventsFromToolStats } from './reflection/learning-bridge.js'
export type { ReflectionLearningBridgeConfig } from './reflection/learning-bridge.js'

// --- Recovery ---
export { RecoveryCopilot } from './recovery/recovery-copilot.js'
export type { StrategyGenerator } from './recovery/recovery-copilot.js'
export { FailureAnalyzer } from './recovery/failure-analyzer.js'
export type { FailureHistoryEntry, FailureAnalysis } from './recovery/failure-analyzer.js'
export { StrategyRanker } from './recovery/strategy-ranker.js'
export type { RankingWeights } from './recovery/strategy-ranker.js'
export { RecoveryExecutor } from './recovery/recovery-executor.js'
export type { ActionHandler, RecoveryExecutorConfig } from './recovery/recovery-executor.js'
export type {
  FailureType,
  FailureContext,
  RecoveryActionType,
  RecoveryAction,
  RiskLevel,
  RecoveryStrategy,
  RecoveryPlanStatus,
  RecoveryPlan,
  RecoveryCopilotConfig,
  RecoveryResult,
} from './recovery/recovery-types.js'

// --- Replay Debugger ---
export {
  TraceCapture,
  ReplayEngine,
  ReplayController,
  ReplayInspector,
  TraceSerializer,
} from './replay/index.js'
export type {
  ReplayEvent,
  Breakpoint,
  ReplayStatus,
  ReplaySession,
  TraceCaptureConfig,
  CapturedTrace,
  StateDiffEntry,
  TimelineNode,
  TimelineData,
  SerializationFormat,
  SerializeOptions,
  ReplayEventCallback,
  BreakpointHitCallback,
  StatusChangeCallback,
  ReplayNodeMetrics,
  ReplaySummary,
} from './replay/index.js'

// --- Instructions (AGENTS.md) ---
export { parseAgentsMd, mergeAgentsMd, discoverAgentsMdHierarchy } from './instructions/agents-md-parser.js'
export type { AgentsMdSection } from './instructions/agents-md-parser.js'
export { mergeInstructions } from './instructions/instruction-merger.js'
export type { MergedInstructions } from './instructions/instruction-merger.js'
export { loadAgentsFiles } from './instructions/instruction-loader.js'
export type { LoadedAgentsFile, LoadAgentsOptions } from './instructions/instruction-loader.js'

// --- Self-Correction (ReflectionLoop) ---
export { ReflectionLoop, parseCriticResponse } from './self-correction/reflection-loop.js'
export type { ReflectionConfig, ReflectionIteration, ReflectionResult, ScoreResult } from './self-correction/reflection-loop.js'

// --- Self-Correction (AdaptiveIterationController) ---
export { AdaptiveIterationController } from './self-correction/iteration-controller.js'
export type { IterationDecision, IterationControllerConfig } from './self-correction/iteration-controller.js'

// --- Self-Correction (SelfCorrectingNode) ---
export { createSelfCorrectingExecutor } from './self-correction/self-correcting-node.js'
export type { SelfCorrectingConfig, SelfCorrectingResult } from './self-correction/self-correcting-node.js'

// --- Self-Correction (ErrorDetectionOrchestrator) ---
export { ErrorDetectionOrchestrator } from './self-correction/error-detector.js'
export type {
  ErrorSource,
  ErrorSeverity,
  DetectedError,
  ErrorDetectorConfig,
} from './self-correction/error-detector.js'

// --- Self-Correction (RootCauseAnalyzer) ---
export { RootCauseAnalyzer } from './self-correction/root-cause-analyzer.js'
export type {
  RootCauseReport,
  RootCauseAnalyzerConfig,
  AnalyzeParams,
  HeuristicClassification,
} from './self-correction/root-cause-analyzer.js'

// --- Self-Correction (VerificationProtocol) ---
export { VerificationProtocol, jaccardSimilarity } from './self-correction/verification-protocol.js'
export type {
  VerificationStrategy,
  VerificationResult,
  VerificationConfig,
} from './self-correction/verification-protocol.js'

// --- Self-Correction (SelfLearningRuntime) ---
export { SelfLearningRuntime } from './self-correction/self-learning-runtime.js'
export type {
  SelfLearningConfig,
  SelfLearningRunResult,
} from './self-correction/self-learning-runtime.js'

// --- Self-Correction (SelfLearningPipelineHook) ---
export { SelfLearningPipelineHook } from './self-correction/self-learning-hook.js'
export type { SelfLearningHookConfig, HookMetrics } from './self-correction/self-learning-hook.js'

// --- Self-Correction (PostRunAnalyzer) ---
export { PostRunAnalyzer } from './self-correction/post-run-analyzer.js'
export type {
  RunAnalysis,
  AnalysisResult,
  PostRunAnalyzerConfig,
  AnalysisHistoryEntry,
} from './self-correction/post-run-analyzer.js'

// --- Self-Correction (AdaptivePromptEnricher) ---
export { AdaptivePromptEnricher } from './self-correction/adaptive-prompt-enricher.js'
export type {
  PromptEnrichment,
  EnricherConfig,
  EnrichParams,
  EnrichWithBudgetParams,
} from './self-correction/adaptive-prompt-enricher.js'

// --- Self-Correction (PipelineStuckDetector) ---
export { PipelineStuckDetector } from './self-correction/pipeline-stuck-detector.js'
export type {
  PipelineStuckConfig,
  PipelineStuckStatus,
  PipelineStuckSummary,
  PipelineSuggestedAction,
} from './self-correction/pipeline-stuck-detector.js'

// --- Self-Correction (TrajectoryCalibrator) ---
export { TrajectoryCalibrator } from './self-correction/trajectory-calibrator.js'
export type {
  StepReward,
  TrajectoryRecord,
  SuboptimalResult,
  TrajectoryCalibratorConfig,
} from './self-correction/trajectory-calibrator.js'

// --- Self-Correction (ObservabilityCorrectionBridge) ---
export { ObservabilityCorrectionBridge } from './self-correction/observability-bridge.js'
export type {
  CorrectionSignal,
  CorrectionSignalType,
  SignalSeverity,
  ObservabilityThresholds,
  ObservabilityBridgeConfig,
} from './self-correction/observability-bridge.js'

// --- Self-Correction (StrategySelector) ---
export { StrategySelector } from './self-correction/strategy-selector.js'
export type {
  FixStrategy,
  StrategyRate,
  StrategyRecommendation,
  StrategySelectorConfig,
} from './self-correction/strategy-selector.js'

// --- Self-Correction (RecoveryFeedback) ---
export { RecoveryFeedback } from './self-correction/recovery-feedback.js'
export type { RecoveryLesson, RecoveryFeedbackConfig } from './self-correction/recovery-feedback.js'

// --- Self-Correction (AgentPerformanceOptimizer) ---
export { AgentPerformanceOptimizer } from './self-correction/performance-optimizer.js'
export type {
  OptimizationDecision,
  PerformanceHistory,
  PerformanceOptimizerConfig,
} from './self-correction/performance-optimizer.js'

// --- Self-Correction (LangGraphLearningMiddleware) ---
export { LangGraphLearningMiddleware } from './self-correction/langgraph-middleware.js'
export type {
  LangGraphLearningConfig,
  LearningRunMetrics,
  WrapNodeOptions,
} from './self-correction/langgraph-middleware.js'

// --- Self-Correction (FeedbackCollector) ---
export { FeedbackCollector } from './self-correction/feedback-collector.js'
export type {
  FeedbackType,
  FeedbackOutcome,
  FeedbackRecord,
  FeedbackStats,
  FeedbackCollectorConfig,
} from './self-correction/feedback-collector.js'

// --- Self-Correction (LearningDashboardService) ---
export { LearningDashboardService } from './self-correction/learning-dashboard.js'
export type {
  LearningOverview,
  QualityTrend,
  CostTrend,
  NodePerformanceSummary,
  LearningDashboard,
  DashboardServiceConfig,
} from './self-correction/learning-dashboard.js'

// --- Presets ---
export {
  type AgentPreset,
  type PresetRuntimeDeps,
  type PresetConfig,
  buildConfigFromPreset,
  PresetRegistry,
  createDefaultPresetRegistry,
  RAGChatPreset,
  ResearchPreset,
  SummarizerPreset,
  QAPreset,
  BUILT_IN_PRESETS,
} from './presets/index.js'

// --- Skill Chain Executor ---
export { executeTextualWorkflow, streamTextualWorkflow, createSkillChainWorkflow } from './skill-chain-executor/index.js'
export type { TextualWorkflowOptions } from './skill-chain-executor/index.js'
export { SharedAgentSkillResolver, SkillChainExecutor } from './skill-chain-executor/index.js'
export type {
  SkillStepResolver,
  SharedAgentSkillResolverConfig,
  SkillChainExecutorConfig,
  ExecuteOptions,
  DryRunStepInfo,
  DryRunResult,
  ChainStepInput,
  ChainStepOutput,
  ChainFinalState,
  StateTransformer,
  CandidateInterpretation,
} from './skill-chain-executor/index.js'
export {
  SkillNotFoundError,
  ChainValidationError,
  StepExecutionError,
  WorkflowParseError,
} from './skill-chain-executor/index.js'

// --- Cluster Workspaces ---
export type { ClusterRole, AgentCluster } from './cluster/index.js'
export { InMemoryAgentCluster } from './cluster/index.js'
export type { InMemoryAgentClusterConfig } from './cluster/index.js'

// --- Mailbox ---
export type {
  MailMessage,
  MailboxQuery,
  MailboxStore,
  AgentMailbox,
} from './mailbox/index.js'

export { InMemoryMailboxStore } from './mailbox/index.js'
export { AgentMailboxImpl } from './mailbox/index.js'
export type { AgentMailboxOptions } from './mailbox/index.js'
export { createSendMailTool, createCheckMailTool } from './mailbox/index.js'
export type { MailToolConfig } from './mailbox/index.js'
export { InMemoryDeadLetterStore } from './mailbox/index.js'
export type {
  DeadLetter,
  DeadLetterMeta,
  DeadLetterStore,
} from './mailbox/index.js'
export {
  RateLimiter,
  MailRateLimitedError,
  DEFAULT_RATE_LIMIT,
} from './mailbox/index.js'
export type { RateLimiterConfig } from './mailbox/index.js'

// --- Token Lifecycle Wiring (default-loop plugin) ---
export { createTokenLifecyclePlugin } from './token-lifecycle-wiring.js'
export type {
  AgentLoopPlugin,
  TokenLifecyclePluginOptions,
  CompressionHintListener,
} from './token-lifecycle-wiring.js'

// --- Version ---
export const dzupagent_AGENT_VERSION = '0.1.0'
