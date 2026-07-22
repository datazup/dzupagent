/**
 * Tool retry / scan-failure policy shapes for the tool loop.
 *
 * Extracted from `../types.ts` (DZUPAGENT-ARCH-M-06) so the god-module of
 * type declarations stays under the 500-LOC ceiling. The root `../types.ts`
 * barrel re-exports every symbol here unchanged — existing callers continue
 * to import from `../types.js` / `../tool-loop.js`.
 */

export type ToolResultScanFailureMode = "fail-open" | "fail-closed";

/**
 * Per-tool retry policy for transient tool execution failures (RF-09).
 *
 * Wired via {@link ToolLoopConfig.toolRetry}. All fields are optional; the
 * executor fills missing values with the documented defaults.
 *
 * The retry loop uses `calculateBackoff` from `@dzupagent/core/utils` so the
 * delay schedule matches the rest of the framework (LLM invoke retry, MCP
 * connection pool, pipeline executor).
 */
export interface ToolRetryConfig {
  /**
   * Maximum total attempts (including the first try). `1` disables retry.
   * Default: `3`.
   */
  maxAttempts?: number;
  /** Initial backoff in ms for attempt 0. Default: `200`. */
  initialBackoffMs?: number;
  /** Upper bound on backoff in ms. Default: `4000`. */
  maxBackoffMs?: number;
  /** Exponential growth factor. Default: `2`. */
  multiplier?: number;
  /** Apply equal-jitter (0.5×–1.0×). Default: `true`. */
  jitter?: boolean;
  /**
   * Custom predicate deciding whether a thrown error is retryable. When
   * omitted, the executor falls back to {@link isTransientError} from
   * `@dzupagent/core/llm` (rate-limit, overload, network heuristics).
   *
   * Note: cancellation, timeout, permission and validation errors are
   * filtered out BEFORE this predicate runs — `retryOn` is only consulted
   * for the residual "unknown error" bucket.
   */
  retryOn?: (err: Error) => boolean;
}
