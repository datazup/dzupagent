/**
 * Barrel for the team orchestration module.
 *
 * Exposes declarative team shape (`team-definition`), runtime policies
 * (`team-policy`), lifecycle tracking (`team-phase`), suspend/resume
 * contracts (`team-checkpoint`), and the production runtime (`team-runtime`).
 */

export type {
  CoordinatorPattern,
  ParticipantDefinition,
  TeamDefinition,
} from "./team-definition.js";

export type {
  ExecutionPolicy,
  GovernancePolicy,
  MemoryPolicy,
  ContractNetPolicy,
  IsolationPolicy,
  MailboxPolicy,
  EvaluationPolicy,
  TeamPolicies,
} from "./team-policy.js";

export type { TeamPhase, TeamPhaseModel } from "./team-phase.js";

export type { TeamCheckpoint, ResumeContract } from "./team-checkpoint.js";

export type {
  SupervisionPolicy,
  AgentBreakerState,
} from "./supervision-policy.js";

export {
  TeamRuntime,
  TeamVerdictRejectedError,
  DEFAULT_ROUTER_MODEL,
  DEFAULT_PARTICIPANT_MODEL,
  DEFAULT_GOVERNANCE_MODEL,
} from "./team-runtime.js";
export type {
  TeamRuntimeEvent,
  TeamRuntimeEventEmitter,
  TeamRuntimeOptions,
  TeamContractNetRuntimeOptions,
  ParticipantResolver,
  TeamRuntimeTracer,
  TeamOTelSpanLike,
  TeamRuntimeMemoryService,
  TeamGovernanceService,
  TeamEvaluationService,
  TeamVerdict,
  TeamVerdictInput,
} from "./team-runtime.js";

export { SharedWorkspace } from "./team-workspace.js";
export type {
  WorkspaceSubscriber,
  TeamAgentRole,
  TeamAgentStatus,
  TeamSpawnedAgent,
  TeamAgentRunResult,
  TeamRunResult,
} from "./team-workspace.js";

export {
  createLlmJudgeVerdictService,
  TeamJudgeUnavailableError,
} from "./team-verdict-llm-judge.js";
export type {
  JudgeFailurePolicy,
  JudgeInvoker,
  LlmJudgeVerdictOptions,
  LlmJudgeVerdictService,
} from "./team-verdict-llm-judge.js";

export {
  JudgeBudgetExceededError,
  JudgeTimeoutError,
  withJudgeBudget,
  withJudgeCache,
  withJudgeTimeout,
} from "./team-verdict-judge-controls.js";
export type {
  AbortableJudgeInvoker,
  JudgeBudgetOptions,
  JudgeCacheOptions,
  JudgeTimeoutOptions,
} from "./team-verdict-judge-controls.js";
