/**
 * Agent run engine — thin composition root.
 *
 * DZUPAGENT-ARCH-M-06: the implementation was decomposed into per-concern leaf
 * modules under `./run-engine/` (mirroring the sibling `./run-engine/types.ts`
 * and the loop-executor/compiled-workflow conventions). This file re-exports the
 * EXACT public surface every consumer imported before the split, with zero
 * signature or behaviour changes:
 *
 *   - prepare-state.ts       — applySamplingOptions, prepareRunState (+ private
 *                              scanHumanMessages / extractFirstHumanMessage)
 *   - generate-run.ts        — executeGenerateRun (+ private orchestrator)
 *   - result-telemetry.ts    — applyOutputFilter, emitStopReasonTelemetry,
 *                              createToolStatTracker
 *   - streaming-tool-call.ts — executeStreamingToolCall
 */

export {
  DEFAULT_UNGUARDED_BUDGET,
  DEFAULT_GUARDED_MAX_ITERATIONS,
} from "./run-engine-defaults.js";

export {
  applySamplingOptions,
  prepareRunState,
} from "./run-engine/prepare-state.js";

export { executeGenerateRun } from "./run-engine/generate-run.js";

export {
  applyOutputFilter,
  emitStopReasonTelemetry,
  createToolStatTracker,
} from "./run-engine/result-telemetry.js";

export { executeStreamingToolCall } from "./run-engine/streaming-tool-call.js";

export type {
  StreamingToolExecutionResult,
  StreamingToolPolicyOptions,
  ToolStatTracker,
} from "./streaming-tool-types.js";

export type * from "./run-engine/types.js";
