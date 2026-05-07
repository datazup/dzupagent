/**
 * In-memory implementation of {@link DzupRunStateStore}.
 *
 * Suitable for development, tests, and single-process deployments.
 * Snapshots are kept in a `Map<runId, DzupRunState>` and lost on
 * process restart. Production deployments should provide a durable
 * store (Postgres, S3, Redis) wired via the same interface.
 */
import type { DzupRunState, DzupRunStateStore } from './run-state-store.js'

function cloneRunState(state: DzupRunState): DzupRunState {
  return {
    ...state,
    messages: [...state.messages],
    cumulativeUsage: [...state.cumulativeUsage],
    ...(state.budget
      ? { budget: {
          ...state.budget,
          emittedThresholds: [...state.budget.emittedThresholds],
        } }
      : {}),
    ...(state.stuckDetector
      ? { stuckDetector: {
          ...state.stuckDetector,
          recentCallKeys: [...state.stuckDetector.recentCallKeys],
        } }
      : {}),
    ...(state.pendingApproval
      ? { pendingApproval: { ...state.pendingApproval } }
      : {}),
  }
}

export class InMemoryRunStateStore implements DzupRunStateStore {
  private readonly snapshots = new Map<string, DzupRunState>()

  async save(state: DzupRunState): Promise<void> {
    // Clone container fields so callers cannot mutate the stored
    // snapshot after handing it off. LangChain message instances are
    // treated as immutable, but the history array itself is isolated.
    this.snapshots.set(state.runId, cloneRunState(state))
  }

  async load(runId: string): Promise<DzupRunState | undefined> {
    const snapshot = this.snapshots.get(runId)
    return snapshot ? cloneRunState(snapshot) : undefined
  }

  async delete(runId: string): Promise<void> {
    this.snapshots.delete(runId)
  }

  async listRunIds(): Promise<string[]> {
    return [...this.snapshots.keys()]
  }

  /** Test helper: total number of stored snapshots. */
  get size(): number {
    return this.snapshots.size
  }

  /** Test helper: drop every snapshot. */
  clear(): void {
    this.snapshots.clear()
  }
}
