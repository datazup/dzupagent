/**
 * @dzupagent/core — guardrails barrel.
 *
 * Currently exports the canonical {@link StuckDetector} used by both
 * `@dzupagent/agent` and `@dzupagent/agent-adapters`.
 */
export { StuckDetector } from './stuck-detector.js'
export type { StuckStatus, StuckDetectorConfig } from './stuck-detector.js'
