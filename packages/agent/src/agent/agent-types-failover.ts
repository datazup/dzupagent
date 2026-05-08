/**
 * Provider failover/retry policy types for {@link DzupAgentConfig}.
 *
 * Extracted from the original `agent-types.ts` barrel — see that file for the
 * authoritative re-exports.
 */

/** Explicit run-level provider retry/failover policy. */
export interface ProviderFailoverPolicy {
  /** Enable invocation-time retry/failover. Defaults to false. */
  enabled?: boolean
  /**
   * Maximum provider attempts for one model turn. Defaults to 2 when enabled.
   * The value is capped by the number of selectable providers.
   */
  maxAttempts?: number
  /**
   * Retry after tool results are already present in the transcript.
   * Defaults to false to avoid duplicating side-effecting tool work.
   */
  allowRetryAfterToolResults?: boolean
  /**
   * Optional retry classifier. Defaults to the core transient-error detector.
   * Return false to surface the error without trying another provider.
   */
  shouldRetry?: (error: Error) => boolean
}
