/**
 * Shared guardrail type primitives.
 *
 * These types are consumed by both `@dzupagent/agent` and
 * `@dzupagent/agent-adapters` to avoid duplicate, drift-prone definitions.
 *
 * This module is Layer 0: it MUST NOT import from any other @dzupagent package.
 */

/**
 * Configuration for stuck-loop detection in agent execution.
 *
 * A "stuck" agent is one that is not making progress: repeatedly invoking
 * the same tool with identical input, piling up errors within a rolling
 * window, or producing no tool calls for several iterations in a row.
 *
 * All fields are optional; implementations should apply their own defaults
 * (commonly: `maxRepeatCalls=3`, `maxErrorsInWindow=5`, `errorWindowMs=60_000`,
 * `maxIdleIterations=3`).
 */
export interface StuckDetectorConfig {
  /** Max identical sequential tool calls before flagging (default: 3) */
  maxRepeatCalls?: number
  /** Max errors within {@link errorWindowMs} before flagging (default: 5) */
  maxErrorsInWindow?: number
  /** Rolling error window in milliseconds (default: 60_000) */
  errorWindowMs?: number
  /** Max consecutive iterations with no tool calls before flagging (default: 3) */
  maxIdleIterations?: number
}
