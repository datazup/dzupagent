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
} from './team-definition.js'

export type {
  ExecutionPolicy,
  GovernancePolicy,
  MemoryPolicy,
  IsolationPolicy,
  MailboxPolicy,
  EvaluationPolicy,
  TeamPolicies,
} from './team-policy.js'

export type { TeamPhase, TeamPhaseModel } from './team-phase.js'

export type { TeamCheckpoint, ResumeContract } from './team-checkpoint.js'

export type {
  SupervisionPolicy,
  AgentBreakerState,
} from './supervision-policy.js'

export {
  TeamRuntime,
  DEFAULT_ROUTER_MODEL,
  DEFAULT_PARTICIPANT_MODEL,
  DEFAULT_GOVERNANCE_MODEL,
} from './team-runtime.js'
export type {
  TeamRuntimeEvent,
  TeamRuntimeEventEmitter,
  TeamRuntimeOptions,
  ParticipantResolver,
  TeamRuntimeTracer,
  TeamOTelSpanLike,
} from './team-runtime.js'

export { SharedWorkspace } from './team-workspace.js'
export type {
  WorkspaceSubscriber,
  TeamAgentRole,
  TeamAgentStatus,
  TeamSpawnedAgent,
  TeamAgentRunResult,
  TeamRunResult,
} from './team-workspace.js'
