/**
 * Core streaming tool-invocation phase (RF-19 / CODE-02 / MC-013).
 *
 * Extracted from `run-engine-streaming-helpers.ts` so the validation,
 * invocation (with timeout + abort), safety / prompt-injection scans,
 * and lifecycle-event emission for a single tool call live in their
 * own module. Behaviour is unchanged.
 */
import { ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { omitUndefined } from "../utils/exact-optional.js";
import {
  emitToolCalled,
  emitToolCancellationRequested,
  emitToolError,
  emitToolResult,
  extractInputMetadataKeys,
  invokeWithOptionalTimeout,
  maybeValidateArgs,
  resolveValidatorConfig,
} from "./tool-lifecycle-policy.js";
import { recordToolLatencyOutcome } from "./stream-result-helpers.js";
import { resolveToolTimeoutMs } from "./run-engine-defaults.js";
import type {
  StreamingToolPolicyOptions,
  ToolStatTracker,
} from "./streaming-tool-types.js";
import type {
  StreamPhaseResult,
  StreamingToolCall,
} from "./run-engine/types.js";
import { scanToolResultSecurity } from "./tool-result-security-policy.js";

export type { StreamPhaseResult } from "./run-engine/types.js";

/**
 * Outcome of {@link runToolStreamingPhase}: either a short-circuit (validation
 * error / safety block / prompt-injection block / scanner failure when
 * fail-closed) that the orchestrator must surface verbatim, or a successful
 * invocation with the transformed result and metadata required for
 * stuck-detection and final ToolMessage construction.
 */
/**
 * Validate args, invoke the tool (with timeout + abort signal), run safety
 * and prompt-injection scans on the result, and emit lifecycle events.
 *
 * Mirrors lines 849-1107 of the original `executeStreamingToolCall`.
 *
 * Throws unhandled tool-invocation errors so the orchestrator's outer
 * try/catch can apply error-path stuck detection and emit the same
 * `tool:error` / OTel attributes as before extraction.
 */
export async function runToolStreamingPhase(args: {
  toolCall: StreamingToolCall;
  toolCallId: string;
  toolName: string;
  inputMetadataKeys: string[];
  tool: StructuredToolInterface;
  transformToolResult: (
    toolName: string,
    input: Record<string, unknown>,
    result: string
  ) => Promise<string>;
  statTracker: ToolStatTracker;
  onToolLatency?: (name: string, durationMs: number, error?: string) => void;
  signal?: AbortSignal;
  policy?: StreamingToolPolicyOptions;
  startMs: number;
}): Promise<StreamPhaseResult> {
  const {
    toolCall,
    toolCallId,
    toolName,
    inputMetadataKeys,
    tool,
    transformToolResult,
    statTracker,
    onToolLatency,
    signal,
    policy,
    startMs,
  } = args;

  // Argument validation (mirrors tool-loop.ts ~1056-1078).
  const validatorCfg = resolveValidatorConfig(policy?.validateToolArgs);
  const { args: validatedArgs, validationError } = maybeValidateArgs(
    toolCall,
    tool,
    validatorCfg
  );

  if (validationError) {
    emitToolError(policy, {
      toolName,
      toolCallId,
      durationMs: 0,
      inputMetadataKeys,
      errorCode: "VALIDATION_FAILED",
      errorMessage: validationError,
      status: "error",
    });
    return {
      kind: "short-circuit",
      result: {
        message: new ToolMessage({
          content: validationError,
          tool_call_id: toolCallId,
          name: toolName,
        }),
        eventResult: "[validation error]",
      },
    };
  }

  const validatedKeys = extractInputMetadataKeys(validatedArgs);

  emitToolCalled(policy, {
    toolName,
    toolCallId,
    input: validatedArgs,
    inputMetadataKeys: validatedKeys,
  });

  // Optional OTel span per tool invocation (mirrors tool-loop.ts ~1106).
  const inputSize = JSON.stringify(validatedArgs).length;
  const span = policy?.tracer?.startToolSpan(toolName, { inputSize });

  let rawResult: string;
  let transformedResult: string;
  // ORCH-DSL-L1-H-03 — the streaming path shares the generate path's default
  // so an unlisted tool is bounded here too. Resolved once so the deadline and
  // the reported `timeoutMs` cannot disagree.
  const timeoutMs = resolveToolTimeoutMs(
    policy?.toolTimeouts,
    toolName,
    policy?.defaultToolTimeoutMs
  );
  try {
    const result = await invokeWithOptionalTimeout(
      toolName,
      timeoutMs,
      ({ signal: invocationSignal }) =>
        tool.invoke(validatedArgs, { signal: invocationSignal }),
      omitUndefined({
        signal: policy?.signal ?? signal,
        onCancelRequested: (reason: "timeout" | "run_cancelled") =>
          emitToolCancellationRequested(policy, {
            toolName,
            toolCallId,
            inputMetadataKeys: validatedKeys,
            reason,
            ...(reason === "timeout" && timeoutMs !== undefined
              ? { timeoutMs }
              : {}),
          }),
      })
    );
    rawResult = typeof result === "string" ? result : JSON.stringify(result);
    transformedResult = await transformToolResult(
      toolName,
      validatedArgs,
      rawResult
    );
  } catch (invocationError: unknown) {
    // Surface validatedKeys + active span to the orchestrator so the
    // outer catch block can call `emitToolError`, `endSpanWithError`,
    // and stuck-detection with the SAME observable order as the
    // pre-extraction code path.
    if (span) {
      try {
        const durationMs = Date.now() - startMs;
        span.setAttribute("durationMs", durationMs);
        policy?.tracer?.endSpanWithError(span, invocationError);
      } catch {
        // Tracer failures must not abort the streaming loop
      }
    }
    throw Object.assign(
      invocationError instanceof Error
        ? invocationError
        : new Error(String(invocationError)),
      { __dzupValidatedKeys: validatedKeys, __dzupSpanEnded: true }
    );
  }

  // Safety scan (mirrors tool-loop.ts ~1119-1170).
  if (policy?.safetyMonitor && policy.scanToolResults !== false) {
    try {
      const violations = policy.safetyMonitor.scanContent(transformedResult, {
        source: "tool:result",
        toolName,
      });
      const hardBlock = violations.find(
        (v) =>
          v.action === "block" ||
          v.action === "kill" ||
          v.severity === "critical"
      );
      if (hardBlock) {
        const blockedContent = `[blocked] Tool result contained potentially unsafe content (${hardBlock.category}): ${hardBlock.message}`;
        transformedResult = blockedContent;
        const durationMs = recordToolLatencyOutcome(
          omitUndefined({
            statTracker,
            onToolLatency,
            toolName,
            startMs,
            errorTag: "unsafe-result",
          })
        );
        emitToolError(policy, {
          toolName,
          toolCallId,
          durationMs,
          inputMetadataKeys: validatedKeys,
          errorCode: "TOOL_EXECUTION_FAILED",
          errorMessage: `Tool result blocked: ${hardBlock.category} — ${hardBlock.message}`,
          status: "denied",
        });
        if (span) {
          try {
            span.setAttribute("durationMs", durationMs);
            span.setAttribute("outputSize", blockedContent.length);
            span.setAttribute("blocked", true);
            span.end();
          } catch {
            // Tracer failures must not abort the streaming loop
          }
        }
        return {
          kind: "short-circuit",
          result: {
            message: new ToolMessage({
              content: blockedContent,
              tool_call_id: toolCallId,
              name: toolName,
            }),
            eventResult: "[blocked: unsafe tool output]",
          },
        };
      }
    } catch {
      // RF-11 / DZUPAGENT-AGENT-M-01 — resolve the effective failure mode once.
      // A bare DzupAgent (no explicit `scanFailureMode`) is fail-closed: a
      // crashing scanner must NOT silently leak tool output. `fail-open`
      // remains available only as an explicit, opt-in legacy override.
      const effectiveMode = policy.scanFailureMode ?? "fail-closed";
      policy.eventBus?.emit({
        type: "safety:violation",
        category: "tool_result_scanner_failure",
        severity: effectiveMode === "fail-closed" ? "critical" : "warning",
        ...(policy.agentId !== undefined ? { agentId: policy.agentId } : {}),
        message: "Tool result safety scanner failed",
      });

      if (effectiveMode === "fail-closed") {
        const blockedContent = "[blocked: tool result safety scanner failed]";
        const durationMs = recordToolLatencyOutcome(
          omitUndefined({
            statTracker,
            onToolLatency,
            toolName,
            startMs,
            errorTag: "scanner-failure",
          })
        );
        emitToolError(policy, {
          toolName,
          toolCallId,
          durationMs,
          inputMetadataKeys: validatedKeys,
          errorCode: "TOOL_EXECUTION_FAILED",
          errorMessage: "Tool result safety scanner failed; output withheld",
          status: "error",
        });
        if (span) {
          try {
            span.setAttribute("durationMs", durationMs);
            span.setAttribute("scannerFailure", true);
            span.end();
          } catch {
            // Tracer failures must not abort the streaming loop
          }
        }
        return {
          kind: "short-circuit",
          result: {
            message: new ToolMessage({
              content: blockedContent,
              tool_call_id: toolCallId,
              name: toolName,
            }),
            eventResult: blockedContent,
          },
        };
      }
    }
  }

  // RF-15 — shared prompt-injection + PII scan used by both native stream
  // and the generate/tool-loop path. Public policy blocks halt before the
  // next model turn; direct internal callers keep the historical placeholder
  // behavior unless they explicitly set the halt flag.
  const resultSecurity = await scanToolResultSecurity(transformedResult, {
    policy,
    ...(policy?.eventBus !== undefined ? { eventBus: policy.eventBus } : {}),
    ...(policy?.agentId !== undefined ? { agentId: policy.agentId } : {}),
    toolName,
  });
  if (resultSecurity.kind === "block") {
    const durationMs = recordToolLatencyOutcome(
      omitUndefined({
        statTracker,
        onToolLatency,
        toolName,
        startMs,
        errorTag: resultSecurity.errorTag,
      })
    );
    emitToolError(policy, {
      toolName,
      toolCallId,
      durationMs,
      inputMetadataKeys: validatedKeys,
      errorCode: "TOOL_EXECUTION_FAILED",
      errorMessage: resultSecurity.errorMessage,
      status: resultSecurity.reason === "scanner_failure" ? "error" : "denied",
    });
    if (span) {
      try {
        span.setAttribute("durationMs", durationMs);
        span.setAttribute("outputSize", resultSecurity.content.length);
        span.setAttribute("blocked", true);
        span.setAttribute("blockReason", resultSecurity.reason);
        span.end();
      } catch {
        // Tracer failures must not abort the streaming loop
      }
    }
    return {
      kind: "short-circuit",
      result: {
        message: new ToolMessage({
          content: resultSecurity.content,
          tool_call_id: toolCallId,
          name: toolName,
        }),
        eventResult: resultSecurity.content,
        ...(policy?.haltOnToolResultSecurityBlock === true
          ? { securityBlocked: true }
          : {}),
      },
    };
  }
  if (resultSecurity.kind === "sanitize") {
    transformedResult = resultSecurity.content;
  }

  // Successful path: record latency, emit `tool:result`, end span.
  const durationMs = recordToolLatencyOutcome(
    omitUndefined({
      statTracker,
      onToolLatency,
      toolName,
      startMs,
    })
  );

  emitToolResult(policy, {
    toolName,
    toolCallId,
    durationMs,
    inputMetadataKeys: validatedKeys,
    output: transformedResult,
  });
  if (span) {
    try {
      span.setAttribute("durationMs", durationMs);
      span.setAttribute("outputSize", transformedResult.length);
      span.end();
    } catch {
      // Tracer failures must not abort the streaming loop
    }
  }

  return {
    kind: "success",
    transformedResult,
    validatedArgs,
    validatedKeys,
  };
}
