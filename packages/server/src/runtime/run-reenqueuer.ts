/**
 * P2 — Run re-enqueuer (the `reEnqueueRun` seam for {@link NodeLedgerReclaimer}).
 *
 * The {@link NodeLedgerReclaimer} detects stale durable nodes and, once per
 * owning run, calls a host-provided `reEnqueueRun(runId)` to hand the run back
 * to a live worker. This module builds that callback: it loads the run, refuses
 * to resurrect a finished (terminal) run, and otherwise puts the run back on the
 * {@link RunQueue} so the worker resumes it (the next worker `acquire` on the
 * stale node bumps the fence — the reclaimer itself never re-leases).
 *
 * Kept pure and dependency-narrow so it is trivially unit-testable: it depends
 * only on `RunStore.get` and `RunQueue.enqueue`.
 */
import type { RunStatus, RunStore } from '@dzupagent/core/persistence'

import type { RunQueue } from '../queue/run-queue.js'

/**
 * Terminal {@link RunStatus} values — a run in one of these states is finished
 * and MUST NOT be re-enqueued (doing so would resurrect a completed/cancelled
 * run). There is no shared RunStatus terminal helper in core (the a2a `terminal`
 * arrays are a different type), so this set is defined locally.
 */
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'completed',
  'halted',
  'failed',
  'rejected',
  'cancelled',
])

/** Whether a {@link RunStatus} is terminal (finished, not re-enqueueable). */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

/** Reason a re-enqueue was skipped, surfaced to the optional `onSkip` hook. */
export type ReEnqueueSkipReason = 'not_found' | 'terminal'

export interface BuildRunReEnqueuerDeps {
  /** Run lookup. Only `get` is needed. */
  runStore: Pick<RunStore, 'get'>
  /** Queue the run is handed back to. Only `enqueue` is needed. */
  runQueue: Pick<RunQueue, 'enqueue'>
  /** Priority for re-enqueued jobs (lower = higher priority). Defaults to 0. */
  priority?: number
  /**
   * Observability hook invoked when a re-enqueue is skipped: either the run no
   * longer exists (`not_found`) or it is already terminal (`terminal`).
   */
  onSkip?: (runId: string, reason: ReEnqueueSkipReason) => void
}

/**
 * Build the `reEnqueueRun(runId)` seam consumed by {@link NodeLedgerReclaimer}.
 *
 * The returned function:
 *  - loads the run; if missing, calls `onSkip(runId, 'not_found')` and returns;
 *  - if the run is terminal, calls `onSkip(runId, 'terminal')` and returns;
 *  - otherwise enqueues a job carrying the run's id/agent/input/metadata.
 *
 * It never throws for the skip cases — a stale node whose run has vanished or
 * finished is a benign no-op, not an error.
 */
export function buildRunReEnqueuer(
  deps: BuildRunReEnqueuerDeps
): (runId: string) => Promise<void> {
  const { runStore, runQueue, onSkip } = deps
  const priority = deps.priority ?? 0

  return async (runId: string): Promise<void> => {
    const run = await runStore.get(runId)

    if (run === null) {
      onSkip?.(runId, 'not_found')
      return
    }

    if (isTerminalRunStatus(run.status)) {
      onSkip?.(runId, 'terminal')
      return
    }

    await runQueue.enqueue({
      runId: run.id,
      agentId: run.agentId,
      input: run.input,
      metadata: run.metadata,
      priority,
    })
  }
}
