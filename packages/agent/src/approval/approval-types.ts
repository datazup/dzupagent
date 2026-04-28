import type { HookContext, ContactChannel } from '@dzupagent/core'

/** Approval mode for agent execution */
export type ApprovalMode = 'auto' | 'required' | 'conditional'

/** Conservative default for in-process approval waits. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000

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
   * Delivery channel for human contact requests.
   * Used when the approval gate delegates to the HumanContactTool internally.
   * @default 'in-app'
   */
  channel?: ContactChannel
}

/** Per-call controls for an approval wait. */
export interface ApprovalWaitOptions {
  /** Cancels/abandons the pending approval wait when the parent run stops. */
  signal?: AbortSignal
}

/** Result of an approval check */
export type ApprovalResult = 'approved' | 'rejected' | 'timeout' | 'cancelled'
