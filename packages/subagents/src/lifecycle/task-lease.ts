import type { BackgroundTask, TaskId } from "../contracts/background-task.js";
import type { Clock } from "../contracts/clock.js";
import type { SubagentLogger } from "../contracts/logger.js";
import type { TaskStore } from "../contracts/task-store.js";

/**
 * Execution-lease primitives for background tasks (AGENT-C-08).
 *
 * A task row carries `ownerId` + `leaseUntil` + `leaseEpoch`. The worker that
 * moves a task into `running` claims the lease; while the task actually runs it
 * heartbeats, pushing `leaseUntil` forward. Reclamation paths (orphan
 * reconciliation, stale-running recovery) must treat a task with a live lease
 * as owned by a live worker and leave it alone — otherwise a second worker
 * booted against the same shared store reaps the first worker's in-flight
 * tasks and both end up executing the same work (split brain).
 *
 * Mirrors the queue-level lease that `PostgresTaskQueue` already implements for
 * queue rows; this brings the same discipline to the *task* row so the
 * mechanism works for any {@link TaskStore}, not just the Postgres queue.
 */

/** Default lease window: a task is considered abandoned this long after its last heartbeat. */
export const DEFAULT_TASK_LEASE_MS = 30_000;

/** The lease fields written on a claim. */
export interface TaskLeaseClaim {
  ownerId: string;
  leaseUntil: number;
  leaseEpoch: number;
}

/** Build the lease patch a worker writes when it claims a task for execution. */
export function nextLeaseClaim(
  task: Pick<BackgroundTask, "leaseEpoch">,
  ownerId: string,
  now: number,
  leaseMs: number = DEFAULT_TASK_LEASE_MS
): TaskLeaseClaim {
  return {
    ownerId,
    leaseUntil: now + Math.max(1, leaseMs),
    leaseEpoch: (task.leaseEpoch ?? 0) + 1,
  };
}

/**
 * Whether a task's lease is still valid at `now` — i.e. some worker asserts
 * live ownership of it. Tasks that were never claimed under a lease
 * (`leaseUntil === undefined`) are NOT live: they carry no ownership claim.
 */
export function isLeaseLive(
  task: Pick<BackgroundTask, "leaseUntil">,
  now: number
): boolean {
  return task.leaseUntil !== undefined && task.leaseUntil > now;
}

/**
 * Extend the lease on a task this worker still owns. Refuses to renew when the
 * task is no longer `running`, when ownership moved to another worker, or when
 * the fencing token advanced (the lease was lost and re-claimed) — a lost lease
 * must never be "renewed" back, which is the same rule
 * `PostgresTaskQueue.renewLease` enforces in SQL via `leased_by = workerId`.
 */
export async function renewTaskLease(options: {
  store: TaskStore;
  taskId: TaskId;
  ownerId: string;
  leaseEpoch: number;
  now: number;
  leaseMs?: number;
}): Promise<boolean> {
  const { store, taskId, ownerId, leaseEpoch, now } = options;
  const leaseMs = Math.max(1, options.leaseMs ?? DEFAULT_TASK_LEASE_MS);
  const current = await store.get(taskId);
  if (
    !current ||
    current.status !== "running" ||
    current.ownerId !== ownerId ||
    (current.leaseEpoch ?? 0) !== leaseEpoch
  ) {
    return false;
  }
  const patch = { leaseUntil: now + leaseMs };
  if (store.patchIfStatus) {
    return store.patchIfStatus(taskId, "running", patch);
  }
  await store.patch(taskId, patch);
  return true;
}

export interface TaskLeaseHeartbeatOptions {
  store: TaskStore;
  taskId: TaskId;
  ownerId: string;
  leaseEpoch: number;
  clock: Clock;
  leaseMs?: number;
  logger?: SubagentLogger;
}

/**
 * Renew a task's lease on an interval while it runs. Returns a stop function;
 * the caller MUST call it in a `finally` so the lease lapses promptly once the
 * run settles. The timer is unref'd and re-entrancy-guarded, so it never holds
 * the process open and never stacks overlapping renewals.
 */
export function startTaskLeaseHeartbeat(
  options: TaskLeaseHeartbeatOptions
): () => void {
  const leaseMs = Math.max(1, options.leaseMs ?? DEFAULT_TASK_LEASE_MS);
  const intervalMs = Math.max(1, Math.floor(leaseMs / 3));
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void renewTaskLease({
      store: options.store,
      taskId: options.taskId,
      ownerId: options.ownerId,
      leaseEpoch: options.leaseEpoch,
      now: options.clock.now(),
      leaseMs,
    })
      .catch((error: unknown) => {
        options.logger?.warn({
          taskId: options.taskId,
          code: "TASK_LEASE_RENEW_FAILED",
          ownerId: options.ownerId,
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      })
      .finally(() => {
        renewing = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
  };
}
