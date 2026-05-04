/**
 * RecoveryEventEmitter — thin wrapper around `DzupEventBus` that emits the
 * five recovery-related events used by `AdapterRecoveryCopilot`.
 *
 * Extracted from `adapter-recovery.ts` so the main class can delegate
 * "format and emit" work and keep its body focused on control flow.
 *
 * @module recovery/recovery-event-emitter
 */

import type { DzupEventBus } from '@dzupagent/core'

import type { AdapterProviderId, AgentInput } from '../types.js'
import type { FailureContext, RecoveryStrategy } from './recovery-types.js'

export class RecoveryEventEmitter {
  constructor(private readonly eventBus: DzupEventBus | undefined) {}

  attemptStarted(
    runId: string,
    attempt: number,
    maxAttempts: number,
    strategy: RecoveryStrategy,
    providerId: AdapterProviderId,
  ): void {
    this.eventBus?.emit({
      type: 'recovery:attempt_started',
      agentId: providerId,
      runId,
      attempt,
      maxAttempts,
      strategy,
      timestamp: Date.now(),
    })
  }

  succeeded(
    runId: string,
    attempt: number,
    strategy: RecoveryStrategy,
    durationMs: number,
  ): void {
    this.eventBus?.emit({
      type: 'recovery:succeeded',
      agentId: 'adapter-recovery',
      runId,
      attempt,
      strategy,
      durationMs,
    })
  }

  exhausted(
    runId: string,
    attempts: number,
    strategies: RecoveryStrategy[],
    durationMs: number,
    lastError?: string,
  ): void {
    this.eventBus?.emit({
      type: 'recovery:exhausted',
      agentId: 'adapter-recovery',
      runId,
      attempts,
      strategies,
      durationMs,
      lastError,
    })
  }

  cancelled(
    runId: string,
    providerId: AdapterProviderId | undefined,
    attempts: number,
    durationMs: number,
    reason: string,
  ): void {
    this.eventBus?.emit({
      type: 'recovery:cancelled',
      agentId: providerId ?? 'adapter-recovery',
      runId,
      attempts,
      durationMs,
      reason,
    })
  }

  approvalRequested(traceId: string, input: AgentInput, failure: FailureContext): void {
    this.eventBus?.emit({
      type: 'approval:requested',
      runId: traceId,
      plan: {
        type: 'adapter-recovery-escalation',
        prompt: input.prompt,
        failedProvider: failure.failedProvider,
        error: failure.error,
        attemptNumber: failure.attemptNumber,
        exhaustedProviders: failure.exhaustedProviders,
      },
    })
  }
}
