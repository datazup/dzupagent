/**
 * Stateless ApprovalGate.
 *
 * ApprovalGate is a thin facade over an {@link ApprovalStateStore}. It holds
 * no resolver state itself — all lifecycle (create, grant, reject, poll)
 * flows through the configured store so approvals survive process restarts
 * and can be resolved from a different process than the one waiting.
 *
 * Typical usage inside an agent runtime:
 *
 * ```ts
 * const gate = new ApprovalGate() // in-memory store by default
 *
 * // Request side (inside run loop):
 * const outcome = await gate.waitForApproval(runId, 'plan-review', {
 *   question: 'Apply this plan?',
 *   plan,
 * }, 5 * 60_000)
 * if (outcome.decision !== 'granted') throw new ApprovalRejectedError(outcome.reason)
 *
 * // Decision side (HTTP handler, Slack webhook, CLI, ...):
 * await gate.grant(runId, 'plan-review', { approvedBy: 'alice' })
 * ```
 */
import {
  InMemoryApprovalStateStore,
  type ApprovalOutcome,
  type ApprovalStateStore,
} from './approval-state-store.js'

export interface ApprovalGateOptions {
  /** Backing state store. Defaults to an in-memory instance. */
  store?: ApprovalStateStore
  /**
   * Default timeout (ms) applied to `waitForApproval` calls that omit the
   * per-call timeout argument. Defaults to 5 minutes.
   */
  defaultTimeoutMs?: number
}

/**
 * Error thrown when `waitForApproval` resolves with a `rejected` decision.
 * Callers can catch this to bubble a typed error up the stack; the raw
 * outcome is also available via {@link ApprovalGate.waitForApproval}.
 */
export class ApprovalRejectedError extends Error {
  constructor(public readonly runId: string, public readonly approvalId: string, reason?: string) {
    super(reason ?? `Approval rejected for run=${runId} approval=${approvalId}`)
    this.name = 'ApprovalRejectedError'
  }
}

export class ApprovalGate {
  readonly store: ApprovalStateStore
  private readonly defaultTimeoutMs: number

  constructor(options: ApprovalGateOptions = {}) {
    this.store = options.store ?? new InMemoryApprovalStateStore()
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5 * 60_000
  }

  /**
   * Register a pending approval and await the terminal outcome.
   *
   * The payload is persisted via the store so dashboards or HTTP callers
   * can read it back. The gate itself stores no state — it just delegates.
   */
  async waitForApproval(
    runId: string,
    approvalId: string,
    payload: unknown,
    timeoutMs: number = this.defaultTimeoutMs,
  ): Promise<ApprovalOutcome> {
    await this.store.createPending(runId, approvalId, payload)
    return this.store.poll(runId, approvalId, timeoutMs)
  }

  /**
   * Record a `granted` decision. Safe to call from any process that shares
   * the store (Postgres or a shared in-memory instance).
   */
  async grant(runId: string, approvalId: string, response?: unknown): Promise<void> {
    await this.store.grant(runId, approvalId, response)
  }

  /** Record a `rejected` decision with an operator-supplied reason. */
  async reject(runId: string, approvalId: string, reason: string): Promise<void> {
    await this.store.reject(runId, approvalId, reason)
  }
}
