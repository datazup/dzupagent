/**
 * Audit-emission concern for {@link AdapterStreamRunner}.
 *
 * Extracted from the former single-file stream-runner.ts (ARCH-M-06). The
 * runner delegates terminal LLM-invocation and per-tool-call audit emission to
 * these best-effort helpers, keeping the streaming lifecycle loop thin. All
 * emission is best-effort: sink errors are logged and swallowed so audit
 * failures cannot break the LLM call path.
 */

import type {
  LlmInvocationRecord,
  ToolCallAuditRecord,
} from "@dzupagent/core/events";
import { defaultLogger } from "@dzupagent/core/utils";
import type { AdapterProviderId, AgentEvent, TokenUsage } from "../../types.js";
import type { AdapterStreamRunnerConfig, StreamContext } from "./types.js";

function toAuditUsage(usage: TokenUsage): LlmInvocationRecord["usage"] {
  const promptTokens = usage.inputTokens;
  const completionTokens = usage.outputTokens;
  const out: NonNullable<LlmInvocationRecord["usage"]> = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(usage.cachedInputTokens !== undefined
      ? { cacheReadTokens: usage.cachedInputTokens }
      : {}),
    ...(usage.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: usage.cacheWriteTokens }
      : {}),
  };
  return out;
}

function resolveModelFromExtras(
  config: AdapterStreamRunnerConfig
): string | undefined {
  const extra = config.startedExtra;
  if (extra && typeof extra["model"] === "string") return extra["model"];
  return undefined;
}

/**
 * Build and dispatch a {@link LlmInvocationRecord} to the configured
 * `auditSink`. Best-effort: any sink-side error is logged and swallowed so
 * audit failures cannot break the LLM call path.
 *
 * Note: this is the streaming-runner audit emission site. Adapters with
 * non-streaming convenience methods must emit their own equivalent record
 * when they do not flow through this runner.
 */
export function emitAudit(
  config: AdapterStreamRunnerConfig,
  providerId: AdapterProviderId,
  context: StreamContext,
  terminal: AgentEvent,
  startedAt: string
): void {
  const sink = config.auditSink;
  if (!sink) return;
  if (
    terminal.type !== "adapter:completed" &&
    terminal.type !== "adapter:failed"
  )
    return;
  try {
    const durationMs =
      terminal.type === "adapter:completed"
        ? terminal.durationMs
        : Math.max(0, Date.now() - context.startedAt);
    const usage =
      terminal.type === "adapter:completed" && terminal.usage
        ? toAuditUsage(terminal.usage)
        : undefined;
    const costCents =
      terminal.type === "adapter:completed" &&
      terminal.usage?.costCents !== undefined
        ? terminal.usage.costCents
        : undefined;
    const errorCode =
      terminal.type === "adapter:failed"
        ? terminal.code ?? "ADAPTER_EXECUTION_FAILED"
        : undefined;

    const record: LlmInvocationRecord = {
      providerId,
      model: config.auditModel ?? resolveModelFromExtras(config) ?? "unknown",
      promptCharCount: context.input.prompt.length,
      ...(context.input.systemPrompt !== undefined
        ? { systemPromptCharCount: context.input.systemPrompt.length }
        : {}),
      status: terminal.type === "adapter:completed" ? "completed" : "failed",
      ...(errorCode !== undefined ? { errorCode } : {}),
      durationMs,
      ...(usage !== undefined ? { usage } : {}),
      ...(costCents !== undefined ? { costCents } : {}),
      startedAt,
      ...(config.auditRunId !== undefined ? { runId: config.auditRunId } : {}),
      ...(config.auditTenantId !== undefined
        ? { tenantId: config.auditTenantId }
        : {}),
    };
    sink(record);
  } catch (err: unknown) {
    // Best-effort: never break the LLM call because of audit emission.
    const msg = err instanceof Error ? err.message : String(err);
    defaultLogger.warn("[AdapterStreamRunner] audit sink failed:", msg);
  }
}

/**
 * Emit a {@link ToolCallAuditRecord} to the configured sink.
 * Best-effort: any sink error is logged and swallowed.
 */
export function emitToolCallAudit(
  config: AdapterStreamRunnerConfig,
  record: ToolCallAuditRecord
): void {
  const sink = config.toolCallAuditSink;
  if (!sink) return;
  try {
    sink(record);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    defaultLogger.warn("[AdapterStreamRunner] toolCallAuditSink failed:", msg);
  }
}

/**
 * Decide whether a non-throwing `adapter:tool_result` event represents a
 * failed tool invocation. Prefers the explicit `isError` marker on the event;
 * falls back to the well-known `MCP_TOOL_FAILED:` output prefix that some
 * normalizers (e.g. Codex) emit when a provider reports a failed tool status.
 */
export function isToolResultError(ev: AgentEvent): boolean {
  if (ev.type !== "adapter:tool_result") return false;
  if (ev.isError === true) return true;
  return (
    typeof ev.output === "string" && ev.output.startsWith("MCP_TOOL_FAILED:")
  );
}

/**
 * Derive a short, opaque identifier from tool arguments.
 * Truncates the JSON representation to 64 characters so audit records
 * remain compact without leaking full payload content.
 */
export function hashArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args) ?? "";
    return json.length > 64 ? `${json.slice(0, 61)}...` : json;
  } catch {
    return "<non-serializable>";
  }
}
