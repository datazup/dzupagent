/**
 * Resume helper for `TeamRuntime`.
 *
 * Builds the narrowed participant set + augmented task prompt used when
 * resuming from a `TeamCheckpoint`. Extracted so the runtime keeps a single
 * `execute` happy-path and resume is a thin transformation layered on top.
 */

import type { ParticipantDefinition, TeamDefinition } from './team-definition.js'
import type { TeamCheckpoint, ResumeContract } from './team-checkpoint.js'
import type { TeamRunResult } from './team-workspace.js'

export interface ResumePlan {
  /** Participants that should be re-run. */
  workingParticipants: ParticipantDefinition[]
  /** Task prompt augmented with serialized shared context, when present. */
  resumeTask: string
}

/** Canonical empty result returned when there is nothing left to resume. */
export const EMPTY_RESUME_RESULT: TeamRunResult = {
  content: '',
  agentResults: [],
  durationMs: 0,
  pattern: 'peer-to-peer',
}

/**
 * Validate the checkpoint's team binding and compute the participant
 * subset + augmented task. Throws when the checkpoint does not belong to
 * the runtime's team.
 */
export function planResume(
  definition: TeamDefinition,
  checkpoint: TeamCheckpoint,
  contract: ResumeContract,
  task: string,
): ResumePlan {
  if (checkpoint.teamId !== definition.id) {
    throw new Error(
      `TeamRuntime.resume: checkpoint belongs to team '${checkpoint.teamId}', not '${definition.id}'`,
    )
  }

  const pendingIds = contract.skipCompletedParticipants
    ? new Set(checkpoint.pendingParticipantIds)
    : new Set(definition.participants.map((p) => p.id))

  const workingParticipants = definition.participants.filter((p) =>
    pendingIds.has(p.id),
  )

  const sharedContextStr =
    Object.keys(checkpoint.sharedContext).length > 0
      ? `\n\n## Resumed shared context\n${JSON.stringify(
          checkpoint.sharedContext,
          null,
          2,
        )}`
      : ''
  const resumeTask = `${task}${sharedContextStr}`

  return { workingParticipants, resumeTask }
}
