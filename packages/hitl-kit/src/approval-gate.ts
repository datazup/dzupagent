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
import type { ApproverVote, QuorumPolicy, QuorumTally } from './approval-quorum.js'
import {
  ApprovalTimeoutError,
  InMemoryApprovalStateStore,
  UnknownApprovalError,
  type ApprovalOutcome,
  type ApprovalStateStore,
} from './approval-state-store.js'
import {
  EscalationEngine,
  type EscalationDecision,
  type EscalationEvent,
  type EscalationPolicy,
  type EscalationState,
} from './escalation-engine.js'
import {
  InMemoryQuorumVoteStore,
  recordQuorumVote,
  type QuorumVoteStore,
} from './quorum-vote-store.js'

export interface ApprovalGateOptions {
  /** Backing state store. Defaults to an in-memory instance. */
  store?: ApprovalStateStore
  /**
   * Default timeout (ms) applied to `waitForApproval` calls that omit the
   * per-call timeout argument. Defaults to 5 minutes.
   */
  defaultTimeoutMs?: number
  /**
   * Opt-in: vote storage used by {@link ApprovalGate.vote}. Defaults to an
   * in-memory instance. Unused unless `vote()` is called.
   */
  voteStore?: QuorumVoteStore
}

export interface WaitForEscalationOptions {
  /** Receives the escalation engine's events unchanged. */
  onEvent?: (event: EscalationEvent) => void
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
  readonly voteStore: QuorumVoteStore
  private readonly defaultTimeoutMs: number
  /** Running escalations, keyed by run then approval. Process-local. */
  private readonly escalations = new Map<string, Map<string, EscalationEngine>>()

  constructor(options: ApprovalGateOptions = {}) {
    this.store = options.store ?? new InMemoryApprovalStateStore()
    this.voteStore = options.voteStore ?? new InMemoryQuorumVoteStore()
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

  /**
   * Opt-in quorum: record one approver's vote via {@link recordQuorumVote}
   * and, once the tally is terminal, settle the approval in the store. The
   * settle repeats on every terminal call (grant/reject are idempotent), so
   * a retry after a failed settle heals. Throws the store's
   * `UnknownApprovalError` when the tally is terminal but no approval is
   * pending for the key.
   */
  async vote(
    runId: string,
    approvalId: string,
    policy: QuorumPolicy,
    vote: ApproverVote,
  ): Promise<QuorumTally> {
    const tally = await recordQuorumVote(this.voteStore, policy, runId, approvalId, vote)
    if (tally.status === 'granted') {
      await this.store.grant(runId, approvalId, { quorum: tally })
    } else if (tally.status === 'rejected') {
      await this.store.reject(
        runId,
        approvalId,
        `Quorum not reached: ${tally.rejected.length} of ${policy.approvers.length} approvers rejected`,
      )
    }
    return tally
  }

  /**
   * Opt-in escalation: register a pending approval and wait through the
   * approver chain of `policy`, one level at a time. Approvers decide via
   * {@link ApprovalGate.decideEscalation}; when the chain is exhausted the
   * policy's `onExhausted` action settles the store.
   *
   * Level authority lives in this gate instance (single-process). A second
   * wait for a key that is already escalating reuses the running engine and
   * does not attach its `onEvent`. A direct `grant`/`reject` still settles
   * the store and ends the wait (operator override).
   */
  async waitForEscalation(
    runId: string,
    approvalId: string,
    payload: unknown,
    policy: EscalationPolicy,
    options: WaitForEscalationOptions = {},
  ): Promise<ApprovalOutcome> {
    let approvals = this.escalations.get(runId)
    let engine = approvals?.get(approvalId)
    if (!engine) {
      // Constructing the engine validates the policy before anything is persisted.
      engine = new EscalationEngine(policy, { onEvent: options.onEvent })
      if (!approvals) {
        approvals = new Map()
        this.escalations.set(runId, approvals)
      }
      approvals.set(approvalId, engine)
    }
    const running = engine
    const runApprovals = approvals!
    try {
      await this.store.createPending(runId, approvalId, payload)
      for (;;) {
        const state = running.tick()
        if (state.status !== 'pending') {
          if (state.resolvedBy?.kind === 'exhausted') {
            await this.settleExhausted(runId, approvalId, state)
          }
          // The store holds the first recorded decision, which wins.
          return await this.store.poll(runId, approvalId, 1)
        }
        try {
          return await this.store.poll(runId, approvalId, state.deadline - Date.now())
        } catch (err) {
          if (!(err instanceof ApprovalTimeoutError)) throw err
        }
      }
    } finally {
      if (runApprovals.get(approvalId) === running) {
        runApprovals.delete(approvalId)
        if (runApprovals.size === 0 && this.escalations.get(runId) === runApprovals) {
          this.escalations.delete(runId)
        }
      }
    }
  }

  /**
   * Record a decision from an approver on the active escalation level and
   * settle the store. Throws `ApproverNotActiveError` for an approver outside
   * the active level and `UnknownApprovalError` when no escalation is waiting
   * for the key in this gate.
   */
  async decideEscalation(
    runId: string,
    approvalId: string,
    approverId: string,
    decision: EscalationDecision,
    reason?: string,
  ): Promise<EscalationState> {
    const engine = this.escalations.get(runId)?.get(approvalId)
    if (!engine) throw new UnknownApprovalError(runId, approvalId)
    const state = engine.decide(approverId, decision, reason)
    const resolvedBy = state.resolvedBy
    if (resolvedBy?.kind === 'exhausted') {
      await this.settleExhausted(runId, approvalId, state)
    } else if (resolvedBy?.kind === 'approver' && resolvedBy.approverId === approverId) {
      if (state.status === 'granted') {
        await this.store.grant(runId, approvalId, {
          approverId,
          level: state.level,
          ...(reason !== undefined ? { reason } : {}),
        })
      } else {
        await this.store.reject(
          runId,
          approvalId,
          reason ?? `Rejected by ${approverId} at escalation level ${state.level}`,
        )
      }
    }
    return state
  }

  private async settleExhausted(
    runId: string,
    approvalId: string,
    state: EscalationState,
  ): Promise<void> {
    if (state.status === 'granted') {
      await this.store.grant(runId, approvalId, { escalation: 'exhausted' })
    } else {
      await this.store.reject(
        runId,
        approvalId,
        'Escalation exhausted: no decision before the last level timed out',
      )
    }
  }
}
