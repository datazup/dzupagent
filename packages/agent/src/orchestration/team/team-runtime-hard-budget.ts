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
    measuredTokens: result.tokenMeasurement.tokens,
    measurementMethod: result.tokenMeasurement.method,
    satisfied: result.hardBudget.satisfied,
    adoptionSafe: result.hardBudget.adoptionSafe,
    truncated: result.hardBudget.truncated,
    markerIncluded: result.hardBudget.markerIncluded,
    at: new Date(),
  })
  args.span?.addEvent('team.context_handoff_budget_evaluated', {
    'team.context_budget.satisfied': result.hardBudget.satisfied,
    'team.context_budget.adoption_safe': result.hardBudget.adoptionSafe,
    'team.context_budget.truncated': result.hardBudget.truncated,
    'team.context_budget.measured_tokens': result.tokenMeasurement.tokens,
    'team.context_budget.content_limit': result.reservation.contentTokenLimit,
  })
  if (!result.hardBudget.adoptionSafe || result.text === null) {
    throw new RuntimeHardBudgetAdoptionError('team-runtime', result)
  }
  return result.text
}
