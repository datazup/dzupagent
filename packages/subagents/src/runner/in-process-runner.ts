import type { TaskId, TaskStatus } from "../contracts/background-task.js";
import type { Clock } from "../contracts/clock.js";
import type { SubagentEventSink } from "../contracts/events.js";
import type { CheckpointerPort } from "../contracts/checkpointer-port.js";
import {
  SubagentErrorCode,
  isRecoverableError,
} from "../contracts/error-codes.js";
import type { SubagentLogger } from "../contracts/logger.js";
import { defaultSubagentLogger } from "../contracts/logger.js";
import type { SubagentExecutorPort } from "../contracts/subagent-executor-port.js";
import type {
  TaskRunner,
  RunnerCapabilities,
} from "../contracts/task-runner.js";
import type { TaskStore } from "../contracts/task-store.js";

export interface InProcessRunnerDeps {
  store: TaskStore;
  executor: SubagentExecutorPort;
  events: SubagentEventSink;
  clock: Clock;
  checkpointer?: CheckpointerPort;
  /** Structured logger seam; defaults to a JSON-to-stderr logger when absent. */
  logger?: SubagentLogger;
}

/**
 * Default execution substrate: runs admitted tasks as async work in the current
 * process. Not durable across process death — orphans are reconciled at startup
 * by the runtime. Honours `AbortSignal` for cancellation and TTL-driven aborts.
 *
 * Concurrency-slot accounting is owned by the runtime (which releases the slot in
 * the run `.finally`), not by the runner.
 */
export class InProcessRunner implements TaskRunner {
  constructor(private readonly deps: InProcessRunnerDeps) {}

  capabilities(): RunnerCapabilities {
    return { durable: false, horizontal: false };
  }

  private get logger(): SubagentLogger {
    return this.deps.logger ?? defaultSubagentLogger;
  }

  async start(taskId: TaskId, signal: AbortSignal): Promise<void> {
    const { store, executor, events, clock, checkpointer } = this.deps;
    const task = await store.get(taskId);
    if (!task) {
      return;
    }

    const startedAt = clock.now();
    // The runtime hands us a freshly-read task; for the initial transition we
    // already know its current status. Durable stores get a compare-and-set so
    // a racing worker cannot double-start; the in-memory tier (no CAS) patches
    // directly, matching the runtime's single-owner admission.
    if (store.patchIfStatus) {
      const started = await store.patchIfStatus(taskId, task.status, {
        status: "running",
        startedAt,
      });
      if (!started) {
        return;
      }
    } else {
      await store.patch(taskId, { status: "running", startedAt });
    }

    try {
      const result = await executor.run(task.spec, {
        taskId,
        signal,
        checkpointer,
        depth: task.depth,
        onProgress: (note) =>
          events.emit({ type: "subagent:progress", taskId, note }),
      });

      if (signal.aborted) {
        await this.settleCancelled(taskId);
        return;
      }

      const endedAt = clock.now();
      const settled = await this.patchIfCurrentStatus(taskId, "running", {
        status: "succeeded",
        result,
        endedAt,
      });
      if (!settled) {
        return;
      }
      events.emit({
        type: "subagent:completed",
        taskId,
        durationMs: endedAt - startedAt,
      });
    } catch (error) {
      if (signal.aborted) {
        await this.settleCancelled(taskId);
        return;
      }
      const endedAt = clock.now();
      const message = error instanceof Error ? error.message : String(error);
      const recoverable = isRecoverableError(error);
      const settled = await this.patchIfCurrentStatus(taskId, "running", {
        status: "failed",
        error: message,
        endedAt,
      });
      if (!settled) {
        return;
      }
      this.logger.error({
        taskId,
        code: SubagentErrorCode.TASK_EXECUTION_FAILED,
        message,
        recoverable,
      });
      events.emit({
        type: "subagent:failed",
        taskId,
        error: message,
        durationMs: endedAt - startedAt,
      });
    }
  }

  private async settleCancelled(taskId: TaskId): Promise<void> {
    const endedAt = this.deps.clock.now();
    const settled = await this.patchIfCurrentStatus(taskId, "running", {
      status: "cancelled",
      endedAt,
    });
    if (!settled) {
      return;
    }
    this.deps.events.emit({ type: "subagent:cancelled", taskId });
  }

  private async patchIfCurrentStatus(
    taskId: TaskId,
    expectedStatus: TaskStatus,
    patch: Parameters<TaskStore["patch"]>[1],
  ): Promise<boolean> {
    if (this.deps.store.patchIfStatus) {
      return this.deps.store.patchIfStatus(taskId, expectedStatus, patch);
    }
    const current = await this.deps.store.get(taskId);
    if (!current || current.status !== expectedStatus) {
      return false;
    }
    await this.deps.store.patch(taskId, patch);
    return true;
  }
}
