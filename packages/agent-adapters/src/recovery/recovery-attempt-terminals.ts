/**
 * Terminal-path helpers for `RecoveryAttemptHandler`.
 *
 * These are the side-effecting routines that record the final trace
 * decision, complete the trace, optionally emit terminal events, and build
 * the `RecoveryResult` payload. They were previously private methods on the
 * handler class — extracting them as standalone functions (MC-024c) keeps
 * the handler focused on attempt orchestration while preserving exact
 * behaviour and event ordering asserted by the recovery test-suite.
 *
 * Each helper takes its collaborators (`traceCapture`, `emitter`, `config`)
 * as plain parameters so the functions stay trivially testable and free of
 * hidden state.
 *
 * @module recovery/recovery-attempt-terminals
 */

import type {
  AdapterProviderId,
} from '../types.js'
import {
  createCancelledRecoveryResult,
} from './recovery-events.js'
import type { RecoveryEventEmitter } from './recovery-event-emitter.js'
import type {
  RecoveryAttemptHandlerConfig,
  RecoveryLoopState,
  TraceCaptureLike,
} from './recovery-attempt-types.js'
import type {
  FailureContext,
  RecoveryCancelledResult,
  RecoveryFailureResult,
  RecoveryResult,
} from './recovery-types.js'

interface TerminalsDeps {
  traceCapture: TraceCaptureLike
  emitter: RecoveryEventEmitter
  config: RecoveryAttemptHandlerConfig
  resolveAvailableProvider: (excluded?: AdapterProviderId[]) => AdapterProviderId | undefined
}

/** Terminal: execution was aborted (`AGENT_ABORTED`). */
export function completeCancelled(
  deps: TerminalsDeps,
  traceId: string,
  state: RecoveryLoopState,
  attempt: number,
  overallStart: number,
  errorMessage: string,
): RecoveryCancelledResult {
  const resolvedProviderId =
    state.lastProviderId ?? deps.resolveAvailableProvider(state.exhaustedProviders)
  const effectiveProviderId = resolvedProviderId ?? ('unknown' as AdapterProviderId)
  deps.traceCapture.recordDecision(traceId, {
    type: 'abort',
    providerId: effectiveProviderId,
    reason: `Execution aborted: ${errorMessage}`,
  })
  deps.traceCapture.completeTrace(traceId)
  deps.emitter.cancelled(
    traceId,
    resolvedProviderId,
    attempt,
    Date.now() - overallStart,
    errorMessage,
  )
  return createCancelledRecoveryResult(
    'abort',
    resolvedProviderId,
    attempt,
    Date.now() - overallStart,
    errorMessage,
  )
}

/** Terminal: max attempts exhausted. */
export function completeExhausted(
  deps: TerminalsDeps,
  traceId: string,
  state: RecoveryLoopState,
  failedProviderId: AdapterProviderId,
  attempt: number,
  overallStart: number,
  errorMessage: string,
): RecoveryFailureResult {
  deps.traceCapture.recordDecision(traceId, {
    type: 'abort',
    providerId: failedProviderId,
    reason: `Max attempts (${deps.config.maxAttempts}) exhausted`,
  })
  deps.traceCapture.completeTrace(traceId)

  deps.emitter.exhausted(
    traceId,
    attempt,
    deps.config.strategyOrder,
    Date.now() - overallStart,
    errorMessage,
  )

  return {
    success: false,
    strategy: state.lastStrategy,
    totalAttempts: attempt,
    totalDurationMs: Date.now() - overallStart,
    error: errorMessage,
    providerId: state.lastProviderId ?? failedProviderId,
  }
}

/** Terminal: strategy chose `abort`. */
export function completeAbort(
  deps: TerminalsDeps,
  traceId: string,
  state: RecoveryLoopState,
  failedProviderId: AdapterProviderId,
  attempt: number,
  overallStart: number,
  errorMessage: string,
): RecoveryFailureResult {
  deps.traceCapture.recordDecision(traceId, {
    type: 'abort',
    providerId: failedProviderId,
    reason: 'Strategy selected abort',
  })
  deps.traceCapture.completeTrace(traceId)

  return {
    success: false,
    strategy: 'abort',
    totalAttempts: attempt,
    totalDurationMs: Date.now() - overallStart,
    error: errorMessage,
    providerId: state.lastProviderId ?? failedProviderId,
  }
}

/** Terminal: strategy chose `escalate-human`. May resolve via escalation handler. */
export async function completeEscalateHuman(
  deps: TerminalsDeps,
  traceId: string,
  state: RecoveryLoopState,
  failureCtx: FailureContext,
  failedProviderId: AdapterProviderId,
  attempt: number,
  overallStart: number,
  errorMessage: string,
): Promise<RecoveryResult | undefined> {
  if (deps.config.escalationHandler) {
    const escalationResult = await handleEscalation(
      deps,
      traceId,
      failureCtx,
      overallStart,
      attempt,
      state.lastProviderId,
      failedProviderId,
    )
    if (escalationResult) return escalationResult
    return undefined
  }

  deps.emitter.approvalRequested(traceId, state.currentInput, failureCtx)

  deps.traceCapture.recordDecision(traceId, {
    type: 'abort',
    providerId: failedProviderId,
    reason: 'Escalated to human — awaiting approval',
  })
  deps.traceCapture.completeTrace(traceId)

  return {
    success: false,
    strategy: 'escalate-human',
    totalAttempts: attempt,
    totalDurationMs: Date.now() - overallStart,
    error: `Escalated to human after ${attempt} failed attempts: ${errorMessage}`,
    providerId: state.lastProviderId ?? failedProviderId,
  }
}

/**
 * Notify the escalation handler and wait for resolution. Returns a
 * terminal `RecoveryResult` if the human aborts or the wait times out;
 * returns `undefined` for resolutions that direct the loop to continue
 * (`retry`, `retry-different`, `override`).
 */
async function handleEscalation(
  deps: TerminalsDeps,
  traceId: string,
  failure: FailureContext,
  overallStart: number,
  attempt: number,
  lastProviderId: AdapterProviderId | undefined,
  failedProviderId: AdapterProviderId,
): Promise<RecoveryResult | undefined> {
  const handler = deps.config.escalationHandler!
  const requestId = crypto.randomUUID()
  const timeoutMs = deps.config.escalationTimeoutMs ?? 300_000

  await handler.notify({
    requestId,
    failedProviderId: failure.failedProvider,
    error: failure.error,
    traceId,
    attempts: [],
    suggestions: ['retry', 'retry-different', 'abort'],
  })

  try {
    const resolution = await handler.waitForResolution(requestId, timeoutMs)

    switch (resolution.action) {
      case 'retry':
      case 'retry-different':
        deps.traceCapture.recordDecision(traceId, {
          type: 'recovery',
          providerId: failedProviderId,
          reason: `Human resolved escalation: ${resolution.action}${resolution.reason ? ` — ${resolution.reason}` : ''}`,
        })
        return undefined

      case 'override':
        deps.traceCapture.recordDecision(traceId, {
          type: 'recovery',
          providerId: resolution.providerId ?? failedProviderId,
          reason: `Human override${resolution.reason ? `: ${resolution.reason}` : ''}`,
        })
        return undefined

      case 'abort':
      default: {
        deps.traceCapture.recordDecision(traceId, {
          type: 'abort',
          providerId: failedProviderId,
          reason: `Human aborted escalation${resolution.reason ? `: ${resolution.reason}` : ''}`,
        })
        deps.traceCapture.completeTrace(traceId)

        return {
          success: false,
          strategy: 'escalate-human',
          totalAttempts: attempt,
          totalDurationMs: Date.now() - overallStart,
          error: `Human aborted after escalation: ${failure.error}`,
          providerId: lastProviderId ?? failedProviderId,
        }
      }
    }
  } catch {
    deps.traceCapture.recordDecision(traceId, {
      type: 'abort',
      providerId: failedProviderId,
      reason: 'Escalation timed out — aborting',
    })
    deps.traceCapture.completeTrace(traceId)

    return {
      success: false,
      strategy: 'escalate-human',
      totalAttempts: attempt,
      totalDurationMs: Date.now() - overallStart,
      error: `Escalation timed out after ${timeoutMs}ms: ${failure.error}`,
      providerId: lastProviderId ?? failedProviderId,
    }
  }
}

export type { TerminalsDeps }
