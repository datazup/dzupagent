/**
 * @forgeagent/core/orchestration — Curated API facade for multi-agent
 * orchestration, pipelines, routing, and event-driven coordination.
 *
 * @example
 * ```ts
 * import {
 *   createEventBus,
 *   IntentRouter,
 *   PipelineDefinitionSchema,
 * } from '@forgeagent/core/orchestration';
 * ```
 */

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
export { createEventBus } from '../events/event-bus.js'
export type { ForgeEventBus } from '../events/event-bus.js'
export type { ForgeEvent, ForgeEventOf, BudgetUsage, ToolStatSummary } from '../events/event-types.js'
export { AgentBus } from '../events/agent-bus.js'
export type { AgentMessage, AgentMessageHandler } from '../events/agent-bus.js'

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
export type { AgentHooks, HookContext } from '../hooks/hook-types.js'
export { runHooks, runModifierHook, mergeHooks } from '../hooks/hook-runner.js'

// ---------------------------------------------------------------------------
// Plugin system
// ---------------------------------------------------------------------------
export type { ForgePlugin, PluginContext } from '../plugin/plugin-types.js'
export { PluginRegistry } from '../plugin/plugin-registry.js'
export { discoverPlugins, validateManifest, resolvePluginOrder } from '../plugin/plugin-discovery.js'
export type { PluginManifest, DiscoveredPlugin, PluginDiscoveryConfig } from '../plugin/plugin-discovery.js'

// ---------------------------------------------------------------------------
// Router / intent classification
// ---------------------------------------------------------------------------
export { IntentRouter } from '../router/intent-router.js'
export type { IntentRouterConfig, ClassificationResult } from '../router/intent-router.js'
export { KeywordMatcher } from '../router/keyword-matcher.js'
export { LLMClassifier } from '../router/llm-classifier.js'
export { CostAwareRouter, isSimpleTurn, scoreComplexity } from '../router/cost-aware-router.js'
export type { CostAwareResult, CostAwareRouterConfig, ComplexityLevel } from '../router/cost-aware-router.js'
export { ModelTierEscalationPolicy } from '../router/escalation-policy.js'
export type { EscalationPolicyConfig, EscalationResult } from '../router/escalation-policy.js'

// ---------------------------------------------------------------------------
// Sub-agents
// ---------------------------------------------------------------------------
export { SubAgentSpawner } from '../subagent/subagent-spawner.js'
export { REACT_DEFAULTS } from '../subagent/subagent-types.js'
export type { SubAgentConfig, SubAgentResult, SubAgentUsage } from '../subagent/subagent-types.js'
export { mergeFileChanges, fileDataReducer } from '../subagent/file-merge.js'

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
export { SkillLoader } from '../skills/skill-loader.js'
export { injectSkills } from '../skills/skill-injector.js'
export type { SkillDefinition } from '../skills/skill-types.js'
export { SkillManager } from '../skills/skill-manager.js'
export type { SkillManagerConfig, CreateSkillInput, PatchSkillInput, SkillWriteResult } from '../skills/skill-manager.js'
export { SkillLearner } from '../skills/skill-learner.js'
export type { SkillMetrics, SkillExecutionResult, SkillLearnerConfig } from '../skills/skill-learner.js'
export { createSkillChain, validateChain } from '../skills/skill-chain.js'
export type { SkillChainStep, SkillChain, ChainValidationResult } from '../skills/skill-chain.js'
export { parseAgentsMd, mergeAgentsMdConfigs } from '../skills/agents-md-parser.js'
export type { AgentsMdConfig } from '../skills/agents-md-parser.js'
export { discoverAgentConfigs } from '../skills/hierarchical-walker.js'
export type { HierarchyLevel } from '../skills/hierarchical-walker.js'

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------
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
  NodePosition,
  ViewportState,
  PipelineLayout,
} from '../pipeline/index.js'
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
  autoLayout,
} from '../pipeline/index.js'

// ---------------------------------------------------------------------------
// Persistence (run/session tracking for orchestration)
// ---------------------------------------------------------------------------
export { InMemoryRunStore, InMemoryAgentStore } from '../persistence/in-memory-store.js'
export type {
  RunStore,
  Run,
  CreateRunInput,
  RunFilter,
  RunStatus,
  LogEntry,
  AgentStore,
  AgentDefinition,
  AgentFilter,
} from '../persistence/store-interfaces.js'
export { InMemoryEventLog, EventLogSink } from '../persistence/event-log.js'
export type { RunEvent, EventLogStore } from '../persistence/event-log.js'

// ---------------------------------------------------------------------------
// Protocol (inter-agent messaging)
// ---------------------------------------------------------------------------
export {
  createMessageId,
  createForgeMessage,
  createResponse,
  createErrorResponse,
  isMessageAlive,
  validateForgeMessage,
  InternalAdapter,
  ProtocolRouter,
  A2AClientAdapter,
  streamA2ATask,
  parseSSEEvents,
  ProtocolBridge,
} from '../protocol/index.js'
export type {
  ForgeMessageId,
  ForgeMessageType,
  ForgeProtocol,
  MessagePriority,
  MessageBudget,
  ForgeMessageMetadata,
  ForgePayload,
  ForgeMessage,
  ProtocolAdapter,
  ProtocolRouterConfig,
  ProtocolBridgeConfig,
  BridgeDirection,
} from '../protocol/index.js'

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
export type { AgentMiddleware } from '../middleware/types.js'
export { calculateCostCents, getModelCosts } from '../middleware/cost-tracking.js'
export type { CostTracker } from '../middleware/cost-tracking.js'
export { CostAttributionCollector } from '../middleware/cost-attribution.js'
export type { CostAttribution, CostReport, CostBucket, CostAttributionConfig } from '../middleware/cost-attribution.js'

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------
export { Semaphore } from '../concurrency/semaphore.js'
export { ConcurrencyPool } from '../concurrency/pool.js'
export type { PoolConfig, PoolStats } from '../concurrency/pool.js'

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------
export { MetricsCollector, globalMetrics } from '../observability/metrics-collector.js'
export type { MetricType } from '../observability/metrics-collector.js'
export { HealthAggregator } from '../observability/health-aggregator.js'
export type { HealthStatus, HealthCheck, HealthReport, HealthCheckFn } from '../observability/health-aggregator.js'

// ---------------------------------------------------------------------------
// Telemetry (trace propagation)
// ---------------------------------------------------------------------------
export { injectTraceContext, extractTraceContext, formatTraceparent, parseTraceparent } from '../telemetry/trace-propagation.js'
export type { TraceContext } from '../telemetry/trace-propagation.js'
