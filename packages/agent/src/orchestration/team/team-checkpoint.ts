/**
 * Team checkpoint types — enable suspend/resume across team runs.
 *
 * A `TeamCheckpoint` captures enough state to resume a team after a human
 * approval, process restart, or long-running async step. `ResumeContract`
 * is the handshake that pairs a checkpoint with the resume call.
 */

import type { TeamPhase } from './team-phase.js'

/** Serializable snapshot of a team run at a specific phase. */
export interface TeamCheckpoint {
  /** ID of the team this checkpoint belongs to. */
  teamId: string
  /** ID of the specific run being checkpointed. */
  runId: string
  /** The phase that was active when the snapshot was taken. */
  phase: TeamPhase
  /** Participant IDs whose work is already finished and persisted. */
  completedParticipantIds: string[]
  /** Participant IDs whose work still needs to run. */
  pendingParticipantIds: string[]
  /** Shared context (blackboard state, intermediate outputs, etc.). */
  sharedContext: Record<string, unknown>
  /** When the snapshot was taken. */
  checkpointedAt: Date
}

/** Handshake used when resuming a checkpointed team run. */
export interface ResumeContract {
  /** ID of the checkpoint to resume from. */
  checkpointId: string
  /** Phase at which to re-enter the run. */
  resumeFromPhase: TeamPhase
  /** If true, participants listed as completed will not re-run. */
  skipCompletedParticipants: boolean
}
