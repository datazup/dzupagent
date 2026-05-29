import type {
  Assignment,
  ContractChange,
  EscalationReason,
  FleetTask,
  ReconciliationPlan,
  RepoAgentResult,
  EscalationOutcome,
  FleetPolicy,
  FleetSupervisorApi,
  RepoAgentRef,
  KnowledgeStore,
} from "@dzupagent/agent-types/fleet";

/**
 * Simplest fleet policy: assigns each task to the first idle worker and treats
 * contract changes / completions as no-ops. Suitable for the
 * independent-tasks and audit-fanout scenarios where repos do not coordinate.
 */
export class FanOutPolicy implements FleetPolicy {
  readonly id = "fan-out";

  async assignTask(
    task: FleetTask,
    fleet: RepoAgentRef[],
    _knowledge: KnowledgeStore
  ): Promise<Assignment> {
    const free = fleet.find((f) => !f.busy);
    if (!free) throw new Error(`No available worker for task ${task.id}`);
    return {
      taskId: task.id,
      workerId: free.workerId,
      rationale: "first non-busy worker",
    };
  }

  async onContractChange(
    _change: ContractChange,
    _fleet: RepoAgentRef[]
  ): Promise<ReconciliationPlan> {
    return { ratified: null, rejectIds: [], pauseTasks: [], escalate: false };
  }

  async onWorkerComplete(
    _result: RepoAgentResult,
    _supervisor: FleetSupervisorApi
  ): Promise<void> {}

  async onEscalation(
    _reason: EscalationReason,
    _supervisor: FleetSupervisorApi
  ): Promise<EscalationOutcome> {
    return { kind: "human-handoff", note: "FanOutPolicy escalation" };
  }
}
