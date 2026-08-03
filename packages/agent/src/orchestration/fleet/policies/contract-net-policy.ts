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
import {
  DEFAULT_ORCHESTRATION_FANOUT,
  runAllConcurrently,
} from "../../concurrency-runner.js";

type Bid = number | null;

export interface ContractNetPolicyOptions {
  bidder: (worker: RepoAgentRef, task: FleetTask) => Promise<Bid>;
  /**
   * ORCH-DSL-L1-H-07 — cap on simultaneous `bidder` invocations
   * (default: `DEFAULT_ORCHESTRATION_FANOUT`, 5).
   */
  maxConcurrency?: number;
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
    // ORCH-DSL-L1-H-07 — bounded fan-out. `bidder` is injected and is a model
    // call in the LLM-backed wiring, so N idle workers previously meant N
    // simultaneous inferences. Order is irrelevant here (the result is sorted
    // by bid), but `runAllConcurrently` keeps the previous fail-fast semantics.
    const bids = await runAllConcurrently(
      candidates.map((w) => async () => ({
        w,
        bid: await this.opts.bidder(w, task),
      })),
      this.opts.maxConcurrency ?? DEFAULT_ORCHESTRATION_FANOUT
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
