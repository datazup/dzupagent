/**
 * Types and constants for the Codex streaming loop.
 *
 * Kept separate from the loop body so callers (and tests) can reference
 * `RunStreamedThreadContext` without pulling in the full async generator.
 */
import type { AdapterConfig, AdapterProviderId, AgentInput } from '../types.js'
import type { InteractionResolver } from '../interaction/interaction-resolver.js'
import type { CodexThreadOptions } from './codex-types.js'
import type { CodexApprovalContext } from './codex-approval.js'

/** Default timeout for a single adapter call (2 minutes) */
export const DEFAULT_CODEX_TIMEOUT_MS = 120_000

/**
 * State and hooks the streaming loop needs from the adapter instance.
 *
 * The fields with `get*`/`set*` patterns let the loop read or update
 * adapter-owned mutable state (`currentSessionId`, `abortController`)
 * without holding a hard reference to the class.
 */
export interface RunStreamedThreadContext {
  providerId: AdapterProviderId
  config: AdapterConfig
  currentInput: AgentInput | undefined
  isResume: boolean
  /** Returns the current session id (may be `null` before thread.started). */
  getSessionId: () => string | null
  /** Updates the active session id when the SDK emits `thread.started`. */
  setSessionId: (sessionId: string) => void
  /** Triggers `interrupt()` semantics on timeout. */
  abort: () => void
  /** Lazily build the approval-flow context (resolver + thread-options). */
  buildApprovalContext: (input: AgentInput) => CodexApprovalContext
  /**
   * Lazily resolve the interaction policy mode for a given input.
   * Used to detect approval-pause `turn.failed` events without forcing
   * the streaming loop to know about `BaseSdkAdapter`.
   */
  isApprovalCapable: (input: AgentInput) => boolean
  /** Build thread options for approval-resume recursion. */
  buildThreadOptions: (input: AgentInput) => CodexThreadOptions
  /** Optional helper kept for parity but not currently invoked here. */
  resolver?: InteractionResolver
}
