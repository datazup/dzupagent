/**
 * Canonical exponential backoff helper. Single implementation shared by:
 *   - @dzupagent/core   (LLM invoke retry loop, MCP connection pool)
 *   - @dzupagent/agent  (pipeline retry policy, skill-chain executor)
 *   - @dzupagent/codegen (pipeline executor)
 *
 * Formula: `min(initialBackoffMs * multiplier ** attempt, maxBackoffMs)`.
 * Attempt is 0-based (attempt=0 returns `initialBackoffMs`).
 *
 * When `jitter` is true the distribution is selected by `jitterMode`
 * (ARCH27-T-13 candidate 3 — one enum instead of per-consumer copies):
 *   - `'equal'` (default): 50%–100% of the capped delay — the AWS "equal
 *     jitter" shape; never exceeds `maxBackoffMs`.
 *   - `'additive'`: capped delay plus 0–50% proportional noise, rounded to a
 *     whole millisecond — the agent pipeline retry-policy's historical shape.
 *     May exceed `maxBackoffMs` by up to 50%, by design.
 *   - `'centered'`: 80%–120% of the capped delay — the skill-chain executor's
 *     historical ±20% band. May exceed `maxBackoffMs` by up to 20%, by design.
 */
export type BackoffJitterMode = "equal" | "additive" | "centered";

export interface BackoffConfig {
  /** Base delay in ms for attempt 0. */
  initialBackoffMs: number;
  /** Upper bound on the computed delay in ms. */
  maxBackoffMs: number;
  /** Exponential growth factor. Typical values: 2 (double), 1.5 (gentle). */
  multiplier: number;
  /** Apply random jitter (distribution per `jitterMode`). Default: false. */
  jitter?: boolean;
  /**
   * Jitter distribution used when `jitter` is true (ignored otherwise).
   * Default: `'equal'`. See the module doc for the exact shapes.
   */
  jitterMode?: BackoffJitterMode;
  /**
   * Random sample source for jitter. Samples must be finite and in the
   * inclusive range [0, 1]. Defaults to `Math.random`.
   */
  random?: () => number;
}

const INVALID_ATTEMPT_MESSAGE = "attempt must be a non-negative safe integer";
const INVALID_CONFIG_MESSAGE = "config must be an object";
const INVALID_RANDOM_MESSAGE =
  "random must return a finite number in the inclusive range [0, 1]";
const INVALID_JITTER_MODE_MESSAGE =
  "jitterMode must be 'equal', 'additive', or 'centered'";

function requireFiniteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }

  // Normalize negative zero so every successful result is observably
  // non-negative as well as mathematically non-negative.
  return value === 0 ? 0 : value;
}

/**
 * Compute the backoff delay for a given attempt.
 *
 * @param attempt Finite non-negative safe integer. The index is 0-based.
 * @param config Backoff configuration with finite non-negative numeric fields.
 * @returns A finite delay from zero through `maxBackoffMs`, inclusive.
 * @throws {RangeError} If the attempt, numeric fields, or random sample is invalid.
 * @throws {TypeError} If the runtime config or jitter random source has an invalid type.
 */
export function calculateBackoff(
  attempt: number,
  config: BackoffConfig,
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new RangeError(INVALID_ATTEMPT_MESSAGE);
  }
  if (typeof config !== "object" || config === null) {
    throw new TypeError(INVALID_CONFIG_MESSAGE);
  }

  const initialBackoffMs = requireFiniteNonNegative(
    config.initialBackoffMs,
    "initialBackoffMs",
  );
  const maxBackoffMs = requireFiniteNonNegative(
    config.maxBackoffMs,
    "maxBackoffMs",
  );
  const multiplier = requireFiniteNonNegative(config.multiplier, "multiplier");

  // Guard zero before exponentiation can overflow: 0 * Infinity is NaN even
  // though a zero initial delay must remain zero for every attempt.
  const base =
    initialBackoffMs === 0
      ? 0
      : initialBackoffMs * Math.pow(multiplier, attempt);
  const capped =
    !Number.isFinite(base) || base >= maxBackoffMs ? maxBackoffMs : base;

  if (!config.jitter) return capped;

  const random = config.random ?? Math.random;
  if (typeof random !== "function") {
    throw new TypeError("random must be a function when jitter is enabled");
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new RangeError(INVALID_RANDOM_MESSAGE);
  }

  switch (config.jitterMode ?? "equal") {
    case "equal":
      return capped * (0.5 + sample * 0.5);
    case "additive":
      // Historical agent pipeline retry-policy shape: 0–50% proportional
      // noise ABOVE the capped delay, rounded to a whole millisecond.
      return Math.round(capped + capped * (sample * 0.5));
    case "centered":
      // Historical skill-chain executor shape: uniform ±20% band around the
      // capped delay, unrounded.
      return capped * (0.8 + sample * 0.4);
    default:
      throw new TypeError(INVALID_JITTER_MODE_MESSAGE);
  }
}
