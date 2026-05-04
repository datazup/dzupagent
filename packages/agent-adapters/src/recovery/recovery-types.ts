/**
 * Public types shared across the recovery subsystem.
 *
 * Extracted from `adapter-recovery.ts` so helper modules
 * (event-emitter, failure handlers, store) can reference these types
 * without importing the copilot itself (which would cause cycles).
 *
 * @module recovery/recovery-types
 */

import type { AdapterProviderId, AgentInput, TaskDescriptor } from '../types.js'

export type RecoveryStrategy =
  | 'retry-same-provider'
  | 'retry-different-provider'
  | 'increase-budget'
  | 'simplify-task'
  | 'escalate-human'
  | 'abort'

export interface FailureContext {
  /** Original input. */
  input: AgentInput
  /** Task descriptor. */
  task?: TaskDescriptor | undefined
  /** Which provider failed. */
  failedProvider: AdapterProviderId
  /** Error message. */
  error: string
  /** Error code. */
  errorCode?: string | undefined
  /** Attempt number (1-based). */
  attemptNumber: number
  /** All providers that have failed so far. */
  exhaustedProviders: AdapterProviderId[]
  /** Duration of the failed attempt. */
  durationMs: number
}

export interface RecoverySuccessResult {
  success: true
  strategy: RecoveryStrategy
  result: string
  providerId?: AdapterProviderId | undefined
  totalAttempts: number
  totalDurationMs: number
}

export interface RecoveryFailureResult {
  success: false
  strategy: RecoveryStrategy
  totalAttempts: number
  totalDurationMs: number
  error: string
  providerId?: AdapterProviderId | undefined
  cancelled?: false | undefined
}

export interface RecoveryCancelledResult {
  success: false
  cancelled: true
  strategy: 'abort'
  totalAttempts: number
  totalDurationMs: number
  error: string
  providerId?: AdapterProviderId | undefined
}

export type RecoveryResult =
  | RecoverySuccessResult
  | RecoveryFailureResult
  | RecoveryCancelledResult
