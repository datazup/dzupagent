import type { AgentEvent, TokenUsage } from '../types.js'
import type { CodexAppServerInboundEvent } from './codex-app-server-client.js'
import {
  adapterError,
  type ActiveRun,
} from './codex-app-server-adapter-contracts.js'
import {
  nonNegativeInteger,
  objectValue,
} from './codex-app-server-adapter-validation.js'

/**
 * Builds the normalized events the adapter is allowed to emit.
 *
 * Nothing the provider authored reaches a consumer through here. Messages are
 * fixed adapter-owned strings and every value copied out of a frame is a number
 * that has been range-checked first, so a provider cannot use an event as a
 * channel for its own prose or for an unvalidated field.
 */
export function interactionEvent(
  event: CodexAppServerInboundEvent,
  run: ActiveRun,
  correlationId: string | undefined,
  timestamp: number,
): AgentEvent {
  const autoResolutionMs = nonNegativeInteger(event.params['autoResolutionMs'])
  const permission = event.method.includes('Approval') || event.method.includes('permissions')
  return withCorrelation({
    type: 'adapter:interaction_required',
    providerId: 'codex',
    interactionId: `codex-app-server-request:${String(event.requestId)}`,
    question: permission
      ? 'Codex requires an explicit approval decision.'
      : 'Codex requires explicit user input.',
    kind: permission ? 'permission' : 'clarification',
    timestamp,
    // A provider-proposed auto-resolution may shorten the wait but never outlive
    // the run: the turn's own timeout is the ceiling either way.
    expiresAt: timestamp + Math.min(autoResolutionMs ?? run.timeoutMs, run.timeoutMs),
  }, correlationId)
}

export function failedEvent(
  timestamp: number,
  correlationId: string | undefined,
  code: string,
  message: string,
  sessionId?: string,
): AgentEvent {
  return withCorrelation({
    type: 'adapter:failed',
    providerId: 'codex',
    error: message,
    code,
    timestamp,
    ...(sessionId ? { sessionId } : {}),
  }, correlationId)
}

export function withCorrelation<T extends AgentEvent>(
  event: T,
  correlationId: string | undefined,
): T {
  return correlationId ? { ...event, correlationId } : event
}

/**
 * Reads the turn's terminal usage evidence. `last` supplies the reported values
 * while `total` is required but unused: a payload carrying only one of the two
 * is a partial report, and accepting it would let an incomplete accounting stand
 * in for the evidence a completed turn is required to produce.
 */
export function tokenUsage(value: unknown): TokenUsage {
  const usage = objectValue(value)
  const last = tokenBreakdown(usage['last'])
  if (!last || !tokenBreakdown(usage['total'])) {
    throw adapterError(
      'CODEX_APP_SERVER_USAGE_INVALID',
      'Codex app-server emitted invalid token usage',
    )
  }
  return {
    inputTokens: last.inputTokens,
    outputTokens: last.outputTokens,
    cachedInputTokens: last.cachedInputTokens,
    ...(last.cacheWriteTokens !== undefined ? { cacheWriteTokens: last.cacheWriteTokens } : {}),
  }
}

/**
 * Fields the adapter does not surface -- `reasoningOutputTokens`, `totalTokens` --
 * are still required, because their absence marks a truncated breakdown rather
 * than an optional one. `cacheWriteInputTokens` is genuinely optional, so it is
 * rejected only when present and unusable.
 */
function tokenBreakdown(value: unknown): {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens: number
  readonly cacheWriteTokens?: number | undefined
} | undefined {
  const breakdown = objectValue(value)
  const inputTokens = nonNegativeInteger(breakdown['inputTokens'])
  const outputTokens = nonNegativeInteger(breakdown['outputTokens'])
  const cachedInputTokens = nonNegativeInteger(breakdown['cachedInputTokens'])
  const reasoningOutputTokens = nonNegativeInteger(breakdown['reasoningOutputTokens'])
  const totalTokens = nonNegativeInteger(breakdown['totalTokens'])
  const cacheWriteTokens = breakdown['cacheWriteInputTokens'] === undefined
    ? undefined
    : nonNegativeInteger(breakdown['cacheWriteInputTokens'])
  if (
    inputTokens === undefined
    || outputTokens === undefined
    || cachedInputTokens === undefined
    || reasoningOutputTokens === undefined
    || totalTokens === undefined
    || (breakdown['cacheWriteInputTokens'] !== undefined && cacheWriteTokens === undefined)
  ) return undefined
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  }
}
