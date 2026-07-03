import type { TaskId } from "../contracts/background-task.js";
import { isTerminalStatus } from "../contracts/background-task.js";
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
    await store.patch(taskId, { status: "running", startedAt });

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
      if (await this.alreadyTerminal(taskId)) {
        return;
      }
      await store.patch(taskId, { status: "succeeded", result, endedAt });
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
      if (await this.alreadyTerminal(taskId)) {
        return;
      }
      await store.patch(taskId, { status: "failed", error: message, endedAt });
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

  /**
   * Guard against overwriting a task that reached a terminal state out-of-band
   * (e.g. TTL expiry aborted it while the executor was still resolving). The
   * out-of-band transition is authoritative.
   */
  private async alreadyTerminal(taskId: TaskId): Promise<boolean> {
    const current = await this.deps.store.get(taskId);
    return current ? isTerminalStatus(current.status) : true;
  }

  private async settleCancelled(taskId: TaskId): Promise<void> {
    if (await this.alreadyTerminal(taskId)) {
      return;
    }
    const endedAt = this.deps.clock.now();
    await this.deps.store.patch(taskId, { status: "cancelled", endedAt });
    this.deps.events.emit({ type: "subagent:cancelled", taskId });
  }
}
