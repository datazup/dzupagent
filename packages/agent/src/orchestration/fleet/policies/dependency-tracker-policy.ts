import type {
  Assignment,
  ContractChange,
  EscalationReason,
  FleetTask,
  ReconciliationPlan,
  RepoAgentResult,
  TaskStatePayload,
  EscalationOutcome,
  FleetPolicy,
  FleetSupervisorApi,
  RepoAgentRef,
  KnowledgeStore,
} from "@dzupagent/agent-types/fleet";

interface Opts {
  runId: string;
}

/**
 * Dependency-aware fleet policy: a task is only assignable once every task in
 * its `dependsOn` list has reached the "completed" state in the shared
 * KnowledgeStore. Otherwise assignTask throws so the supervisor can re-queue.
 * Suitable for the coordinated-feature scenario where repos have an ordering.
 */
export class DependencyTrackerPolicy implements FleetPolicy {
  readonly id = "dependency-tracker";
  constructor(private readonly opts: Opts) {}

  async assignTask(
    task: FleetTask,
    fleet: RepoAgentRef[],
    knowledge: KnowledgeStore
  ): Promise<Assignment> {
    for (const dep of task.dependsOn) {
      const last = await knowledge.read(
        `run:${this.opts.runId}`,
        "task-state",
        dep
      );
      const state = (last?.payload as TaskStatePayload | undefined)?.state;
      if (state !== "completed") {
        throw new Error(
          `Task ${task.id} blocked by dependency ${dep} (state=${
            state ?? "unknown"
          }) — not completed`
        );
      }
    }
    const free = fleet.find((f) => !f.busy);
    if (!free) throw new Error(`No available worker for task ${task.id}`);
    return {
      taskId: task.id,
      workerId: free.workerId,
      rationale: "dependencies satisfied",
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
    return { kind: "retry", delayMs: 1000 };
  }
}
