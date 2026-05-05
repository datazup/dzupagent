/**
 * Lifecycle-event hook factory for `TeamRuntime`.
 *
 * Builds the `TeamPatternHooks` object the runtime hands to a
 * `TeamPattern`, fanning participant + policy events back to the runtime
 * event sink and into any active OTel span / breaker tracker.
 */

import type { ParticipantDefinition } from './team-definition.js'
import type { CoordinatorPattern } from './team-definition.js'
import type { TeamOTelSpanLike } from './team-otel-types.js'
import type { TeamRuntimeEventEmitter } from './team-runtime-events.js'
import type { TeamBreakerTracker } from './team-runtime-breaker.js'
import type { TeamPatternHooks } from './patterns/index.js'

export interface HookContext {
  teamId: string
  runId: string
  coordinatorPattern: CoordinatorPattern
  emitEvent: TeamRuntimeEventEmitter
  getSpan: () => TeamOTelSpanLike | undefined
  breakerTracker: TeamBreakerTracker | undefined
}

export function buildPatternHooks(ctx: HookContext): TeamPatternHooks {
  return {
    emitParticipantStart: (participant) => emitStart(participant, ctx),
    emitParticipantComplete: (participant, success, durationMs, error) =>
      emitComplete(participant, success, durationMs, error, ctx),
    emitPolicyApplied: (group, field) => emitPolicyApplied(group, field, ctx),
  }
}

function emitStart(participant: ParticipantDefinition, ctx: HookContext): void {
  ctx.emitEvent({
    type: 'participant_started',
    teamId: ctx.teamId,
    runId: ctx.runId,
    participantId: participant.id,
    role: participant.role,
    at: new Date(),
  })
}

function emitComplete(
  participant: ParticipantDefinition,
  success: boolean,
  durationMs: number,
  error: string | undefined,
  ctx: HookContext,
): void {
  ctx.emitEvent({
    type: 'participant_completed',
    teamId: ctx.teamId,
    runId: ctx.runId,
    participantId: participant.id,
    role: participant.role,
    success,
    durationMs,
    at: new Date(),
    ...(error !== undefined ? { error } : {}),
  })
  const span = ctx.getSpan()
  if (span) {
    span.addEvent('team.participant_completed', {
      'team.participant_id': participant.id,
      'team.participant_status': success ? 'success' : 'failed',
    })
  }
  const tracker = ctx.breakerTracker
  if (tracker && tracker.record(participant.id, success) === 'tripped' && span) {
    span.addEvent('circuit_breaker.opened', { agentId: participant.id })
  }
}

function emitPolicyApplied(
  policyGroup: 'governance',
  policyField: 'judgeModel',
  ctx: HookContext,
): void {
  ctx.emitEvent({
    type: 'policy_applied',
    teamId: ctx.teamId,
    runId: ctx.runId,
    policyGroup,
    policyField,
    coordinatorPattern: ctx.coordinatorPattern,
    at: new Date(),
  })
  const span = ctx.getSpan()
  if (span) {
    span.addEvent('team.policy_applied', {
      'team.policy_group': policyGroup,
      'team.policy_field': policyField,
      'team.coordination_pattern': ctx.coordinatorPattern,
    })
  }
}
