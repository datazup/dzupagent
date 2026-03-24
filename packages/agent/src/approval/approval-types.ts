import type { HookContext } from '@forgeagent/core'

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
}

/** Result of an approval check */
export type ApprovalResult = 'approved' | 'rejected' | 'timeout'
