import type { DzupEventBus } from "@dzupagent/core/events";
import {
  ContentScanner,
  type PiiMode,
  type PromptInjectionMode,
} from "@dzupagent/security";
import type { SecurityConfig } from "./agent-types-security.js";

/** Internal policy slice projected from the public `security` configuration. */
export interface ToolResultSecurityPolicy {
  promptInjectionToolResults?: PromptInjectionMode;
  piiToolResults?: PiiMode;
  /** Public security policy blocks terminate the run before another model turn. */
  haltOnToolResultSecurityBlock?: boolean;
}

/**
 * Project the public security surface into the one tool-result policy consumed
 * by both the native-stream and generate/tool-loop execution paths.
 */
export function projectToolResultSecurityPolicy(
  security: SecurityConfig | undefined
): ToolResultSecurityPolicy | undefined {
  const promptInjectionToolResults = security?.promptInjectionToolResults;
  const piiToolResults = security?.piiToolResults;
  if (
    promptInjectionToolResults === undefined &&
    piiToolResults === undefined
  ) {
    return undefined;
  }

  return {
    ...(promptInjectionToolResults !== undefined
      ? { promptInjectionToolResults }
      : {}),
    ...(piiToolResults !== undefined ? { piiToolResults } : {}),
    haltOnToolResultSecurityBlock: true,
  };
}

export type ToolResultSecurityBlockReason =
  | "prompt_injection"
  | "pii"
  | "scanner_failure";

export type ToolResultSecurityScanOutcome =
  | { kind: "allow"; content: string }
  | { kind: "sanitize"; content: string }
  | {
      kind: "block";
      content: string;
      reason: ToolResultSecurityBlockReason;
      errorTag: string;
      errorMessage: string;
    };

export interface ToolResultSecurityScanContext {
  policy: ToolResultSecurityPolicy | undefined;
  eventBus?: DzupEventBus;
  agentId?: string;
  toolName: string;
}

function emitViolation(
  ctx: ToolResultSecurityScanContext,
  event: { category: string; severity: "warning" | "critical"; message: string }
): void {
  try {
    ctx.eventBus?.emit({
      type: "safety:violation",
      category: event.category,
      severity: event.severity,
      ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
      message: event.message,
    });
  } catch {
    // Security telemetry must not turn a deterministic scan disposition into
    // an event-bus-dependent one.
  }
}

/**
 * Run the shared ContentScanner over one tool result.
 *
 * Scanner exceptions are always fail-closed for this public security policy:
 * callers receive a bounded placeholder and must not schedule another model
 * turn when `haltOnToolResultSecurityBlock` is set by the public projection.
 */
export async function scanToolResultSecurity(
  content: string,
  ctx: ToolResultSecurityScanContext
): Promise<ToolResultSecurityScanOutcome> {
  const promptInjection = ctx.policy?.promptInjectionToolResults;
  const pii = ctx.policy?.piiToolResults;
  const scannerEnabled =
    (promptInjection !== undefined && promptInjection !== "off") ||
    (pii !== undefined && pii !== "off");
  if (!scannerEnabled) return { kind: "allow", content };

  try {
    const scanner = new ContentScanner({
      promptInjection: promptInjection ?? "off",
      pii: pii ?? "off",
    });
    const scan = await scanner.scan(content);

    if (scan.verdict === "block") {
      const reason: ToolResultSecurityBlockReason =
        scan.findings.length > 0 ? "prompt_injection" : "pii";
      const findingCount =
        reason === "prompt_injection"
          ? scan.findings.length
          : scan.piiTypes.length;
      emitViolation(ctx, {
        category:
          reason === "prompt_injection"
            ? "tool_result_prompt_injection"
            : "tool_result_pii",
        severity: "critical",
        message:
          reason === "prompt_injection"
            ? `Tool "${ctx.toolName}" output blocked: prompt-injection markers detected (${findingCount} finding(s))`
            : `Tool "${ctx.toolName}" output blocked: PII detected (${findingCount} type(s))`,
      });
      return reason === "prompt_injection"
        ? {
            kind: "block",
            content:
              "[blocked: tool result contained prompt-injection markers]",
            reason,
            errorTag: "prompt-injection",
            errorMessage: "Tool result blocked: prompt-injection detected",
          }
        : {
            kind: "block",
            content: "[blocked: tool result contained PII]",
            reason,
            errorTag: "pii",
            errorMessage: "Tool result blocked: PII detected",
          };
    }

    if (scan.verdict === "sanitize") {
      const category =
        scan.findings.length > 0
          ? "tool_result_prompt_injection"
          : "tool_result_pii";
      emitViolation(ctx, {
        category,
        severity: "warning",
        message:
          scan.findings.length > 0
            ? `Tool "${ctx.toolName}" output sanitized: prompt-injection markers rewritten (${scan.findings.length} finding(s))`
            : `Tool "${ctx.toolName}" output sanitized: PII redacted (${scan.piiTypes.length} type(s))`,
      });
      return { kind: "sanitize", content: scan.sanitized };
    }

    return { kind: "allow", content };
  } catch {
    emitViolation(ctx, {
      category: "tool_result_prompt_injection_scanner_failure",
      severity: "critical",
      message: "Tool result security scanner failed; output withheld",
    });
    return {
      kind: "block",
      content: "[blocked: tool result security scanner failed]",
      reason: "scanner_failure",
      errorTag: "scanner-failure",
      errorMessage: "Tool result security scanner failed; output withheld",
    };
  }
}
