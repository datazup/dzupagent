import { ulid } from "ulidx";
import { KnowledgeCollisionError } from "@dzupagent/agent-types/fleet";
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
  private taskStateVersionOffset = 0;

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
      version: this.nextTaskStateVersion(),
      authorWorkerId: this.workerId,
      parentId: null,
      createdAt: new Date().toISOString(),
      supersededAt: null,
      payload,
      tags: [],
    };
    await this.appendTaskStateWithCollisionRetry(env);
  }

  private nextTaskStateVersion(): number {
    const suffix =
      Math.abs(this.workerId.charCodeAt(this.workerId.length - 1)) % 1000;
    const offset = this.taskStateVersionOffset;
    this.taskStateVersionOffset = (this.taskStateVersionOffset + 1) % 1000;
    return Date.now() * 1000 + ((suffix + offset) % 1000);
  }

  private async appendTaskStateWithCollisionRetry(
    env: KnowledgeEnvelope
  ): Promise<void> {
    const scope = `run:${this.deps.runId}`;
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      try {
        await this.deps.knowledge.append(scope, env);
        return;
      } catch (error) {
        if (!(error instanceof KnowledgeCollisionError) || attempt === 999) {
          throw error;
        }
        env.version += 1;
      }
    }
  }
}
