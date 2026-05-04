/**
 * @dzupagent/agent/orchestration — workflow builder and orchestration patterns.
 *
 * Use this subpath for `WorkflowBuilder`/`createWorkflow`, the
 * `AgentOrchestrator` patterns (sequential / parallel / supervisor / debate),
 * routing policies, topology execution, contract net, delegation, and merge
 * strategies. The root barrel re-exports these symbols for backwards
 * compatibility.
 */

// --- Workflow ---
export { WorkflowBuilder, CompiledWorkflow, createWorkflow } from './workflow/workflow-builder.js'
export type { WorkflowConfig } from './workflow/workflow-builder.js'
export type {
  WorkflowStep,
  WorkflowContext,
  WorkflowEvent,
  MergeStrategy,
} from './workflow/workflow-types.js'

// --- Orchestrator ---
export { AgentOrchestrator } from './orchestration/orchestrator.js'
export type { MergeFn, SupervisorConfig, SupervisorResult } from './orchestration/orchestrator.js'
export { OrchestrationError } from './orchestration/orchestration-error.js'
export type { OrchestrationPattern } from './orchestration/orchestration-error.js'

// --- Map / Reduce ---
export { mapReduce, mapReduceMulti } from './orchestration/map-reduce.js'
export type { MapReduceConfig, MapReduceResult, AgentOutput } from './orchestration/map-reduce.js'

// --- Merge strategies ---
export {
  concatMerge,
  voteMerge,
  numberedMerge,
  jsonArrayMerge,
  getMergeStrategy,
} from './orchestration/merge-strategies.js'
export type { MergeStrategyFn, MergeStrategyName } from './orchestration/merge-strategies.js'

// --- Contract Net ---
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

// --- Delegation ---
export { DelegatingSupervisor } from './orchestration/delegating-supervisor.js'
export type {
  DelegatingSupervisorConfig,
  TaskAssignment,
  AggregatedDelegationResult,
  PlanAndDelegateOptions,
  DelegateTaskOptions,
} from './orchestration/delegating-supervisor.js'
export { PlanningAgent, buildExecutionLevels, validatePlanStructure, PlanNodeSchema, DecompositionSchema } from './orchestration/planning-agent.js'
export type {
  PlanNode,
  ExecutionPlan,
  PlanExecutionResult,
  PlanningDecompositionDiagnostics,
  RemovedPlanNodeDiagnostic,
  DanglingPlanDependencyDiagnostic,
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

// --- Topology ---
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

// --- Routing ---
export type {
  AgentSpec,
  AgentTask,
  RoutingDecision,
  RoutingPolicy,
  RuleBasedRoutingConfig,
  HashRoutingConfig,
} from './orchestration/routing-policy-types.js'
export { RuleBasedRouting } from './orchestration/routing/rule-based-routing.js'
export { HashRouting } from './orchestration/routing/hash-routing.js'
export { LLMRouting } from './orchestration/routing/llm-routing.js'
export { RoundRobinRouting } from './orchestration/routing/round-robin-routing.js'

// --- Orchestration merge strategies ---
export type {
  AgentResult,
  MergedResult,
  OrchestrationMergeStrategy,
  BuiltInMergeStrategyName,
} from './orchestration/orchestration-merge-strategy-types.js'
export { AllRequiredMergeStrategy } from './orchestration/merge/all-required.js'
export { UsePartialMergeStrategy } from './orchestration/merge/use-partial.js'
export { FirstWinsMergeStrategy } from './orchestration/merge/first-wins.js'

// --- Circuit breaker ---
export { AgentCircuitBreaker } from './orchestration/circuit-breaker.js'
export type { CircuitState, CircuitBreakerConfig } from './orchestration/circuit-breaker.js'

// --- Provider port ---
export type {
  ProviderExecutionPort,
  ProviderExecutionResult,
} from './orchestration/provider-adapter/index.js'

// --- Team Runtime ---
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
export { SharedWorkspace } from './orchestration/team/team-workspace.js'
export type {
  WorkspaceSubscriber,
  TeamAgentRole,
  TeamAgentStatus,
  TeamSpawnedAgent,
  TeamAgentRunResult,
} from './orchestration/team/team-workspace.js'
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
