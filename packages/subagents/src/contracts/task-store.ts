import type { BackgroundTask, TaskId, TaskStatus } from "./background-task.js";

/** Query filter for {@link TaskStore.list}. */
export interface TaskFilter {
  parentRunId?: string;
  status?: TaskStatus | TaskStatus[];
  /** Match tasks whose `endedAt` is strictly before this epoch-ms — used by GC. */
  endedBefore?: number;
}

/**
 * The persistence seam. Orthogonal to {@link TaskRunner}: any runner can use any
 * store. Shipped: `InMemoryTaskStore`. Follow-up: Postgres-backed store wired in
 * `@dzupagent/agent-adapters`.
 *
 * `patch` performs a shallow merge over the stored record and is the only
 * mutation path the runtime uses after `put`, keeping transitions auditable.
 */
export interface TaskStore {
  put(task: BackgroundTask): Promise<void>;
  get(id: TaskId): Promise<BackgroundTask | null>;
  list(filter: TaskFilter): Promise<BackgroundTask[]>;
  patch(id: TaskId, patch: Partial<BackgroundTask>): Promise<void>;
  /**
   * Optional optimistic update hook for durable stores. Returns false when the
   * stored record no longer has the expected version.
   */
  patchIfVersion?(
    id: TaskId,
    expectedVersion: number,
    patch: Partial<BackgroundTask>,
  ): Promise<boolean>;
  /**
   * Optional compare-and-set transition hook. Returns false when the task is
   * missing or no longer has the expected status.
   */
  patchIfStatus?(
    id: TaskId,
    expectedStatus: TaskStatus,
    patch: Partial<BackgroundTask>,
  ): Promise<boolean>;
}
