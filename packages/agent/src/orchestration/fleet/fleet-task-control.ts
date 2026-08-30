/**
 * Task reassignment for a live fleet run.
 *
 * Cancels the current worker for a task (if live) and re-dispatches it to the
 * next idle worker chosen by the active policy. If no run is active, the task
 * is unknown, no idle worker exists, or the policy names a worker that is not
 * enrolled, the task is written as `surrendered` and the run's outcome reflects
 * the failure.
 *
 * Split out of `fleet-supervisor.ts` because the ordering here is subtle and
 * self-contained: the run context is captured BEFORE cancelling, since
 * cancelling a live handle starts the dispatch microtask chain that clears the
 * supervisor's active run before the await resumes.
 *
 * @module orchestration/fleet/fleet-task-control
 */
import type {
  FleetPolicy,
  FleetRunSpec,
  FleetSupervisorApi,
  KnowledgeStore,
  RepoAgentRef,
  WorkerHandle,
} from "@dzupagent/agent-types/fleet";
import type { RepoAgentSlot } from "./fleet-reconciliation-runner.js";
import { writeDecision, writeTaskControlState } from "./fleet-run-records.js";

/** The run a supervisor is currently driving. */
export interface ActiveRun {
  runId: string;
  spec: FleetRunSpec;
  policy: FleetPolicy;
  repoAgents: Map<string, RepoAgentSlot>;
}

/** Supervisor state reassignment needs to read and mutate. */
export interface ReassignContext {
  /** Passed back to the policy's `onWorkerComplete` callback. */
  api: FleetSupervisorApi;
  knowledge: KnowledgeStore;
  taskHandles: Map<string, WorkerHandle>;
  activeRun: ActiveRun | null;
}

export async function reassignTask(
  rt: ReassignContext,
  taskId: string
): Promise<void> {
  // Capture run context and task BEFORE cancelling — cancelling the live handle
  // triggers the dispatch microtask chain which clears _activeRun by the time
  // the await resumes.
  const ctx = rt.activeRun;
  const task = ctx?.spec.tasks.find((t) => t.id === taskId);

  const handle = rt.taskHandles.get(taskId);
  if (handle) {
    await handle.cancel("reassignment requested");
    rt.taskHandles.delete(taskId);
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
    (v) => v.ref
  );
  const idle = fleet.filter((f) => !f.busy);
  if (idle.length === 0) {
    await writeTaskControlState(
      rt.knowledge,
      ctx.runId,
      taskId,
      "surrendered",
      "no idle worker available for reassignment"
    );
    return;
  }

  const assignment = await ctx.policy.assignTask(
    task,
    idle,
    rt.knowledge
  );
  await writeDecision(
    rt.knowledge,
    ctx.runId,
    "assignment",
    ctx.policy.id,
    [taskId, assignment.workerId, "reassignment"],
    assignment.rationale
  );

  const target = [...ctx.repoAgents.values()].find(
    (v) => v.ref.workerId === assignment.workerId
  );
  if (!target) {
    await writeTaskControlState(
      rt.knowledge,
      ctx.runId,
      taskId,
      "surrendered",
      `reassignment target worker ${assignment.workerId} not found`
    );
    return;
  }

  target.ref.busy = true;
  target.agent
    .dispatch(task)
    .then(async (result) => {
      await ctx.policy.onWorkerComplete(result, rt.api);
    })
    .catch(() => {
      // Dispatch errors after reassignment are surfaced through task-state
      // written by RepoAgent; not re-thrown here since this is async.
    })
    .finally(() => {
      target.ref.busy = false;
      rt.taskHandles.delete(taskId);
    });
}
