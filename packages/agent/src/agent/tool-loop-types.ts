/**
 * Re-export barrel — all types live in the canonical location.
 *
 * The authoritative type declarations for the ReAct tool-calling loop were
 * extracted to `./tool-loop/types.ts` (RF-03). This file is kept as a
 * compatibility shim so any path that was ever referenced in documentation,
 * IDE history, or external consumers continues to resolve without error.
 *
 * Do NOT add new declarations here — edit `./tool-loop/types.ts` instead.
 */
export type {
  ToolStat,
  StopReason,
  ToolResultScanFailureMode,
  ToolRetryConfig,
  ToolLoopConfig,
  ToolLoopSpan,
  ToolLoopTracer,
  ToolLoopResult,
} from './tool-loop/types.js'
