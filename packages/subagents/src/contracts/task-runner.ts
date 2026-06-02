import type { TaskId } from "./background-task.js";

/** Declares what an execution substrate can guarantee. */
export interface RunnerCapabilities {
  /** Whether tasks survive a process restart (durable queue + external store). */
  durable: boolean;
  /** Whether tasks can be drained by multiple worker processes concurrently. */
  horizontal: boolean;
}

/**
 * The execution seam (portability barbell). A runner is responsible only for
 * *executing* an already-admitted task; admission, governance, persistence, and
 * event emission are owned by the runtime. A runner persists progress and the
 * final result through the {@link TaskStore} the runtime injects into it.
 *
 * Shipped implementations:
 * - `InProcessRunner` (default) — async worker pool in the same process.
 * - `DurableQueueRunner` (opt-in) — drains a pluggable queue.
 */
export interface TaskRunner {
  /**
   * Begin executing a task. Resolves when the task reaches a terminal state.
   * Implementations MUST honour `signal` for cooperative cancellation.
   */
  start(taskId: TaskId, signal: AbortSignal): Promise<void>;
  capabilities(): RunnerCapabilities;
}
