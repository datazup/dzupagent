import type { ToolMessage } from '@langchain/core/messages'

export interface ToolCall {
  id?: string
  name: string
  args: Record<string, unknown>
}

/** Result of executing a single tool call. */
export interface ToolCallResult {
  /** The primary ToolMessage to append to conversation. */
  message: ToolMessage
  /** Optional extra stuck-nudge message to append. */
  stuckNudge?: ToolMessage
  /** If true, the outer loop should break (stuck from errors). */
  stuckBreak?: boolean
  /** Name of the tool that triggered stuck detection (for escalation). */
  stuckToolName?: string
  /** Reason from stuck detector (for building StuckError). */
  stuckReason?: string
  /**
   * If true, the tool was suspended pending human approval.
   * The tool was NOT invoked; the outer loop should halt with
   * `stopReason === 'approval_pending'`.
   */
  approvalPending?: boolean
}

export type StatGetter = (
  name: string,
) => { calls: number; errors: number; totalMs: number }

export type ToolCallExecutor = (
  toolCall: ToolCall,
  index: number,
) => Promise<ToolCallResult>
