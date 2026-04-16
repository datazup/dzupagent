import type { HookContext, ContactChannel } from '@dzupagent/core'

/** Approval mode for agent execution */
export type ApprovalMode = 'auto' | 'required' | 'conditional'

/** Configuration for the approval gate */
export interface ApprovalConfig {
  mode: ApprovalMode
  /** For 'conditional' mode: function that decides if approval is needed */
  condition?: (plan: unknown, ctx: HookContext) => boolean | Promise<boolean>
  /** Timeout in ms before auto-rejection (default: no timeout) */
  timeoutMs?: number
  /** Webhook URL to notify when approval is needed */
  webhookUrl?: string
  /**
   * Delivery channel for human contact requests.
   * Used when the approval gate delegates to the HumanContactTool internally.
   * @default 'in-app'
   */
  channel?: ContactChannel
}

/** Result of an approval check */
export type ApprovalResult = 'approved' | 'rejected' | 'timeout'
