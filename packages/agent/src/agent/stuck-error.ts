/**
 * Structured error thrown when the tool loop aborts due to stuck detection.
 *
 * Contains diagnostic information about what tool was repeated, why the
 * detector flagged it, and what escalation level triggered the abort.
 */

/** Escalation levels for stuck recovery. */
export type EscalationLevel = 1 | 2 | 3

/** Recovery action taken at each escalation level. */
export type RecoveryAction = 'tool_blocked' | 'nudge_injected' | 'loop_aborted'

export class StuckError extends Error {
  /** The tool that triggered stuck detection (if identified). */
  readonly repeatedTool: string | undefined
  /** Why the detector flagged the agent as stuck. */
  readonly reason: string
  /** The escalation level that caused the abort (always 3 for thrown errors). */
  readonly escalationLevel: EscalationLevel
  /** The recovery action taken. */
  readonly recoveryAction: RecoveryAction

  constructor(opts: {
    reason: string
    repeatedTool?: string
    escalationLevel?: EscalationLevel
  }) {
    const tool = opts.repeatedTool ? ` on tool "${opts.repeatedTool}"` : ''
    super(`Agent stuck${tool}: ${opts.reason}`)
    this.name = 'StuckError'
    this.reason = opts.reason
    this.repeatedTool = opts.repeatedTool
    this.escalationLevel = opts.escalationLevel ?? 3
    this.recoveryAction = escalationToAction(this.escalationLevel)
  }
}

function escalationToAction(level: EscalationLevel): RecoveryAction {
  switch (level) {
    case 1: return 'tool_blocked'
    case 2: return 'nudge_injected'
    case 3: return 'loop_aborted'
  }
}
