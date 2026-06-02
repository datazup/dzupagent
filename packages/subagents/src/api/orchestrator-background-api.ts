import type {
  BackgroundTask,
  SubagentSpec,
  TaskId,
} from "../contracts/background-task.js";
import type {
  SpawnOptions,
  SpawnOutcome,
} from "../runtime/background-subagent-runtime.js";
import type { BackgroundSubagentRuntime } from "../runtime/background-subagent-runtime.js";

/** A lightweight handle returned by the programmatic spawn API. */
export class TaskHandle {
  constructor(
    readonly id: TaskId,
    private readonly runtime: BackgroundSubagentRuntime
  ) {}

  async status(): Promise<BackgroundTask["status"] | null> {
    const task = await this.runtime.check(this.id);
    return task?.status ?? null;
  }

  /** Resolve when the task reaches a terminal state (or timeout). */
  async result(options?: {
    timeoutMs?: number;
  }): Promise<BackgroundTask | null> {
    return this.runtime.await(this.id, options ?? {});
  }

  async cancel(): Promise<BackgroundTask | null> {
    return this.runtime.cancel(this.id);
  }
}

/**
 * Programmatic surface over the runtime, for application/orchestration code that
 * coordinates background work directly (as opposed to the LLM-facing tools).
 */
export class OrchestratorBackgroundApi {
  constructor(private readonly runtime: BackgroundSubagentRuntime) {}

  async spawn(
    spec: SubagentSpec,
    parentRunId: string,
    options?: SpawnOptions
  ): Promise<{ outcome: SpawnOutcome; handle?: TaskHandle }> {
    const outcome = await this.runtime.spawn(spec, parentRunId, options ?? {});
    if (outcome.ok) {
      return { outcome, handle: new TaskHandle(outcome.taskId, this.runtime) };
    }
    return { outcome };
  }

  get(taskId: TaskId): Promise<BackgroundTask | null> {
    return this.runtime.check(taskId);
  }

  await(
    taskId: TaskId,
    options?: { timeoutMs?: number }
  ): Promise<BackgroundTask | null> {
    return this.runtime.await(taskId, options ?? {});
  }

  cancel(taskId: TaskId): Promise<BackgroundTask | null> {
    return this.runtime.cancel(taskId);
  }

  list(parentRunId?: string): Promise<BackgroundTask[]> {
    return this.runtime.list(parentRunId);
  }
}
