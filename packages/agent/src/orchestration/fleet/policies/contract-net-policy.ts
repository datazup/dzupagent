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

type Bid = number | null;

export interface ContractNetPolicyOptions {
  bidder: (worker: RepoAgentRef, task: FleetTask) => Promise<Bid>;
}

/**
 * Phase-1a contract-net policy: runs a synchronous, in-policy bid loop. Each
 * idle worker bids on the task via the injected `bidder`; the highest valid bid
 * wins, and an all-null result escalates. Full ContractNetManager integration
 * is deferred to Phase 1b/2 (its worker shape differs from RepoAgentRef).
 */
export class ContractNetPolicy implements FleetPolicy {
  readonly id = "contract-net";
  constructor(private readonly opts: ContractNetPolicyOptions) {}

  async assignTask(
    task: FleetTask,
    fleet: RepoAgentRef[],
    _knowledge: KnowledgeStore
  ): Promise<Assignment> {
    const candidates = fleet.filter((f) => !f.busy);
    const bids = await Promise.all(
      candidates.map(async (w) => ({
        w,
        bid: await this.opts.bidder(w, task),
      }))
    );
    const valid = bids.filter(
      (b): b is { w: RepoAgentRef; bid: number } => b.bid !== null
    );
    valid.sort((a, b) => b.bid - a.bid);
    const winner = valid[0];
    if (!winner) throw new Error(`No bidder for task ${task.id}`);
    return {
      taskId: task.id,
      workerId: winner.w.workerId,
      rationale: `winning bid ${winner.bid}`,
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
    return { kind: "human-handoff", note: "no bidder" };
  }
}
