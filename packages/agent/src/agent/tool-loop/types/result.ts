/**
 * Result / stop-reason / per-tool-stat shapes for the tool loop.
 *
 * Extracted from `../types.ts` (DZUPAGENT-ARCH-M-06) so the god-module of
 * type declarations stays under the 500-LOC ceiling. The root `../types.ts`
 * barrel re-exports every symbol here unchanged — existing callers continue
 * to import from `../types.js` / `../tool-loop.js`.
 */
import type { BaseMessage } from "@langchain/core/messages";
import type { StuckError } from "../../stuck-error.js";

/** Per-tool execution statistics. */
export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  totalMs: number;
  avgMs: number;
}

/** Why the tool loop stopped. */
export type StopReason =
  | "complete"
  | "iteration_limit"
  | "budget_exceeded"
  | "aborted"
  | "error"
  | "stuck"
  | "token_exhausted"
  /**
   * AGENT-112: the loop terminated because context compression failed on two
   * consecutive turns. Continuing would only burn budget on LLM calls that
   * cannot fit the (un-compressible) history, so the loop aborts cleanly.
   */
  | "compression_failed"
  /**
   * The loop halted because an approval-required tool was scheduled. The
   * tool was NOT executed; an `approval:requested` event was emitted to the
   * configured event bus carrying the durable runId. Resume of the
   * suspended call is handled by an external mechanism (typically
   * `ApprovalGate` listening for `approval:granted` / `approval:rejected`
   * and re-driving the run via the resume path) — the loop itself does not
   * implement resumption.
   */
  | "approval_pending";

export interface ToolLoopResult {
  messages: BaseMessage[];
  totalInputTokens: number;
  totalOutputTokens: number;
  llmCalls: number;
  /** @deprecated Use `stopReason` instead. Kept for backward compatibility. */
  hitIterationLimit: boolean;
  /** Why the tool loop terminated. */
  stopReason: StopReason;
  /** Per-tool execution statistics (latency, error counts). */
  toolStats: ToolStat[];
  /**
   * When `stopReason` is `'stuck'`, contains the structured StuckError
   * with reason, repeatedTool, and escalationLevel.
   */
  stuckError?: StuckError;
}
