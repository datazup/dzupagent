/**
 * AGENT-H-06 / SEC-M-06 / DZUPAGENT-AGENT-C-22 — the single canonical
 * implementation of tool-result fencing.
 *
 * Tool output is attacker-controllable. Before it enters a model's message
 * history it must be presented as quoted external data rather than as
 * authoritative instruction, so an injection payload embedded in a tool
 * result cannot steer the model.
 *
 * This module exists because that rule was previously implemented four
 * separate times — in the canonical tool loop's success path, in its error
 * path, in the MCP tool bridge, and (not at all) in the sub-agent spawner.
 * Divergent copies are how a hardened path silently becomes an unhardened
 * one. Every caller that puts tool output in front of a model MUST route
 * through {@link fenceToolResult}; do not re-inline a `guard.wrap(...)` call.
 *
 * @module @dzupagent/security/guardrails/tool-result-fence
 */
import { PromptInjectionGuard } from "./prompt-injection-guard.js";

/**
 * Provenance label applied to fenced tool output. Kept as a named constant
 * so every call site agrees on the string the model is trained to read.
 */
export const TOOL_RESULT_LABEL = "tool_result";

/**
 * Process-wide default guard. {@link PromptInjectionGuard} is stateless, so a
 * single shared instance is safe and avoids a per-tool-call allocation.
 */
const DEFAULT_TOOL_RESULT_GUARD = new PromptInjectionGuard();

/**
 * Minimal structural contract a custom guard must satisfy. Deliberately
 * structural rather than `PromptInjectionGuard` so hosts that already type
 * their guard slot loosely (e.g. the streaming tool path) can pass it
 * straight through without a cast.
 */
export interface ToolResultGuardLike {
  wrap(
    content: string,
    opts?: { label?: string; screen?: boolean; delimit?: boolean }
  ): string;
}

/** Options accepted by {@link fenceToolResult}. */
export interface FenceToolResultOptions {
  /**
   * Caller-supplied guard. Defaults to a shared stateless instance. Provided
   * so a host can install a guard with a wider injection-pattern library
   * without forking the fencing logic itself.
   */
  guard?: ToolResultGuardLike;
  /**
   * Escape hatch mirroring `ToolLoopConfig.wrapToolResults`. When explicitly
   * `false`, the raw text is returned unfenced.
   *
   * This exists only for hosts that supply their own envelope. It is
   * deliberately opt-OUT (undefined means fence), so a caller that forgets to
   * pass anything gets the safe behaviour.
   */
  enabled?: boolean;
}

/**
 * Wrap model-visible tool output in the labelled
 * `<untrusted_content source="tool_result">` block.
 *
 * Safe on any input: non-string values are coerced, and forged opening or
 * closing delimiters inside `text` are defanged by the guard's boundary
 * neutralizer, so a payload cannot close the block early and have trailing
 * text read as authoritative.
 *
 * Fencing is idempotent-harmless — double-wrapping degrades readability but
 * never weakens the boundary — so it is safe to call on a value that may
 * already have passed through another fenced path.
 *
 * @param text  Raw, untrusted tool output.
 * @param opts  See {@link FenceToolResultOptions}.
 * @returns The fenced string, or `text` verbatim when `enabled === false`.
 */
export function fenceToolResult(
  text: string,
  opts: FenceToolResultOptions = {}
): string {
  if (opts.enabled === false) {
    return typeof text === "string" ? text : String(text ?? "");
  }
  return (opts.guard ?? DEFAULT_TOOL_RESULT_GUARD).wrap(text, {
    label: TOOL_RESULT_LABEL,
  });
}

/**
 * Fence a tool *error* message. Thrown error messages are just as
 * attacker-controllable as successful output — a tool that echoes remote
 * content into `error.message` is a live injection vector — so the error
 * path fences through the same primitive as the success path.
 *
 * Only the MODEL-VISIBLE text is fenced. Callers must keep the RAW error
 * string for observability (events, spans, latency callbacks), matching the
 * canonical loop's raw-telemetry contract.
 *
 * @param toolName Name of the tool that failed, interpolated into the message.
 * @param errorMsg Raw error text.
 * @param opts     See {@link FenceToolResultOptions}.
 */
export function fenceToolError(
  toolName: string,
  errorMsg: string,
  opts: FenceToolResultOptions = {}
): string {
  return fenceToolResult(
    `Error executing tool "${toolName}": ${errorMsg}`,
    opts
  );
}
