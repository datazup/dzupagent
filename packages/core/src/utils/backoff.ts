/**
 * Canonical exponential backoff helper. Single implementation shared by:
 *   - @dzupagent/core   (LLM invoke retry loop, MCP connection pool)
 *   - @dzupagent/agent  (pipeline retry policy, skill-chain executor)
 *   - @dzupagent/codegen (pipeline executor)
 *
 * Formula: `min(initialBackoffMs * multiplier ** attempt, maxBackoffMs)`.
 * Attempt is 0-based (attempt=0 returns `initialBackoffMs`).
 *
 * When `jitter` is true a random factor between 50% and 100% of the capped
 * delay is applied — this matches the "equal jitter" shape used by AWS,
 * preventing thundering-herd retry storms while keeping an enforceable
 * minimum wait.
 */
export interface BackoffConfig {
  /** Base delay in ms for attempt 0. */
  initialBackoffMs: number
  /** Upper bound on the computed delay in ms. */
  maxBackoffMs: number
  /** Exponential growth factor. Typical values: 2 (double), 1.5 (gentle). */
  multiplier: number
  /** Apply random jitter (0.5×–1.0× of the capped delay). Default: false. */
  jitter?: boolean
}

/**
 * Compute the backoff delay for a given attempt.
 *
 * @param attempt 0-based attempt index. 0 returns the initial backoff.
 * @param config  Backoff configuration.
 * @returns Delay in milliseconds.
 */
export function calculateBackoff(attempt: number, config: BackoffConfig): number {
  const base = config.initialBackoffMs * Math.pow(config.multiplier, attempt)
  const capped = Math.min(base, config.maxBackoffMs)
  if (!config.jitter) return capped
  return capped * (0.5 + Math.random() * 0.5)
}
