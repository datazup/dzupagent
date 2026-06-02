import type { TaskId } from "./background-task.js";

/**
 * Injected checkpointer seam. The concrete checkpointer (`WorkflowCheckpointer`,
 * Postgres-backed) lives in `@dzupagent/agent-adapters` (layer 4); importing it
 * here would violate the layer DAG. Instead the runtime depends on this port and
 * agent-adapters injects an adapter that forwards to the real checkpointer.
 *
 * Shipping an in-memory default keeps the exit cost low (Taleb barbell): the port
 * can be re-implemented or swapped in a sprint.
 */
export interface CheckpointerPort {
  /** Persist a snapshot for a task; returns an opaque `checkpointRef`. */
  save(taskId: TaskId, snapshot: unknown): Promise<string>;
  /** Load a previously saved snapshot, or null if absent. */
  load(checkpointRef: string): Promise<unknown | null>;
}
