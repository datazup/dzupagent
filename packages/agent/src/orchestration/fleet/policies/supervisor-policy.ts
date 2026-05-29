import type {
  Assignment,
  ContractChange,
  ContractPayload,
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
 * Phase-1 supervisor policy: round-robins assignment across idle workers and
 * reconciles competing contract proposals. A single proposal (or several that
 * agree on `after`) is ratified; genuinely divergent proposals escalate to a
 * human. Full DelegatingSupervisor integration is deferred to Phase 2 (its
 * worker shape differs from RepoAgentRef).
 */
export class SupervisorPolicy implements FleetPolicy {
  readonly id = "supervisor";
  private nextIndex = 0;

  async assignTask(
    task: FleetTask,
    fleet: RepoAgentRef[],
    _knowledge: KnowledgeStore
  ): Promise<Assignment> {
    const free = fleet.filter((f) => !f.busy);
    const pick = free[this.nextIndex % free.length];
    if (!pick) throw new Error(`No available worker for task ${task.id}`);
    this.nextIndex += 1;
    return {
      taskId: task.id,
      workerId: pick.workerId,
      rationale: "round-robin supervisor assignment",
    };
  }

  async onContractChange(
    change: ContractChange,
    _fleet: RepoAgentRef[]
  ): Promise<ReconciliationPlan> {
    const noChange: ReconciliationPlan = {
      ratified: null,
      rejectIds: [],
      pauseTasks: [],
      escalate: false,
    };

    const first = change.proposals[0];
    if (!first) return noChange;

    const canonical = JSON.stringify(first.after);
    const allEqual = change.proposals.every(
      (p) => JSON.stringify(p.after) === canonical
    );
    if (allEqual) {
      const ratified: ContractPayload = { ...first, status: "ratified" };
      return { ratified, rejectIds: [], pauseTasks: [], escalate: false };
    }
    return { ratified: null, rejectIds: [], pauseTasks: [], escalate: true };
  }

  async onWorkerComplete(
    _result: RepoAgentResult,
    _supervisor: FleetSupervisorApi
  ): Promise<void> {}

  async onEscalation(
    reason: EscalationReason,
    _supervisor: FleetSupervisorApi
  ): Promise<EscalationOutcome> {
    return {
      kind: "human-handoff",
      note: `SupervisorPolicy escalation: ${reason}`,
    };
  }
}
