/**
 * Public agent-coordination runtime surface: agent/provider sequencing,
 * delegation, supervision, team patterns, routing, and result merging.
 * Repository delivery, product workflow state, and reusable Datazup
 * orchestration-kernel semantics are separate bounded contexts.
 */
export { AgentOrchestrator } from "./orchestrator.js";
export type {
  MergeFn,
  SupervisorConfig,
  SupervisorResult,
} from "./orchestrator.js";

export { OrchestrationError } from "./orchestration-error.js";
export type { OrchestrationPattern } from "./orchestration-error.js";

export { mapReduce, mapReduceMulti } from "./map-reduce.js";
export type {
  MapReduceConfig,
  MapReduceResult,
  AgentOutput,
} from "./map-reduce.js";

export {
  concatMerge,
  voteMerge,
  numberedMerge,
  jsonArrayMerge,
  getMergeStrategy,
} from "./merge-strategies.js";
export type { MergeStrategyFn, MergeStrategyName } from "./merge-strategies.js";

export { ContractNetManager } from "./contract-net/contract-net-manager.js";
export {
  lowestCostStrategy,
  fastestStrategy,
  highestQualityStrategy,
  createWeightedStrategy,
} from "./contract-net/bid-strategies.js";
export type {
  ContractNetPhase,
  CallForProposals,
  ContractBid,
  ContractAward,
  ContractResult,
  ContractNetState,
  BidEvaluationStrategy,
  ContractNetConfig,
} from "./contract-net/contract-net-types.js";

export { DelegatingSupervisor } from "./delegating-supervisor.js";
export type {
  DelegatingSupervisorConfig,
  TaskAssignment,
  AggregatedDelegationResult,
  DelegateTaskOptions,
  DuplicateSpecialistAssignmentIdMode,
  SubOrchestratorSpawnOptions,
  SubOrchestratorSpawnResult,
  SubOrchestratorChildHierarchy,
  SubOrchestratorFactory,
} from "./delegating-supervisor.js";

export { TopologyAnalyzer } from "./topology/topology-analyzer.js";
export { TopologyExecutor } from "./topology/topology-executor.js";
export type {
  MeshResult,
  RingResult,
  ExecuteResult,
} from "./topology/topology-executor.js";
export type {
  TopologyType,
  TaskCharacteristics,
  TopologyRecommendation,
  TopologyMetrics,
  TopologyExecutorConfig,
} from "./topology/topology-types.js";

// --- Routing Policy ---
export type {
  AgentSpec,
  AgentTask,
  RoutingTaskInput,
  RoutingDecision,
  RoutingPolicy,
  RuleBasedRoutingConfig,
  HashRoutingConfig,
} from "./routing-policy-types.js";

// --- Orchestration Merge Strategy ---
export type {
  AgentResult,
  MergedResult,
  OrchestrationMergeStrategy,
  BuiltInMergeStrategyName,
} from "./orchestration-merge-strategy-types.js";

// --- Provider Adapter Port ---
export type {
  ProviderExecutionPort,
  ProviderExecutionResult,
} from "./provider-adapter/index.js";

// --- Routing Policies ---
export { RuleBasedRouting } from "./routing/rule-based-routing.js";
export { HashRouting } from "./routing/hash-routing.js";
export { LLMRouting } from "./routing/llm-routing.js";
export { RoundRobinRouting } from "./routing/round-robin-routing.js";

// --- Orchestration Merge Strategies ---
export { AllRequiredMergeStrategy } from "./merge/all-required.js";
export { UsePartialMergeStrategy } from "./merge/use-partial.js";
export { FirstWinsMergeStrategy } from "./merge/first-wins.js";

// --- Fleet Gather Strategies (fleet.gather DSL vocabulary) ---
export {
  GATHER_STRATEGY_NAMES,
  isGatherStrategyName,
  createGatherStrategy,
  ConcatGatherStrategy,
  BestGatherStrategy,
} from "./gather/gather-strategies.js";
export type {
  GatherStrategyName,
  GatherScoreFn,
  GatherStrategyOptions,
} from "./gather/gather-strategies.js";
export {
  toAgentResults,
  applyGatherStep,
  applyLlmGatherStep,
} from "./gather/fleet-gather-bridge.js";
export type { FleetGatherAdapterOptions } from "./gather/fleet-gather-bridge.js";

// --- LLM-backed Fleet Gather Strategies (synthesis / judge) ---
export {
  LLM_GATHER_STRATEGY_NAMES,
  isLlmGatherStrategyName,
  createLlmGatherStrategy,
  SynthesisGatherStrategy,
  JudgeGatherStrategy,
  agentAsGatherModel,
} from "./gather/llm-gather-strategies.js";
export type {
  LlmGatherStrategyName,
  GatherModel,
  GatherAgentLike,
  GatherRenderFn,
  AsyncOrchestrationMergeStrategy,
  LlmGatherStrategyOptions,
  SynthesisGatherOptions,
  JudgeGatherOptions,
} from "./gather/llm-gather-strategies.js";

// --- Circuit Breaker ---
export { AgentCircuitBreaker } from "./circuit-breaker.js";
export type { CircuitState, CircuitBreakerConfig } from "./circuit-breaker.js";

// --- Orchestration Telemetry ---
export {
  recordRoutingDecision,
  recordMergeOperation,
  recordCircuitBreakerEvent,
} from "./orchestration-telemetry.js";
export type {
  RoutingSpanData,
  MergeSpanData,
} from "./orchestration-telemetry.js";
