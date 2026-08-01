import type { DzupEventBus } from '@dzupagent/core/events'
import type { RuntimeHardBudgetResult } from './runtime-hard-budget.js'

/** Emit an agent hard-budget proof without prompt or degradation text. */
export function emitAgentHardBudgetTelemetry(args: {
  eventBus?: DzupEventBus | undefined
  agentId: string
  phase: 'tool-loop' | 'stream'
  result: RuntimeHardBudgetResult
}): void {
  const { result } = args
  args.eventBus?.emit({
    type: 'context:hard_budget_evaluated',
    agentId: args.agentId,
    phase: args.phase,
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
    ...(result.protection
      ? {
          protectedMessageCount: result.protection.protectedMessageCount,
          protectedToolGroupCount:
            result.protection.protectedToolGroupCount,
          droppedMessageCount: result.protection.droppedMessageCount,
        }
      : {}),
  })
}
