import type { TaskId } from "../contracts/background-task.js";
import { SubagentErrorCode } from "../contracts/error-codes.js";
import type { SubagentLogger } from "../contracts/logger.js";
import { defaultSubagentLogger } from "../contracts/logger.js";
import type {
  TaskRunner,
  RunnerCapabilities,
} from "../contracts/task-runner.js";
import {
  InProcessRunner,
  type InProcessRunnerDeps,
} from "./in-process-runner.js";

/**
 * Pluggable queue seam. A host supplies a durable queue (BullMQ, Redis, Postgres
 * `SELECT … FOR UPDATE SKIP LOCKED`, …). The default {@link InMemoryTaskQueue}
 * makes the runner usable and testable without external infrastructure.
 */
export interface TaskQueue {
  enqueue(taskId: TaskId): Promise<void>;
  /** Register a worker that drains the queue; returns a stop function. */
  consume(handler: (taskId: TaskId) => Promise<void>): () => void;
}

/** Default in-memory queue — FIFO, single process. Not durable. */
export class InMemoryTaskQueue implements TaskQueue {
  private readonly pending: TaskId[] = [];
  private handler: ((taskId: TaskId) => Promise<void>) | undefined;
  private draining = false;
  private readonly logger: SubagentLogger;

  constructor(logger: SubagentLogger = defaultSubagentLogger) {
    this.logger = logger;
  }

  async enqueue(taskId: TaskId): Promise<void> {
    this.pending.push(taskId);
    void this.drain();
  }

  consume(handler: (taskId: TaskId) => Promise<void>): () => void {
    this.handler = handler;
    void this.drain();
    return () => {
      this.handler = undefined;
    };
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.handler) {
      return;
    }
    this.draining = true;
    try {
      while (this.pending.length > 0 && this.handler) {
        const next = this.pending.shift();
        if (next === undefined) {
          break;
        }
        // Survive a poisoned handler: a throw here must not reject the void
        // drain loop, or every subsequent queued task would silently stall.
        // Log and continue to the next task.
        try {
          await this.handler(next);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.error({
            taskId: next,
            code: SubagentErrorCode.TASK_EXECUTION_FAILED,
            message,
            detail: "queue_handler_threw",
          });
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

export interface DurableQueueRunnerDeps extends InProcessRunnerDeps {
  queue: TaskQueue;
  /**
   * Whether the backing queue + store actually survive process restart. Set true
   * only when wired to a durable queue and an external store; controls the
   * reconciler's resume-vs-fail decision.
   */
  durable?: boolean;
  horizontal?: boolean;
}

/**
 * Opt-in execution substrate that drains a pluggable queue. Execution semantics
 * (status transitions, events, cancellation) are shared with
 * {@link InProcessRunner}; this runner only adds the enqueue/consume indirection
 * so work can be distributed and survive restarts when backed durably.
 */
export class DurableQueueRunner implements TaskRunner {
  private readonly inner: InProcessRunner;
  private readonly queue: TaskQueue;
  private readonly durable: boolean;
  private readonly horizontal: boolean;
  private readonly logger: SubagentLogger;
  private readonly signals = new Map<TaskId, AbortController>();
  private stopConsumer: (() => void) | undefined;

  constructor(private readonly deps: DurableQueueRunnerDeps) {
    this.inner = new InProcessRunner(deps);
    this.queue = deps.queue;
    this.durable = deps.durable ?? false;
    this.horizontal = deps.horizontal ?? false;
    this.logger = deps.logger ?? defaultSubagentLogger;
    this.stopConsumer = this.queue.consume((taskId) => this.execute(taskId));
  }

  capabilities(): RunnerCapabilities {
    return { durable: this.durable, horizontal: this.horizontal };
  }

  /** Enqueue rather than execute inline; the consumer drives execution. */
  async start(taskId: TaskId, signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    this.signals.set(taskId, controller);
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
    await this.queue.enqueue(taskId);
  }

  private async execute(taskId: TaskId): Promise<void> {
    const controller = this.signals.get(taskId) ?? new AbortController();
    try {
      await this.inner.start(taskId, controller.signal);
    } catch (error) {
      // Defense-in-depth: `inner.start` already settles + logs executor throws,
      // but a custom queue that does NOT guard its drain loop would have this
      // promise reject and stall the loop. Swallow + log so the consumer
      // survives a poisoned task regardless of the queue implementation.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({
        taskId,
        code: SubagentErrorCode.TASK_EXECUTION_FAILED,
        message,
        detail: "queue_execute_threw",
      });
    } finally {
      this.signals.delete(taskId);
    }
  }

  dispose(): void {
    this.stopConsumer?.();
    this.stopConsumer = undefined;
  }
}
