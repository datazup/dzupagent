/**
 * Type definitions consumed by `RecoveryAttemptHandler`.
 *
 * Extracted from `recovery-attempt-handler.ts` (MC-024c) to keep the handler
 * module focused on behaviour. The runtime class continues to live alongside
 * these types in `recovery-attempt-handler.ts`, which re-exports them so the
 * existing public surface (including `adapter-recovery.ts`) is unchanged.
 *
 * @module recovery/recovery-attempt-types
 */

import type {
  AdapterProviderId,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'
import type {
  ExecutionTrace,
  TraceDecision,
} from './execution-trace-types.js'
import type { EscalationHandler } from './escalation-handler.js'
import type {
  FailureContext,
  RecoveryStrategy,
  RecoverySuccessResult,
} from './recovery-types.js'

/**
 * Minimal contract the handler needs from a trace capture. Defined
 * structurally so the concrete `ExecutionTraceCapture` can be passed
 * without creating a cycle through `adapter-recovery.js`.
 */
export interface TraceCaptureLike {
  recordDecision(traceId: string, decision: Omit<TraceDecision, 'timestamp'>): void
  recordEvent(traceId: string, event: AgentEvent): void
  completeTrace(traceId: string): ExecutionTrace | undefined
}

/** Mutable state threaded through the recovery attempt loop. */
export interface RecoveryLoopState {
  exhaustedProviders: AdapterProviderId[]
  lastStrategy: RecoveryStrategy
  lastProviderId: AdapterProviderId | undefined
  currentInput: AgentInput
}

/** Outcome of a single recovery attempt. */
export type AttemptOutcome =
  | { kind: 'success'; result: RecoverySuccessResult }
  | { kind: 'failure'; error: Error; rawError: unknown }

export interface AttemptFailureContext {
  traceId: string
  error: Error
  rawError: unknown
  attempt: number
  attemptStart: number
  overallStart: number
  state: RecoveryLoopState
  task: TaskDescriptor | undefined
  effectiveTask: TaskDescriptor
  partialEvents: AgentEvent[]
}

export interface RecoveryAttemptHandlerConfig {
  maxAttempts: number
  strategyOrder: RecoveryStrategy[]
  budgetMultiplier: number
  strategySelector?: ((failure: FailureContext) => RecoveryStrategy) | undefined
  escalationHandler?: EscalationHandler | undefined
  escalationTimeoutMs?: number | undefined
}

// Re-export the failure context shape that `AttemptFailureContext` carries so
// downstream callers don't have to reach into `recovery-types.js` separately.
export type { FailureContext } from './recovery-types.js'
