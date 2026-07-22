import type {
  BackgroundTask,
  TaskId,
} from "../../contracts/background-task.js";
import type { TaskStore } from "../../contracts/task-store.js";
import type { SubagentLogger } from "../../contracts/logger.js";

export interface RecoverStaleRunningTasksOptions {
  store: TaskStore;
  now: number;
  runningTimeoutMs: number;
  action?: "fail" | "requeue";
  enqueue?: (taskId: TaskId) => Promise<void>;
  logger?: SubagentLogger;
}

export async function recoverStaleRunningTasks(
  options: RecoverStaleRunningTasksOptions
): Promise<TaskId[]> {
  const action = options.action ?? "fail";
  const cutoff = options.now - options.runningTimeoutMs;
  const running = await options.store.list({ status: "running" });
  const recovered: TaskId[] = [];
  for (const task of running) {
    if (task.startedAt === undefined || task.startedAt > cutoff) continue;
    const patch: Partial<BackgroundTask> =
      action === "requeue"
        ? {
            status: "queued",
            startedAt: undefined,
            error: "stale_running_task_recovered",
          }
        : {
            status: "failed",
            error: "stale_running_task_recovered",
            endedAt: options.now,
          };
    const applied = options.store.patchIfStatus
      ? await options.store.patchIfStatus(task.id, "running", patch)
      : await patchIfStillRunning(options.store, task.id, patch);
    if (!applied) continue;
    if (action === "requeue") {
      await options.enqueue?.(task.id);
    }
    options.logger?.info({
      taskId: task.id,
      code: "STALE_RUNNING_TASK_RECOVERED",
      action,
      runningTimeoutMs: options.runningTimeoutMs,
    });
    recovered.push(task.id);
  }
  return recovered;
}

async function patchIfStillRunning(
  store: TaskStore,
  id: TaskId,
  patch: Partial<BackgroundTask>
): Promise<boolean> {
  const current = await store.get(id);
  if (!current || current.status !== "running") return false;
  await store.patch(id, patch);
  return true;
}
