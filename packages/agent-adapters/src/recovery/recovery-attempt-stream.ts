/**
 * Stream-mode terminal helpers for `RecoveryAttemptHandler`.
 *
 * Mirrors the terminal-path helpers in `recovery-attempt-terminals.ts`, but
 * for the streaming entrypoint where the loop yields `AgentEvent`s and
 * surfaces failures via `ForgeError` instead of returning a `RecoveryResult`.
 *
 * Extracted from `recovery-attempt-handler.ts` (MC-024c) to keep the handler
 * focused on attempt orchestration. Behaviour is byte-for-byte identical —
 * only the call shape (free function vs. private method) differs.
 *
 * @module recovery/recovery-attempt-stream
 */

import { ForgeError } from '@dzupagent/core/events'

import type {
  AdapterProviderId,
  AgentEvent,
} from '../types.js'
import { createRecoveryCancelledEvent } from './recovery-events.js'
import type { RecoveryEventEmitter } from './recovery-event-emitter.js'
import type {
  RecoveryAttemptHandlerConfig,
  RecoveryLoopState,
  TraceCaptureLike,
} from './recovery-attempt-types.js'
import type {
  FailureContext,
  RecoveryStrategy,
} from './recovery-types.js'

interface StreamDeps {
  traceCapture: TraceCaptureLike
  emitter: RecoveryEventEmitter
  config: RecoveryAttemptHandlerConfig
  resolveAvailableProvider: (excluded?: AdapterProviderId[]) => AdapterProviderId | undefined
}

/** Stream-mode counterpart of `completeCancelled`. */
export async function* emitStreamCancellation(
  deps: StreamDeps,
  traceId: string,
  state: RecoveryLoopState,
  attempt: number,
  durationMs: number,
  errorMessage: string,
): AsyncGenerator<AgentEvent> {
  const resolvedProviderId =
    state.lastProviderId ?? deps.resolveAvailableProvider(state.exhaustedProviders)
  const effectiveProviderId = resolvedProviderId ?? ('unknown' as AdapterProviderId)
  deps.traceCapture.recordDecision(traceId, {
    type: 'abort',
    providerId: effectiveProviderId,
    reason: `Execution aborted: ${errorMessage}`,
  })
  deps.traceCapture.completeTrace(traceId)
  deps.emitter.cancelled(traceId, resolvedProviderId, attempt, durationMs, errorMessage)
  yield createRecoveryCancelledEvent(resolvedProviderId, attempt, durationMs, errorMessage)
}

/**
 * Stream-mode terminal: max attempts exhausted. Records the abort,
 * completes the trace, and throws an `ALL_ADAPTERS_EXHAUSTED` ForgeError
 * with the surrounding error attached as `cause`.
 */
export function throwStreamExhausted(
  deps: StreamDeps,
  traceId: string,
  failedProviderId: AdapterProviderId,
  attempt: number,
  error: Error,
  rawError: unknown,
): never {
  deps.traceCapture.recordDecision(traceId, {
    type: 'abort',
    providerId: failedProviderId,
    reason: `Max attempts (${deps.config.maxAttempts}) exhausted`,
  })
  deps.traceCapture.completeTrace(traceId)

  throw new ForgeError({
    code: 'ALL_ADAPTERS_EXHAUSTED',
    message: `Recovery exhausted after ${attempt} attempts: ${error.message}`,
    recoverable: false,
    cause: rawError instanceof Error ? rawError : undefined,
    context: {
      providerId: failedProviderId,
      attempts: attempt,
      maxAttempts: deps.config.maxAttempts,
    },
  })
}

/**
 * Stream-mode terminal: strategy chose `abort` or `escalate-human`.
 * Records the decision, optionally emits the approval request, and
 * throws an `ALL_ADAPTERS_EXHAUSTED` ForgeError.
 */
export function throwStreamStopped(
  deps: StreamDeps,
  traceId: string,
  state: RecoveryLoopState,
  failureCtx: FailureContext,
  failedProviderId: AdapterProviderId,
  attempt: number,
  error: Error,
  nextStrategy: RecoveryStrategy,
): never {
  deps.traceCapture.recordDecision(traceId, {
    type: 'abort',
    providerId: failedProviderId,
    reason: nextStrategy === 'abort' ? 'Strategy selected abort' : 'Escalated to human',
  })
  deps.traceCapture.completeTrace(traceId)

  if (nextStrategy === 'escalate-human') {
    deps.emitter.approvalRequested(traceId, state.currentInput, failureCtx)
  }

  throw new ForgeError({
    code: 'ALL_ADAPTERS_EXHAUSTED',
    message: `Recovery stopped (${nextStrategy}): ${error.message}`,
    recoverable: nextStrategy === 'escalate-human',
    context: {
      providerId: failedProviderId,
      strategy: nextStrategy,
      attempts: attempt,
    },
  })
}

export type { StreamDeps }
