/**
 * Circuit-breaker bookkeeping helper for `TeamRuntime`.
 *
 * Wraps the core `KeyedCircuitBreaker` with the agent-side
 * `SupervisionPolicy` semantics: detect first-trip transitions per key so
 * the `onCircuitOpen` callback fires exactly once per trip cycle, and
 * forget the trip once a participant has fully recovered.
 *
 * Extracted from the runtime so the class itself stays a thin dispatcher.
 */

import { KeyedCircuitBreaker } from '@dzupagent/core/llm'
import type { SupervisionPolicy } from './supervision-policy.js'

export interface TeamBreakerCallbacks {
  /** Invoked exactly once per first-trip transition. */
  onCircuitOpen?: (participantId: string) => void
}

/**
 * Stateful wrapper that records per-participant outcomes against a
 * `KeyedCircuitBreaker` and fires `onCircuitOpen` on the first trip.
 *
 * Returns `undefined` when no `SupervisionPolicy` was supplied — callers
 * treat that as "supervision disabled" and short-circuit.
 */
export class TeamBreakerTracker {
  private readonly breaker: KeyedCircuitBreaker
  private readonly callbacks: TeamBreakerCallbacks
  private readonly trippedOnce = new Set<string>()

  constructor(policy: SupervisionPolicy, callbacks: TeamBreakerCallbacks = {}) {
    this.breaker = new KeyedCircuitBreaker({
      failureThreshold: policy.maxFailuresBeforeCircuitBreak,
      resetTimeoutMs: policy.resetAfterMs,
    })
    const cb = callbacks.onCircuitOpen ?? policy.onCircuitOpen
    this.callbacks = cb !== undefined ? { onCircuitOpen: cb } : {}
  }

  /** Forwarded availability check from the underlying breaker. */
  isAvailable(participantId: string): boolean {
    return this.breaker.isAvailable(participantId)
  }

  /**
   * Record an outcome for a participant. Returns `'tripped'` when this
   * call is the first transition into the open state for the participant
   * (so the runtime can emit a span event). Otherwise returns `'recorded'`.
   */
  record(
    participantId: string,
    success: boolean,
  ): 'recorded' | 'tripped' {
    if (success) {
      this.breaker.recordSuccess(participantId)
      this.trippedOnce.delete(participantId)
      return 'recorded'
    }

    const wasAvailable = this.breaker.isAvailable(participantId)
    this.breaker.recordFailure(participantId)
    const justTripped =
      wasAvailable &&
      !this.breaker.isAvailable(participantId) &&
      !this.trippedOnce.has(participantId)
    if (!justTripped) return 'recorded'

    this.trippedOnce.add(participantId)
    try {
      this.callbacks.onCircuitOpen?.(participantId)
    } catch {
      // Callback errors must never bubble — supervision is best-effort.
    }
    return 'tripped'
  }

  /** Underlying breaker — exposed so the runtime can pass it to patterns. */
  get registry(): KeyedCircuitBreaker {
    return this.breaker
  }
}
