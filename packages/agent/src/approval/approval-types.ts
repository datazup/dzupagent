import type { HookContext, ContactChannel } from '@dzupagent/core'

/** Approval mode for agent execution */
export type ApprovalMode = 'auto' | 'required' | 'conditional'

/** Conservative default for in-process approval waits. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000

/** Default key used by the approval gate to store pending state. */
export const APPROVAL_PENDING_KEY = 'approval:pending'

/**
 * Persisted state for a pending approval request.
 *
 * Written to an {@link ApprovalCheckpointStore} when the gate is configured
 * with `durableResume: true` and a backing store. The state survives process
 * restart and is removed on resume.
 */
export interface ApprovalPendingState {
  runId: string
  contactId: string
  plan: unknown
  channel: string
  requestedAt: number
  /** When the approval is considered timed out. `null` for unbounded waits. */
  timeoutAt: number | null
  resumeToken: string
}

/**
 * Generic key-value persistence interface for approval pending state.
 *
 * The interface is intentionally narrow -- it stores per-run, per-key blobs.
 * Implementations may layer on top of Postgres, Redis, file-system, or an
 * in-memory map for tests.
 */
export interface ApprovalCheckpointStore {
  /** Persist a pending approval state under (runId, key). */
  save(runId: string, key: string, state: ApprovalPendingState): Promise<void>
  /** Load a previously saved state, or `null` if missing. */
  load(runId: string, key: string): Promise<ApprovalPendingState | null>
  /** Delete the state at (runId, key); idempotent. */
  delete(runId: string, key: string): Promise<void>
}

/** Input for the durable {@link ApprovalGate.requestApproval} entry point. */
export interface ApprovalRequestInput {
  runId: string
  contactId?: string
  plan: unknown
  channel?: string
}

/** Decision payload accepted by {@link ApprovalGate.resume}. */
export interface ApprovalDecision {
  decision: 'approved' | 'rejected'
  reason?: string
}

/** Configuration for the approval gate */
export interface ApprovalConfig {
  mode: ApprovalMode
  /** For 'conditional' mode: function that decides if approval is needed */
  condition?: (plan: unknown, ctx: HookContext) => boolean | Promise<boolean>
  /**
   * Timeout in ms before the wait resolves as timed out.
   *
   * Defaults to {@link DEFAULT_APPROVAL_TIMEOUT_MS} for approval waits. To
   * intentionally wait without an in-process timeout, set
   * `durableResume: true` and back the approval request with an external
   * durable store/resume adapter.
   */
  timeoutMs?: number
  /**
   * Opt into an unbounded in-process wait when `timeoutMs` is omitted.
   *
   * This should only be enabled when pending approval state is durably
   * persisted and another runtime can resume or abandon the request after a
   * process restart. Without this flag, approval waits are bounded by the
   * default timeout.
   */
  durableResume?: boolean
  /** Webhook URL to notify when approval is needed */
  webhookUrl?: string
  /**
   * Called when all webhook delivery attempts fail. Use for dead-letter
   * handling (e.g. persist to a queue for manual retry).
   */
  webhookDLQ?: (runId: string, webhookUrl: string, error: Error) => void | Promise<void>
  /**
   * Delivery channel for human contact requests.
   * Used when the approval gate delegates to the HumanContactTool internally.
   * @default 'in-app'
   */
  channel?: ContactChannel
  /**
   * Optional checkpoint store for durable approval state.
   *
   * When supplied alongside `durableResume: true`, the
   * {@link ApprovalGate.requestApproval} entry point persists pending state
   * here and throws `ApprovalSuspendedError` so the outer driver can abandon
   * the in-process wait and reschedule resumption later.
   */
  checkpointStore?: ApprovalCheckpointStore
}

/** Per-call controls for an approval wait. */
export interface ApprovalWaitOptions {
  /** Cancels/abandons the pending approval wait when the parent run stops. */
  signal?: AbortSignal
}

/** Result of an approval check */
export type ApprovalResult = 'approved' | 'rejected' | 'timeout' | 'cancelled'
