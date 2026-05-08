/**
 * Streaming tool-call helpers extracted from {@link executeStreamingToolCall}
 * (RF-19 / CODE-02).
 *
 * MC-013 split this barrel into three focused modules:
 *   - `stream-budget-gate.ts`     — pre-execution gate (permission /
 *                                    budget block / governance / lookup)
 *   - `stream-tool-phase.ts`      — validate, invoke, scan, emit result
 *   - `stream-result-helpers.ts`  — latency telemetry + success / failure
 *                                    StreamingToolExecutionResult builders
 *
 * This file is preserved as a barrel so existing callers and the dedicated
 * unit-test suite (`__tests__/run-engine-streaming-helpers.test.ts`) keep
 * working unchanged.
 */
export type { BudgetDecision } from './stream-budget-gate.js'
export { applyBudgetGate } from './stream-budget-gate.js'

export type { StreamPhaseResult } from './stream-tool-phase.js'
export { runToolStreamingPhase } from './stream-tool-phase.js'

export {
  buildSuccessResult,
  handleInvocationFailure,
  recordToolLatencyOutcome,
} from './stream-result-helpers.js'
