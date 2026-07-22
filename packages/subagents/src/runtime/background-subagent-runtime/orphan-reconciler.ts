import type {
  BackgroundTask,
  TaskId,
} from "../../contracts/background-task.js";
import type { Clock } from "../../contracts/clock.js";
import { SubagentErrorCode } from "../../contracts/error-codes.js";
import type { SubagentEventSink } from "../../contracts/events.js";
import type { SubagentLogger } from "../../contracts/logger.js";
import type { TaskRunner } from "../../contracts/task-runner.js";
import type { TaskStore } from "../../contracts/task-store.js";
import {
  recoverStaleRunningTasks,
  type RecoverStaleRunningTasksOptions,
} from "../../store/postgres-task-store.js";

/** Injected seams the orphan reconciliation routine reads (no `this`). */
export interface OrphanReconcilerContext {
  store: TaskStore;
  runner: TaskRunner;
  events: SubagentEventSink;
  clock: Clock;
  logger: SubagentLogger;
  staleRunningRecovery?: Pick<
    RecoverStaleRunningTasksOptions,
    "runningTimeoutMs" | "action" | "enqueue"
  >;
}

/**
 * Reconcile orphaned `running` tasks left by a crashed process. In-process
 * (non-durable) runs are marked `failed` with their `checkpointRef` preserved
 * for later resumption; durable runners may instead resume (or, when a
 * `staleRunningRecovery` policy is configured, settle stale work via the
 * store's {@link recoverStaleRunningTasks}). Extracted as a free function
 * (BackgroundSubagentRuntime.reconcileOrphans delegates here) so the crash-
 * recovery concern stays separable from the spawn/admit lifecycle loop.
 */
export async function reconcileOrphans(
  ctx: OrphanReconcilerContext,
  orphans: BackgroundTask[]
): Promise<TaskId[]> {
  const { store, runner, events, clock, logger, staleRunningRecovery } = ctx;
  const reconciled: TaskId[] = [];
  const durable = runner.capabilities().durable;
  if (durable && staleRunningRecovery !== undefined) {
    return recoverStaleRunningTasks({
      store,
      now: clock.now(),
      ...staleRunningRecovery,
    });
  }
  for (const task of orphans) {
    if (durable) {
      // Durable runner is expected to resume; leave state for it to pick up.
      continue;
    }
    await store.patch(task.id, {
      status: "failed",
      // ERR-M-06: structured code so orphan-reconciled tasks are branchable.
      errorCode: SubagentErrorCode.ORPHANED_BY_PROCESS_RESTART,
      error: "orphaned_by_process_restart",
      endedAt: clock.now(),
    });
    logger.warn({
      taskId: task.id,
      code: SubagentErrorCode.ORPHANED_BY_PROCESS_RESTART,
      reason: "orphaned_by_process_restart",
      parentRunId: task.parentRunId,
    });
    events.emit({
      type: "subagent:failed",
      taskId: task.id,
      error: "orphaned_by_process_restart",
      durationMs: 0,
    });
    reconciled.push(task.id);
  }
  return reconciled;
}
