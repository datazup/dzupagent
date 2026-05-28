import type {
  Assignment,
  ContractChange,
  EscalationReason,
  FleetTask,
  ReconciliationPlan,
  RepoAgentResult,
} from "../fleet-types.js";
import type { KnowledgeStore } from "../knowledge-store.js";

export interface RepoAgentRef {
  workerId: string;
  repo: string;
  busy: boolean;
}

export type HumanHandoff = { kind: "human-handoff"; note: string };
export type Retry = { kind: "retry"; delayMs: number };
export type EscalationOutcome = HumanHandoff | Retry;

export interface FleetSupervisorApi {
  pauseTask(taskId: string, reason: string): Promise<void>;
  cancelTask(taskId: string, reason: string): Promise<void>;
  reassign(taskId: string): Promise<void>;
}

export interface FleetPolicy {
  readonly id: string;
  assignTask(
    task: FleetTask,
    fleet: RepoAgentRef[],
    knowledge: KnowledgeStore
  ): Promise<Assignment>;
  onContractChange(
    change: ContractChange,
    fleet: RepoAgentRef[]
  ): Promise<ReconciliationPlan>;
  onWorkerComplete(
    result: RepoAgentResult,
    supervisor: FleetSupervisorApi
  ): Promise<void>;
  onEscalation(
    reason: EscalationReason,
    supervisor: FleetSupervisorApi
  ): Promise<EscalationOutcome>;
}
