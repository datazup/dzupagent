/**
 * Phase-transition helper for `TeamRuntime`.
 *
 * Encapsulates the small but repetitive bookkeeping involved in driving the
 * `TeamPhaseModel` forward and emitting `phase_changed` lifecycle events
 * (plus the matching OTel span event when a span is active).
 *
 * Extracted from `team-runtime.ts` so the dispatcher class itself stays a
 * thin orchestration shell.
 */

import type { TeamPhase, TeamPhaseModel } from './team-phase.js'
import type { TeamOTelSpanLike } from './team-otel-types.js'
import type { TeamRuntimeEventEmitter } from './team-runtime-events.js'

export interface PhaseDriverOptions {
  teamId: string
  runId: string
  emitEvent: TeamRuntimeEventEmitter
  getSpan: () => TeamOTelSpanLike | undefined
}

/**
 * Mutate the phase model into `to`, emit a `phase_changed` event when the
 * transition is real (i.e. the from/to differ), and add the matching span
 * event when an OTel span is active.
 */
export function transitionPhase(
  model: TeamPhaseModel,
  to: TeamPhase,
  opts: PhaseDriverOptions,
): void {
  const from = model.current
  if (from === to) return
  const at = new Date()
  model.transitions.push({ from, to, at })
  model.current = to
  opts.emitEvent({
    type: 'phase_changed',
    teamId: opts.teamId,
    runId: opts.runId,
    from,
    to,
    at,
  })
  const span = opts.getSpan()
  if (span) {
    span.addEvent('team.phase_changed', {
      'team.phase': to,
      'team.phase_from': from,
    })
  }
}

/** Construct the initial phase model in the `initializing` state. */
export function createPhaseModel(startedAt: number): TeamPhaseModel {
  return {
    current: 'initializing',
    startedAt: new Date(startedAt),
    transitions: [],
  }
}
