import type { BackgroundTask, TaskId } from "../contracts/background-task.js";
import { isTerminalStatus } from "../contracts/background-task.js";
import type { Clock } from "../contracts/clock.js";
import { SubagentErrorCode } from "../contracts/error-codes.js";
import type { SubagentEventSink } from "../contracts/events.js";
import type { SubagentLogger } from "../contracts/logger.js";
import { defaultSubagentLogger } from "../contracts/logger.js";
import type { TaskStore } from "../contracts/task-store.js";
import type { LifecyclePolicy } from "../runtime/runtime-config.js";
import { isLeaseLive } from "./task-lease.js";

/** Outcome of an admission request. */
export type AdmissionDecision =
  | { admitted: true }
  | { admitted: false; reason: "concurrency_full" | "queue_full" };

/**
 * Ownership/lease inputs for orphan detection (AGENT-C-08). Optional so the
 * single-process wiring keeps working unchanged; a horizontally-scaled host
 * supplies at least an `ownerId`.
 */
export interface LifecycleOwnershipOptions {
  /** This worker's identity — the value its runner writes to `task.ownerId`. */
  ownerId?: string;
  /**
   * Grace period applied to `running` tasks that carry NO lease at all (no
   * `ownerId` and no `leaseUntil`) — rows written by a pre-lease runner or a
   * foreign writer. When undefined such rows are reclaimable immediately,
   * preserving the historical single-process behaviour. Set it (e.g. to the
   * lease window) when a legacy writer may still be adding unowned rows.
   */
  orphanGraceMs?: number;
  /**
   * Whether the task is executing in THIS process right now. Belt-and-braces
   * against clock skew or a stalled heartbeat: a locally-live run is never an
   * orphan regardless of what the row says.
   */
  isLocallyRunning?: (taskId: TaskId) => boolean;
}

/**
 * Owns the background-task "stock": concurrency admission, TTL expiry, retention
 * GC, and startup reconciliation of orphaned `running` tasks. Pure with respect
 * to time (uses an injected {@link Clock}); the periodic timer is opt-in via
 * {@link start} so tests can drive {@link sweep} directly.
 */
export class LifecycleController {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = 0;

  constructor(
    private readonly store: TaskStore,
    private readonly policy: LifecyclePolicy,
    private readonly clock: Clock,
    private readonly events: SubagentEventSink,
    /** Called when a sweep expires a task, so the runtime can free its slot/abort it. */
    private readonly onExpire: (taskId: TaskId) => void,
    /** Structured logger seam; defaults to a JSON-to-stderr logger when absent. */
    private readonly logger: SubagentLogger = defaultSubagentLogger,
    /** Ownership/lease inputs for orphan detection (AGENT-C-08). */
    private readonly ownership: LifecycleOwnershipOptions = {}
  ) {}

  /** Current number of admitted, non-terminal tasks. */
  get inFlight(): number {
    return this.running;
  }

  /**
   * Decide whether a queued task may be admitted to `running`. `queuedCount` is
   * the number of currently-queued tasks (including the one being considered).
   */
  admit(queuedCount: number): AdmissionDecision {
    if (queuedCount > this.policy.maxQueuedTasks) {
      return { admitted: false, reason: "queue_full" };
    }
    if (this.running >= this.policy.maxConcurrentBackground) {
      return { admitted: false, reason: "concurrency_full" };
    }
    this.running += 1;
    return { admitted: true };
  }

  /** Release a concurrency slot when a task leaves `running`. */
  release(): void {
    if (this.running > 0) {
      this.running -= 1;
    }
  }

  /** Start the periodic sweep. No-op if already started. */
  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.policy.gcIntervalMs);
    // Do not keep the process alive solely for GC.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One sweep: expire non-terminal tasks past TTL, then GC terminal tasks past
   * the retention window. Safe to call directly in tests.
   */
  async sweep(): Promise<void> {
    const now = this.clock.now();

    const live = await this.store.list({
      status: ["queued", "awaiting_approval", "running"],
    });
    for (const task of live) {
      if (now - task.createdAt >= task.ttlMs) {
        await this.expire(task, now);
      }
    }

    const expiredBefore = now - this.policy.retentionMs;
    const stale = await this.store.list({ endedBefore: expiredBefore });
    for (const task of stale) {
      if (isTerminalStatus(task.status)) {
        await this.gc(task.id);
      }
    }
  }

  private async expire(task: BackgroundTask, now: number): Promise<void> {
    await this.store.patch(task.id, { status: "expired", endedAt: now });
    // For a running task we abort via onExpire; the runtime's run `.finally` is
    // the single slot-release point, so we do NOT release here (avoids a
    // double-release). Queued/awaiting_approval tasks hold no slot.
    this.onExpire(task.id);
    this.logger.warn({
      taskId: task.id,
      code: SubagentErrorCode.TTL_EXPIRED,
      reason: "ttl_expired",
      ttlMs: task.ttlMs,
      ageMs: now - task.createdAt,
    });
    this.events.emit({ type: "subagent:expired", taskId: task.id });
  }

  private async gc(id: TaskId): Promise<void> {
    const removable = this.store as TaskStore & {
      remove?: (id: TaskId) => Promise<void>;
    };
    if (typeof removable.remove === "function") {
      await removable.remove(id);
    }
  }

  /**
   * On startup, find tasks left `running` by a *dead* process. The caller
   * decides recovery per its runner's durability (resume vs. fail-resumable).
   *
   * AGENT-C-08: this used to return every `running` row, so a second worker
   * booted against a shared store reaped the first worker's live tasks
   * (split brain — both workers then execute the same task). A row is an
   * orphan only when nobody asserts live ownership of it:
   *
   * - a live lease (`leaseUntil > now`) means some worker is heartbeating it → not an orphan;
   * - a task executing in this process → not an orphan;
   * - a task with no lease at all (legacy/foreign writer) → orphan, subject to
   *   the optional {@link LifecycleOwnershipOptions.orphanGraceMs};
   * - anything else (expired lease, whoever owned it) → orphan, including this
   *   worker's own rows from a previous boot under a stable worker id.
   */
  async findOrphans(): Promise<BackgroundTask[]> {
    const now = this.clock.now();
    const running = await this.store.list({ status: "running" });
    return running.filter((task) => this.isOrphan(task, now));
  }

  private isOrphan(task: BackgroundTask, now: number): boolean {
    const { orphanGraceMs, isLocallyRunning, ownerId } = this.ownership;
    if (isLeaseLive(task, now)) {
      this.logger.debug({
        taskId: task.id,
        code: "ORPHAN_SCAN_SKIPPED_LIVE_LEASE",
        reason: "lease_live",
        ...(task.ownerId !== undefined ? { taskOwnerId: task.ownerId } : {}),
        ...(ownerId !== undefined ? { ownerId } : {}),
        leaseUntil: task.leaseUntil ?? 0,
      });
      return false;
    }
    if (isLocallyRunning?.(task.id) === true) {
      return false;
    }
    const unowned = task.ownerId === undefined && task.leaseUntil === undefined;
    if (unowned && orphanGraceMs !== undefined) {
      const lastKnownAlive = task.startedAt ?? task.admittedAt ?? task.createdAt;
      return now - lastKnownAlive >= orphanGraceMs;
    }
    return true;
  }
}
