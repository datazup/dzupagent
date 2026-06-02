/** Tunable limits controlling the background-task "stock" (Meadows leverage). */
export interface LifecyclePolicy {
  /** Max tasks in `running` state at once; gates admission. */
  maxConcurrentBackground: number;
  /** Max tasks in `queued` state before spawn returns a typed "queue full". */
  maxQueuedTasks: number;
  /** Default TTL applied when a spawn does not override it. */
  defaultTtlMs: number;
  /** How long terminal tasks are retained before GC removes them from the store. */
  retentionMs: number;
  /** Interval between lifecycle sweeps (TTL expiry + retention GC). */
  gcIntervalMs: number;
}

export const DEFAULT_LIFECYCLE_POLICY: LifecyclePolicy = {
  maxConcurrentBackground: 4,
  maxQueuedTasks: 100,
  defaultTtlMs: 15 * 60 * 1000, // 15 minutes
  retentionMs: 60 * 60 * 1000, // 1 hour
  gcIntervalMs: 60 * 1000, // 60 seconds
};
