import type { BackgroundTask, TaskId } from "../contracts/background-task.js";
import { isTerminalStatus } from "../contracts/background-task.js";
import type { Clock } from "../contracts/clock.js";
import type { SubagentEventSink } from "../contracts/events.js";
import type { TaskStore } from "../contracts/task-store.js";
import type { LifecyclePolicy } from "../runtime/runtime-config.js";

/** Outcome of an admission request. */
export type AdmissionDecision =
  | { admitted: true }
  | { admitted: false; reason: "concurrency_full" | "queue_full" };

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
    private readonly onExpire: (taskId: TaskId) => void
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
   * On startup, find tasks left `running` by a crashed process. The caller
   * decides recovery per its runner's durability (resume vs. fail-resumable).
   */
  async findOrphans(): Promise<BackgroundTask[]> {
    return this.store.list({ status: "running" });
  }
}
