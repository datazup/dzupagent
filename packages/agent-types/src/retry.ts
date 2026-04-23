/**
 * Canonical retry policy shape. Single source of truth — any package in the
 * DzupAgent framework that needs a retry/backoff configuration must import
 * this type rather than re-declaring its own.
 *
 * Historically three packages (@dzupagent/core, @dzupagent/agent) each defined
 * their own `RetryPolicy`/`RetryConfig` with slightly diverging field names
 * (`multiplier` vs `backoffMultiplier`, `jitter: boolean` vs
 * `jitter: { min; max }`). Those have been unified here.
 */
export interface RetryPolicy {
  /** Maximum number of attempts (including the first). Default varies per call site. */
  maxAttempts?: number
  /** Initial backoff delay in milliseconds before the first retry. */
  initialBackoffMs: number
  /** Upper bound on backoff delay in milliseconds. */
  maxBackoffMs: number
  /** Exponential backoff multiplier applied per attempt. */
  multiplier: number
  /**
   * Alias for `multiplier` — present for backward compatibility with
   * pipeline-runtime-types which used `backoffMultiplier`. Consumers should
   * prefer `multiplier`; if both are set, `multiplier` wins.
   */
  backoffMultiplier?: number
  /**
   * Jitter configuration. Either a boolean (true = apply ±50% jitter) or an
   * explicit range expressed as a fractional multiplier band, e.g.
   * `{ min: 0.5, max: 1.0 }` means "between 50% and 100% of the computed delay".
   */
  jitter?: boolean | { min: number; max: number }
  /**
   * Optional predicate. Returning `false` aborts the retry loop, returning
   * `true` (or an undefined predicate) allows another attempt.
   */
  shouldRetry?: (err: unknown) => boolean
}
