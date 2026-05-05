/**
 * Stuck detector — re-exported from `@dzupagent/core`.
 *
 * The canonical implementation now lives at
 * `@dzupagent/core/guardrails/stuck-detector` so that `@dzupagent/agent` and
 * `@dzupagent/agent-adapters` share one source of truth (RF-11). This module
 * is preserved as a thin re-export to keep all historical import paths
 * (`@dzupagent/agent/guardrails/stuck-detector`, top-level
 * `@dzupagent/agent`) working unchanged.
 */
export { StuckDetector } from '@dzupagent/core'
export type { StuckStatus, StuckDetectorConfig } from '@dzupagent/core'
