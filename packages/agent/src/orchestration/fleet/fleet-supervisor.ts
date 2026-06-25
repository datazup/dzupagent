import { ulid } from "ulidx";
import type {
  FleetRunResult,
  FleetRunSpec,
  FleetTask,
  KnowledgeEnvelope,
  RepoAgentResult,
  RepoRef,
  Executor,
  KnowledgeStore,
  FleetPolicy,
  FleetSupervisorApi,
  RepoAgentRef,
  TaskState,
  TaskStatePayload,
  WorkerHandle,
  WorkerSpec,
} from "@dzupagent/agent-types/fleet";
import { RepoAgent } from "./repo-agent.js";

export interface FleetSupervisorDeps {
  knowledge: KnowledgeStore;
  executorFor: (repo: RepoRef) => Executor;
}

type DecisionKind =
  | "assignment"
  | "reconciliation"
  | "escalation"
  | "budget-exhausted";

interface RepoAgentSlot {
  agent: RepoAgent;
  repo: RepoRef;
  ref: RepoAgentRef;
}

interface ActiveRun {
  runId: string;
  spec: FleetRunSpec;
  policy: FleetPolicy;
  repoAgents: Map<string, RepoAgentSlot>;
}

/**
 * FleetSupervisor drives a FleetRunSpec to completion. For fan-out scenarios
 * every repo runs the task in parallel; otherwise the injected FleetPolicy
 * assigns each task to a single worker. Assignment decisions are mirrored into
 * the shared KnowledgeStore.
 *
 * Phase 1b: mid-run control (pauseTask/cancelTask/reassign) operates on live
 * worker handles registered during spawn. Pause signals the worker; cancel
 * terminates it and writes a surrendered task-state; reassign cancels and
 * re-dispatches to the next available idle worker via the active policy.
 */
export class FleetSupervisor implements FleetSupervisorApi {
  /** Live worker handles keyed by taskId, populated during run(). */
  private readonly _taskHandles = new Map<string, WorkerHandle>();
  /** Active run context, set at the start of run() and cleared when done. */
  private _activeRun: ActiveRun | null = null;

  constructor(private readonly deps: FleetSupervisorDeps) {}

  async run(spec: FleetRunSpec, policy: FleetPolicy): Promise<FleetRunResult> {
    await this.seed(spec);

    const repoAgents = new Map<string, RepoAgentSlot>();
    for (const repo of spec.repos) {
      const ref: RepoAgentRef = {
        workerId: `w-${ulid()}`,
        repo: repo.name,
        busy: false,
      };
      const trackingExecutor = this.trackingExecutorFor(repo, spec);
      const agent = new RepoAgent({
        runId: spec.runId,
        repo,
        executor: trackingExecutor,
        knowledge: this.deps.knowledge,
        workerId: ref.workerId,
      });
      repoAgents.set(repo.name, { agent, repo, ref });
    }

    this._activeRun = { runId: spec.runId, spec, policy, repoAgents };

    try {
      const outcomes: RepoAgentResult[] = [];
      const isFanOut =
        spec.scenario === "audit-fanout" || policy.id === "fan-out";

      if (isFanOut) {
        for (const task of spec.tasks) {
          const runs = [...repoAgents.values()].map(async ({ agent, ref }) => {
            ref.busy = true;
            try {
              const result = await agent.dispatch(task);
              outcomes.push(result);
              return result;
            } finally {
              ref.busy = false;
              this._taskHandles.delete(task.id);
            }
          });
          await Promise.all(runs);
        }
      } else {
        for (const task of spec.tasks) {
          const fleet: RepoAgentRef[] = [...repoAgents.values()].map(
            (v) => v.ref,
          );
          const assignment = await policy.assignTask(
            task,
            fleet,
            this.deps.knowledge,
          );
          const target = [...repoAgents.values()].find(
            (v) => v.ref.workerId === assignment.workerId,
          );
          if (!target) {
            throw new Error(
              `Policy assigned unknown worker ${assignment.workerId}`,
            );
          }
          await this.writeDecision(
            spec.runId,
            "assignment",
            policy.id,
            [task.id, assignment.workerId],
            assignment.rationale,
          );
          target.ref.busy = true;
          try {
            const result = await target.agent.dispatch(task);
            outcomes.push(result);
            await policy.onWorkerComplete(result, this);
          } finally {
            target.ref.busy = false;
            this._taskHandles.delete(task.id);
          }
        }
      }

      const allOk = outcomes.every((o) => o.state === "completed");
      return {
        runId: spec.runId,
        status: allOk ? "completed" : "failed",
        finishedAt: new Date().toISOString(),
        taskOutcomes: outcomes,
      };
    } finally {
      this._activeRun = null;
    }
  }

  /**
   * Signals a live worker to pause. Writes a `blocked` task-state into the
   * knowledge store and sends a pause message to the worker handle. The worker
   * itself decides whether to honour the pause — the supervisor does not
   * forcibly halt execution.
   */
  async pauseTask(taskId: string, reason: string): Promise<void> {
    const handle = this._taskHandles.get(taskId);
    const runId = this._activeRun?.runId ?? "unknown";
    await this.writeTaskControlState(runId, taskId, "blocked", reason);
    if (handle) {
      await handle.send({ kind: "message", text: `pause: ${reason}` });
    }
  }

  /**
   * Cancels a live worker and marks the task surrendered. Calls
   * `WorkerHandle.cancel(reason)` if a live handle exists, then writes a
   * `surrendered` task-state. The task will not be retried automatically.
   */
  async cancelTask(taskId: string, reason: string): Promise<void> {
    const handle = this._taskHandles.get(taskId);
    if (handle) {
      await handle.cancel(reason);
      this._taskHandles.delete(taskId);
    }
    const runId = this._activeRun?.runId ?? "unknown";
    await this.writeTaskControlState(runId, taskId, "surrendered", reason);
  }

  /**
   * Cancels the current worker for a task (if live) and re-dispatches it to
   * the next available idle worker chosen by the active policy. If no run is
   * active or no idle worker is available the task is cancelled and written as
   * surrendered — the run's outcome will reflect the failure.
   */
  async reassign(taskId: string): Promise<void> {
    // Capture run context and task BEFORE cancelling — cancelling the live handle
    // triggers the dispatch microtask chain which clears _activeRun by the time
    // the await resumes.
    const ctx = this._activeRun;
    const task = ctx?.spec.tasks.find((t) => t.id === taskId);

    const handle = this._taskHandles.get(taskId);
    if (handle) {
      await handle.cancel("reassignment requested");
      this._taskHandles.delete(taskId);
      // Yield the microtask queue so the run loop's dispatch chain (generator
      // drain → wait() → finally { busy=false }) can complete before we
      // inspect the idle fleet for reassignment.
      await Promise.resolve();
    }

    if (!ctx) {
      return;
    }

    if (!task) {
      return;
    }

    const fleet: RepoAgentRef[] = [...ctx.repoAgents.values()].map(
      (v) => v.ref,
    );
    const idle = fleet.filter((f) => !f.busy);
    if (idle.length === 0) {
      await this.writeTaskControlState(
        ctx.runId,
        taskId,
        "surrendered",
        "no idle worker available for reassignment",
      );
      return;
    }

    const assignment = await ctx.policy.assignTask(
      task,
      idle,
      this.deps.knowledge,
    );
    await this.writeDecision(
      ctx.runId,
      "assignment",
      ctx.policy.id,
      [taskId, assignment.workerId, "reassignment"],
      assignment.rationale,
    );

    const target = [...ctx.repoAgents.values()].find(
      (v) => v.ref.workerId === assignment.workerId,
    );
    if (!target) {
      await this.writeTaskControlState(
        ctx.runId,
        taskId,
        "surrendered",
        `reassignment target worker ${assignment.workerId} not found`,
      );
      return;
    }

    target.ref.busy = true;
    target.agent
      .dispatch(task)
      .then(async (result) => {
        await ctx.policy.onWorkerComplete(result, this);
      })
      .catch(() => {
        // Dispatch errors after reassignment are surfaced through task-state
        // written by RepoAgent; not re-thrown here since this is async.
      })
      .finally(() => {
        target.ref.busy = false;
        this._taskHandles.delete(taskId);
      });
  }

  /**
   * Returns a handle-tracking wrapper around the real executor for a given
   * repo. When the underlying executor spawns a worker, the handle is
   * registered under the task's id so control methods can reach it.
   */
  private trackingExecutorFor(repo: RepoRef, spec: FleetRunSpec): Executor {
    const supervisor = this;
    const inner = this.deps.executorFor(repo);
    return {
      id: inner.id,
      async spawn(workerSpec: WorkerSpec): Promise<WorkerHandle> {
        const handle = await inner.spawn(workerSpec);
        supervisor._taskHandles.set(workerSpec.taskBundle.id, handle);
        return handle;
      },
    };
  }

  private async seed(spec: FleetRunSpec): Promise<void> {
    for (const entry of spec.seedKnowledge ?? []) {
      await this.deps.knowledge.append(`run:${spec.runId}`, entry);
    }
  }

  private async writeTaskControlState(
    runId: string,
    taskId: string,
    state: TaskState,
    blockedReason: string,
  ): Promise<void> {
    const payload: TaskStatePayload = { taskId, state, blockedReason };
    const env: KnowledgeEnvelope = {
      id: ulid(),
      runId,
      repo: null,
      kind: "task-state",
      key: taskId,
      version:
        Date.now() * 1000 +
        (Math.abs(taskId.charCodeAt(taskId.length - 1)) % 1000),
      authorWorkerId: null,
      parentId: null,
      createdAt: new Date().toISOString(),
      supersededAt: null,
      payload,
      tags: ["control"],
    };
    await this.deps.knowledge.append(`run:${runId}`, env);
  }

  private async writeDecision(
    runId: string,
    decisionKind: DecisionKind,
    policyId: string,
    inputs: unknown[],
    outcome: unknown,
  ): Promise<void> {
    const env: KnowledgeEnvelope = {
      id: ulid(),
      runId,
      repo: null,
      kind: "decision",
      key: `${decisionKind}-${ulid()}`,
      version: 1,
      authorWorkerId: null,
      parentId: null,
      createdAt: new Date().toISOString(),
      supersededAt: null,
      payload: { decisionKind, inputs, outcome, policyId },
      tags: [],
    };
    await this.deps.knowledge.append(`run:${runId}`, env);
  }
}
