/**
 * Type and interface declarations for the tool loop.
 *
 * Extracted from `../tool-loop.ts` (RF-03) so the staged helpers in this
 * directory can depend on the shared shapes without forming an import cycle
 * back through the loop entrypoint.
 *
 * `tool-loop.ts` re-exports every symbol declared here for backward
 * compatibility — existing callers continue to import from
 * `../tool-loop.js`.
 *
 * DZUPAGENT-ARCH-M-06: the inline declarations were decomposed into
 * per-concern leaf modules under `./types/` to keep every file under the
 * 500-LOC ceiling. This root stays a thin barrel re-exporting the EXACT
 * public surface unchanged — `./types.js` remains the single import path.
 */
export type { ToolLoopSpan, ToolLoopTracer } from "./types/tracer.js";
export type {
  ToolResultScanFailureMode,
  ToolRetryConfig,
} from "./types/retry.js";
export type { ToolStat, StopReason, ToolLoopResult } from "./types/result.js";
export type { ToolLoopConfig } from "./types/config.js";
