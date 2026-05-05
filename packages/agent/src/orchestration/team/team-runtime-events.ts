/**
 * Lifecycle event types emitted by `TeamRuntime`.
 *
 * Extracted from `team-runtime.ts` so the dispatcher class stays focused
 * on orchestration. Consumers continue to import these via
 * `team-runtime.ts` for backwards compatibility.
 */

import type { CoordinatorPattern } from './team-definition.js'
import type { TeamPhase } from './team-phase.js'

/** Lifecycle events emitted by `TeamRuntime.execute`. */
export type TeamRuntimeEvent =
  | {
      type: 'phase_changed'
      teamId: string
      runId: string
      from: TeamPhase
      to: TeamPhase
      at: Date
    }
  | {
      type: 'participant_started'
      teamId: string
      runId: string
      participantId: string
      role: string
      at: Date
    }
  | {
      type: 'participant_completed'
      teamId: string
      runId: string
      participantId: string
      role: string
      success: boolean
      error?: string
      durationMs: number
      at: Date
    }
  | {
      type: 'team_completed'
      teamId: string
      runId: string
      durationMs: number
      at: Date
    }
  | {
      type: 'team_failed'
      teamId: string
      runId: string
      error: string
      at: Date
    }
  | {
      type: 'policy_applied'
      teamId: string
      runId: string
      policyGroup: 'governance'
      policyField: 'judgeModel'
      coordinatorPattern: CoordinatorPattern
      at: Date
    }
  | {
      type: 'team_consolidation_completed'
      teamId: string
      runId: string
      namespace: string
      at: Date
    }

/** Callback shape used to stream runtime events to observers. */
export type TeamRuntimeEventEmitter = (event: TeamRuntimeEvent) => void
