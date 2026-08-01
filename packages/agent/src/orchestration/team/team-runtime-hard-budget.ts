import {
  RuntimeHardBudgetAdoptionError,
  applyRuntimeTextHardBudget,
  type HardBudgetReservationConfig,
} from '../../agent/runtime-hard-budget.js'
import type { TeamOTelSpanLike } from './team-otel-types.js'
import type { TeamRuntimeEventEmitter } from './team-runtime-events.js'

/** Fit TeamRuntime's initial task before any coordination pattern adopts it. */
export function prepareTeamTaskHandoff(args: {
  task: string
  config: HardBudgetReservationConfig
  teamId: string
  runId: string
  emitEvent: TeamRuntimeEventEmitter
  span?: TeamOTelSpanLike
}): string {
  const result = applyRuntimeTextHardBudget({
    text: args.task,
    config: args.config,
  })
  args.emitEvent({
    type: 'context_handoff_budget_evaluated',
    teamId: args.teamId,
    runId: args.runId,
    contextWindowTokens: result.reservation.contextWindowTokens,
    contentTokenLimit: result.reservation.contentTokenLimit,
    reservedTokens: result.reservation.totalReservedTokens,
    outputReservedTokens: result.reservation.outputTokens,
    summaryReservedTokens: result.reservation.summaryTokens,
    toolReservedTokens: result.reservation.toolTokens,
    envelopeTokens: result.reservation.envelopeTokens,
    measuredTokens: result.tokenMeasurement.tokens,
    measurementMethod: result.tokenMeasurement.method,
    satisfied: result.hardBudget.satisfied,
    adoptionSafe: result.hardBudget.adoptionSafe,
    truncated: result.hardBudget.truncated,
    markerIncluded: result.hardBudget.markerIncluded,
    ...(result.profile
      ? {
          profileSchemaVersion: result.profile.schemaVersion,
          profileId: result.profile.id,
          profileRevision: result.profile.revision,
          provider: result.profile.provider,
          model: result.profile.model,
          tokenizerId: result.profile.tokenizerId,
          tokenizerRevision: result.profile.tokenizerRevision,
          ...(result.profile.tokenizerEncoding
            ? { tokenizerEncoding: result.profile.tokenizerEncoding }
            : {}),
        }
      : {}),
    at: new Date(),
  })
  args.span?.addEvent('team.context_handoff_budget_evaluated', {
    'team.context_budget.satisfied': result.hardBudget.satisfied,
    'team.context_budget.adoption_safe': result.hardBudget.adoptionSafe,
    'team.context_budget.truncated': result.hardBudget.truncated,
    'team.context_budget.measured_tokens': result.tokenMeasurement.tokens,
    'team.context_budget.content_limit': result.reservation.contentTokenLimit,
    'team.context_budget.output_reserved_tokens':
      result.reservation.outputTokens,
    'team.context_budget.summary_reserved_tokens':
      result.reservation.summaryTokens,
    'team.context_budget.tool_reserved_tokens': result.reservation.toolTokens,
    'team.context_budget.envelope_tokens': result.reservation.envelopeTokens,
    ...(result.profile
      ? {
          'team.context_budget.profile_id': result.profile.id,
          'team.context_budget.profile_revision': result.profile.revision,
          'team.context_budget.provider': result.profile.provider,
          'team.context_budget.model': result.profile.model,
          'team.context_budget.tokenizer_id': result.profile.tokenizerId,
          'team.context_budget.tokenizer_revision':
            result.profile.tokenizerRevision,
        }
      : {}),
  })
  if (!result.hardBudget.adoptionSafe || result.text === null) {
    throw new RuntimeHardBudgetAdoptionError('team-runtime', result)
  }
  return result.text
}
