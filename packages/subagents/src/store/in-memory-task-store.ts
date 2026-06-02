import type {
  BackgroundTask,
  TaskId,
  TaskStatus,
} from "../contracts/background-task.js";
import type { TaskFilter, TaskStore } from "../contracts/task-store.js";

/**
 * Default in-process {@link TaskStore}. Suitable for the in-process runner tier
 * and for tests. Stores deep-cloned copies so callers cannot mutate persisted
 * records out from under the runtime.
 */
export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<TaskId, BackgroundTask>();

  async put(task: BackgroundTask): Promise<void> {
    this.tasks.set(task.id, structuredClone(task));
  }

  async get(id: TaskId): Promise<BackgroundTask | null> {
    const found = this.tasks.get(id);
    return found ? structuredClone(found) : null;
  }

  async list(filter: TaskFilter): Promise<BackgroundTask[]> {
    const statuses = normaliseStatuses(filter.status);
    const results: BackgroundTask[] = [];
    for (const task of this.tasks.values()) {
      if (
        filter.parentRunId !== undefined &&
        task.parentRunId !== filter.parentRunId
      ) {
        continue;
      }
      if (statuses && !statuses.includes(task.status)) {
        continue;
      }
      if (filter.endedBefore !== undefined) {
        if (task.endedAt === undefined || task.endedAt >= filter.endedBefore) {
          continue;
        }
      }
      results.push(structuredClone(task));
    }
    return results;
  }

  async patch(id: TaskId, patch: Partial<BackgroundTask>): Promise<void> {
    const existing = this.tasks.get(id);
    if (!existing) {
      return;
    }
    this.tasks.set(id, { ...existing, ...structuredClone(patch) });
  }

  /** Remove a task entirely — used by GC for terminal tasks past retention. */
  async remove(id: TaskId): Promise<void> {
    this.tasks.delete(id);
  }
}

function normaliseStatuses(
  status: TaskStatus | TaskStatus[] | undefined
): TaskStatus[] | null {
  if (status === undefined) {
    return null;
  }
  return Array.isArray(status) ? status : [status];
}
