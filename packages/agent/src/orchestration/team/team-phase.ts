/**
 * Team phase model — tracks the lifecycle stage of a team run.
 *
 * Phases are ordered but not strictly linear: runs can jump to `failed`
 * from any active phase, and resumed runs may re-enter an earlier phase.
 * The transition log provides an audit trail for observability.
 */

/** Discrete lifecycle phase of a team run. */
export type TeamPhase =
  | 'initializing'
  | 'planning'
  | 'executing'
  | 'evaluating'
  | 'completing'
  | 'failed'

/** Live phase state for a team run. */
export interface TeamPhaseModel {
  /** The currently active phase. */
  current: TeamPhase
  /** When the run first entered `initializing`. */
  startedAt: Date
  /** Ordered log of phase transitions (oldest first). */
  transitions: Array<{ from: TeamPhase; to: TeamPhase; at: Date }>
}
