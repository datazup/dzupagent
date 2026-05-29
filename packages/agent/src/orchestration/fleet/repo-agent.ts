import { ulid } from "ulidx";
import type {
  FleetTask,
  KnowledgeEnvelope,
  RepoAgentResult,
  RepoRef,
  TaskState,
  TaskStatePayload,
  WorkerEvent,
  WorkerId,
  KnowledgeStore,
  Executor,
} from "@dzupagent/agent-types/fleet";

export interface RepoAgentDeps {
  runId: string;
  repo: RepoRef;
  executor: Executor;
  knowledge: KnowledgeStore;
  workerId?: WorkerId;
}

/**
 * RepoAgent dispatches a single {@link FleetTask} to one worker via the
 * configured {@link Executor}, draining the worker's event stream and recording
 * task-state transitions (claimed → in-progress → terminal) into the shared
 * {@link KnowledgeStore}.
 *
 * General-purpose: nothing here assumes code generation. The worker's behaviour
 * is fully delegated to the executor implementation.
 */
export class RepoAgent {
  private readonly workerId: WorkerId;

  constructor(private readonly deps: RepoAgentDeps) {
    this.workerId = deps.workerId ?? `worker-${ulid()}`;
  }

  async dispatch(task: FleetTask): Promise<RepoAgentResult> {
    await this.writeTaskState(task.id, "claimed");

    const handle = await this.deps.executor.spawn({
      workerId: this.workerId,
      repo: this.deps.repo,
      repoPath: this.deps.repo.path,
      taskBundle: task,
      knowledgeHandle: {
        store: this.deps.knowledge,
        scope: `run:${this.deps.runId}`,
        repo: this.deps.repo.name,
      },
      mailboxAddress: `${this.deps.runId}/${this.workerId}`,
      config: {},
    });

    await this.writeTaskState(task.id, "in-progress");

    const events: WorkerEvent[] = [];
    for await (const e of handle.events) events.push(e);
    const outcome = await handle.wait();

    let state: TaskState = "failed";
    if (outcome.state === "completed") state = "completed";
    else if (outcome.state === "cancelled") state = "surrendered";
    else if (outcome.state === "crashed" || outcome.state === "failed")
      state = "failed";

    await this.writeTaskState(task.id, state, outcome.reason);

    return {
      workerId: this.workerId,
      repo: this.deps.repo.name,
      taskId: task.id,
      state,
      events,
    };
  }

  private async writeTaskState(
    taskId: string,
    state: TaskState,
    blockedReason?: string
  ): Promise<void> {
    // exactOptionalPropertyTypes: only set blockedReason when actually present.
    const payload: TaskStatePayload = {
      taskId,
      state,
      claimedBy: this.workerId,
    };
    if (blockedReason !== undefined) payload.blockedReason = blockedReason;

    const env: KnowledgeEnvelope = {
      id: ulid(),
      runId: this.deps.runId,
      repo: this.deps.repo.name,
      kind: "task-state",
      key: taskId,
      version: Date.now(),
      authorWorkerId: this.workerId,
      parentId: null,
      createdAt: new Date().toISOString(),
      supersededAt: null,
      payload,
      tags: [],
    };
    await this.deps.knowledge.append(`run:${this.deps.runId}`, env);
  }
}
