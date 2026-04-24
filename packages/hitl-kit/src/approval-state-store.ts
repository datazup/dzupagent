/**
 * Durable approval state store — backs {@link ApprovalGate} so that pending
 * approvals survive process restarts and can be resolved from any process
 * holding the same store instance (or database).
 *
 * The previous implementation held state in a live Promise inside
 * ApprovalGate itself. That design breaks across process boundaries (the
 * waiter cannot be resumed from a different process) and across restarts
 * (the Promise resolver is lost when the JS heap is recycled).
 *
 * ApprovalStateStore abstracts the storage so the gate can delegate without
 * knowing whether the backing store is an in-process Map or a durable
 * Postgres table. Two implementations ship with the kit:
 *
 *   - {@link InMemoryApprovalStateStore} — single-process, uses a Map of
 *     Promise resolvers. Ideal for tests and single-node deployments.
 *
 *   - {@link PostgresApprovalStateStore} — durable, polls a table.
 *     Survives restarts and supports multi-process coordination via the
 *     shared database.
 */

/** Terminal outcome of an approval request. */
export interface ApprovalOutcome {
  decision: 'granted' | 'rejected'
  /** Optional response payload attached when granting (e.g. selectedOption). */
  response?: unknown
  /** Optional rejection reason. */
  reason?: string
}

/**
 * Durable backing store for pending approval requests.
 *
 * Implementations MUST:
 *   - Make `createPending` idempotent for the same `(runId, approvalId)` pair.
 *     Re-creating a pending request that already exists in a terminal state
 *     SHOULD throw.
 *   - Allow `grant`/`reject` to be called from a different process than the
 *     one that called `createPending`.
 *   - Resolve outstanding `poll()` callers when `grant`/`reject` is invoked.
 *   - Reject the `poll()` promise with an `ApprovalTimeoutError` if the
 *     timeout elapses before a decision is recorded.
 */
export interface ApprovalStateStore {
  /**
   * Register a new pending approval. The payload is retained so clients
   * fetching approval details later (e.g. a dashboard) can render the
   * question that was asked.
   */
  createPending(runId: string, approvalId: string, payload: unknown): Promise<void>

  /** Grant a pending approval, attaching an optional response. */
  grant(runId: string, approvalId: string, response?: unknown): Promise<void>

  /** Reject a pending approval with a reason. */
  reject(runId: string, approvalId: string, reason: string): Promise<void>

  /**
   * Await the terminal outcome of a pending approval. Resolves as soon as
   * `grant`/`reject` is called for the same key, or rejects with
   * {@link ApprovalTimeoutError} once `timeoutMs` elapses.
   */
  poll(runId: string, approvalId: string, timeoutMs: number): Promise<ApprovalOutcome>
}

/** Raised by poll() when no decision is recorded before the deadline. */
export class ApprovalTimeoutError extends Error {
  constructor(runId: string, approvalId: string, timeoutMs: number) {
    super(`Approval timed out after ${timeoutMs}ms for run=${runId} approval=${approvalId}`)
    this.name = 'ApprovalTimeoutError'
  }
}

/** Raised when createPending is called twice for the same key. */
export class DuplicateApprovalError extends Error {
  constructor(runId: string, approvalId: string) {
    super(`Approval already exists for run=${runId} approval=${approvalId}`)
    this.name = 'DuplicateApprovalError'
  }
}

/** Raised when grant/reject targets an unknown approval. */
export class UnknownApprovalError extends Error {
  constructor(runId: string, approvalId: string) {
    super(`No pending approval found for run=${runId} approval=${approvalId}`)
    this.name = 'UnknownApprovalError'
  }
}

// ---------------------------------------------------------------------------
// InMemoryApprovalStateStore
// ---------------------------------------------------------------------------

interface PendingEntry {
  payload: unknown
  /** Set when a decision has already arrived before poll() was called. */
  outcome?: ApprovalOutcome
  /** List of waiters registered via poll() for the same key. */
  waiters: Array<{
    resolve: (outcome: ApprovalOutcome) => void
    reject: (err: Error) => void
    timer?: ReturnType<typeof setTimeout>
  }>
}

/**
 * Single-process implementation backed by an in-memory Map. Suitable for
 * tests, single-node deployments, and dev environments.
 *
 * Each `(runId, approvalId)` key maps to a PendingEntry that tracks the
 * stored payload plus any waiters currently polling. When `grant`/`reject`
 * is invoked the entry transitions to a terminal outcome and every waiter
 * is resolved; late poll() callers observing a terminal entry return the
 * cached outcome immediately.
 */
export class InMemoryApprovalStateStore implements ApprovalStateStore {
  private readonly entries = new Map<string, PendingEntry>()

  private key(runId: string, approvalId: string): string {
    return `${runId}::${approvalId}`
  }

  async createPending(runId: string, approvalId: string, payload: unknown): Promise<void> {
    const key = this.key(runId, approvalId)
    if (this.entries.has(key)) {
      throw new DuplicateApprovalError(runId, approvalId)
    }
    this.entries.set(key, { payload, waiters: [] })
  }

  async grant(runId: string, approvalId: string, response?: unknown): Promise<void> {
    this.resolveOutcome(runId, approvalId, { decision: 'granted', response })
  }

  async reject(runId: string, approvalId: string, reason: string): Promise<void> {
    this.resolveOutcome(runId, approvalId, { decision: 'rejected', reason })
  }

  private resolveOutcome(runId: string, approvalId: string, outcome: ApprovalOutcome): void {
    const key = this.key(runId, approvalId)
    const entry = this.entries.get(key)
    if (!entry) {
      throw new UnknownApprovalError(runId, approvalId)
    }
    if (entry.outcome) {
      // Idempotent: repeat calls with the same decision are ignored. Conflict
      // detection (grant then reject) is left to the caller.
      return
    }
    entry.outcome = outcome
    for (const waiter of entry.waiters) {
      if (waiter.timer) {
        clearTimeout(waiter.timer)
      }
      waiter.resolve(outcome)
    }
    entry.waiters = []
  }

  async poll(runId: string, approvalId: string, timeoutMs: number): Promise<ApprovalOutcome> {
    const key = this.key(runId, approvalId)
    const entry = this.entries.get(key)
    if (!entry) {
      throw new UnknownApprovalError(runId, approvalId)
    }
    if (entry.outcome) {
      return entry.outcome
    }

    return new Promise<ApprovalOutcome>((resolve, reject) => {
      const waiter: PendingEntry['waiters'][number] = { resolve, reject }
      waiter.timer = setTimeout(() => {
        const idx = entry.waiters.indexOf(waiter)
        if (idx >= 0) {
          entry.waiters.splice(idx, 1)
        }
        reject(new ApprovalTimeoutError(runId, approvalId, timeoutMs))
      }, timeoutMs)
      entry.waiters.push(waiter)
    })
  }

  /** Test helper — returns the retained payload, or undefined if unknown. */
  getPayload(runId: string, approvalId: string): unknown {
    return this.entries.get(this.key(runId, approvalId))?.payload
  }

  /** Test helper — clears all in-memory state. */
  clear(): void {
    for (const entry of this.entries.values()) {
      for (const waiter of entry.waiters) {
        if (waiter.timer) {
          clearTimeout(waiter.timer)
        }
        waiter.reject(new Error('Store cleared'))
      }
    }
    this.entries.clear()
  }
}
