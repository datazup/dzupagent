/**
 * `@dzupagent/subagents` — governed async background subagents.
 *
 * A portable, policy-gated, checkpointer-backed runtime for spawning subagents
 * that run in the background (in-process or via a durable queue), under the
 * host's policy engine and HITL approval gates, surfaced over both LLM-facing
 * tools and a programmatic API.
 *
 * See `OWN-WRAP-CONVERGE.md` for the boundary policy (why this is owned vs.
 * adopted from upstream) and the exit cost of each injected seam.
 */

// Contracts (seams)
export type {
  BackgroundTask,
  SubagentSpec,
  SubagentResult,
  TaskId,
  TaskStatus,
} from "./contracts/background-task.js";
export {
  TERMINAL_STATUSES,
  isTerminalStatus,
} from "./contracts/background-task.js";
export type {
  TaskRunner,
  RunnerCapabilities,
} from "./contracts/task-runner.js";
export type { TaskStore, TaskFilter } from "./contracts/task-store.js";
export type { CheckpointerPort } from "./contracts/checkpointer-port.js";
export type {
  SubagentExecutorPort,
  SubagentExecutionContext,
} from "./contracts/subagent-executor-port.js";
export type {
  SubagentRuntimeEvent,
  SubagentEventType,
  FanoutRuntimeEvent,
  FanoutEventType,
  SubagentEventSink,
} from "./contracts/events.js";
export type { Clock } from "./contracts/clock.js";
export { systemClock } from "./contracts/clock.js";
export type { SubagentLogger, SubagentLogFields } from "./contracts/logger.js";
export {
  defaultSubagentLogger,
  noopSubagentLogger,
} from "./contracts/logger.js";
export {
  SubagentErrorCode,
  isRecoverableError,
} from "./contracts/error-codes.js";

// Runtime
export {
  BackgroundSubagentRuntime,
  type BackgroundSubagentRuntimeDeps,
  type GovernanceEventSink,
  type SpawnOutcome,
  type SpawnOptions,
  type SpawnBatchAdmission,
} from "./runtime/background-subagent-runtime.js";
export {
  createInProcessSubagentRuntime,
  type CreateInProcessRuntimeOptions,
  type RunnerFactoryDeps,
} from "./runtime/create-runtime.js";
export {
  DEFAULT_LIFECYCLE_POLICY,
  type LifecyclePolicy,
} from "./runtime/runtime-config.js";

// Lifecycle
export {
  LifecycleController,
  type AdmissionDecision,
} from "./lifecycle/lifecycle-controller.js";

// Governance
export {
  SpawnGate,
  allowAllSpawnPolicy,
  denyAllSpawnPolicy,
  validateBatchScope,
  type SpawnPolicy,
  type SpawnPolicyDecision,
  type SpawnContext,
  type SpawnApprovalGate,
  type SpawnBatchMode,
  type SpawnBatchRequest,
  type ApprovedSpawnBatch,
} from "./governance/spawn-gate.js";

// Runners
export {
  InProcessRunner,
  type InProcessRunnerDeps,
} from "./runner/in-process-runner.js";
export {
  DurableQueueRunner,
  InMemoryTaskQueue,
  type TaskQueue,
  type DurableQueueRunnerDeps,
} from "./runner/durable-queue-runner.js";

// Stores
export { InMemoryTaskStore } from "./store/in-memory-task-store.js";
export { InMemoryCheckpointer } from "./store/in-memory-checkpointer.js";
export { InMemoryFanoutBatchStore } from "./store/in-memory-fanout-batch-store.js";
export {
  HostTaskStore,
  type HostTaskStoreOptions,
} from "./store/host-task-store.js";
export {
  HostTaskQueue,
  type HostTaskQueueOptions,
} from "./store/host-task-queue.js";
export {
  createPostgresSubagentSchemaSql,
  PostgresTaskQueue,
  PostgresTaskStore,
  recoverStaleRunningTasks,
  type PostgresSubagentSchemaSqlOptions,
  type PostgresQueryClient,
  type PostgresTaskQueueOptions,
  type PostgresTaskStoreOptions,
  type RecoverStaleRunningTasksOptions,
  type VersionedTask,
} from "./store/postgres-task-store.js";
export {
  type FanoutBatchStore,
  type FanoutBatchMode,
  type FanoutBatchStatus,
  type FanoutBatchItemStatus,
  type FanoutBatchItemRecord,
  type FanoutBatchRecord,
  type FanoutBatchCreate,
  type FanoutBatchItemUpdate,
  type FanoutBatchCompleteUpdate,
} from "./contracts/fanout-batch-store.js";

// API + tools
export {
  OrchestratorBackgroundApi,
  TaskHandle,
} from "./api/orchestrator-background-api.js";
export {
  createSubagentTools,
  type SubagentToolDescriptor,
  type SubagentToolsConfig,
} from "./tools/subagent-tools.js";
export {
  createFanoutTemplateTool,
  fanoutBatchRecordToReport,
  isFanoutValidationError,
  DEFAULT_FANOUT_LIMITS,
  type FanoutToolConfig,
  type FanoutLimits,
  type FanoutItem,
  type FanoutTemplateArgs,
  type FanoutItemStatus,
  type FanoutReport,
  type FanoutReportItem,
  type FanoutValidationError,
} from "./tools/fanout-tool.js";

// Fanout eval harness — deterministic scorers + runner for spawn-decision
// quality, agent-identity resolution, and fan-out report accuracy.
export {
  type FanoutEvalResult,
  type FanoutScorerConfig,
  type FanoutScorer,
  type FanoutEvalCase,
  type FanoutCaseScore,
  type FanoutSuiteReport,
  runFanoutEvalSuite,
  runFanoutEvalSuites,
  createSpawnDecisionScorer,
  type SpawnDecisionCase,
  createAgentIdentityResolutionScorer,
  type AgentIdentityResolutionCase,
  createFanoutReportAccuracyScorer,
  scoreFanoutBatchRecord,
  checkReportInternalConsistency,
  type FanoutReportAccuracyCase,
  SPAWN_DECISION_SCENARIOS,
  SPAWN_DECISION_KNOWN_BAD_CASE,
  AGENT_IDENTITY_RESOLUTION_SCENARIOS,
  AGENT_IDENTITY_RESOLUTION_KNOWN_BAD_CASE,
  FANOUT_REPORT_ACCURACY_SCENARIOS,
  FANOUT_REPORT_ACCURACY_KNOWN_BAD_CASE,
} from "./eval/index.js";
