/**
 * @dzupagent/agent/fleet — Fleet orchestration primitives.
 *
 * Exports FleetSupervisor, RepoAgent, resume utilities, and the built-in
 * policies (FanOutPolicy, DependencyTrackerPolicy, SupervisorPolicy,
 * ContractNetPolicy).
 */
export {
  RepoAgent,
  FleetSupervisor,
  computeResumePlan,
  FanOutPolicy,
  DependencyTrackerPolicy,
  SupervisorPolicy,
  ContractNetPolicy,
} from "./orchestration/fleet/index.js";
export type {
  RepoAgentDeps,
  FleetSupervisorDeps,
  ResumePlan,
  ComputeResumePlanOptions,
  ContractNetPolicyOptions,
} from "./orchestration/fleet/index.js";
