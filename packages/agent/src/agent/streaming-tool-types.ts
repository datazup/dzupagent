import type { ToolMessage } from "@langchain/core/messages";
import type { DzupEventBus } from "@dzupagent/core/events";
import type { SafetyMonitor } from "@dzupagent/core/security";
import type { ToolGovernance } from "@dzupagent/core/tools";
import type { ToolPermissionPolicy } from "@dzupagent/agent-types";
import type { ToolArgValidatorConfig } from "./tool-arg-validator.js";
import type { ToolResultSecurityPolicy } from "./tool-result-security-policy.js";
import type { HumanContactRunContext } from "../tools/human-contact-invocation.js";
import type {
  ToolLoopTracer,
  ToolResultScanFailureMode,
  ToolStat,
} from "./tool-loop.js";

export interface StreamingToolExecutionResult {
  message: ToolMessage;
  eventResult: string;
  approvalPending?: boolean;
  stuckReason?: string;
  stuckRecovery?: string;
  repeatedTool?: string;
  shouldStop?: boolean;
  /** Public tool-result security policy blocked output; no next model turn. */
  securityBlocked?: boolean;
  stuckNudge?: ToolMessage;
}

export interface ToolStatTracker {
  record: (name: string, durationMs: number, error?: string) => void;
  toArray: () => ToolStat[];
}

/**
 * MJ-AGENT-02 — public policy bundle threaded by `streamRun()` into
 * `executeStreamingToolCall` so the native streaming branch enforces the
 * same governance / permission / validation / timeout / safety stack as the
 * sequential `tool-loop.ts` path.
 */
export interface StreamingToolPolicyOptions extends ToolResultSecurityPolicy {
  toolGovernance?: ToolGovernance;
  toolPermissionPolicy?: ToolPermissionPolicy;
  validateToolArgs?: boolean | ToolArgValidatorConfig;
  toolTimeouts?: Record<string, number>;
  /**
   * ORCH-DSL-L1-H-03 — deadline for tools with no `toolTimeouts` entry.
   * Defaults to `DEFAULT_TOOL_TIMEOUT_MS` (30s); `Infinity` opts out.
   */
  defaultToolTimeoutMs?: number;
  safetyMonitor?: SafetyMonitor;
  scanToolResults?: boolean;
  scanFailureMode?: ToolResultScanFailureMode;
  /**
   * MC-3 (AGENT-H-06 / SEC-M-06) — prompt-injection guardrail. Mirrors
   * `ToolLoopConfig.promptInjectionGuard` so the streaming tool path wraps a
   * successful tool result's CONTEXT content (the ToolMessage) in an
   * `<untrusted_content source="tool_result">` delimiter, matching the
   * generate() path for stream/generate parity (MJ-AGENT-02). The emitted
   * `tool_result` event payload stays raw. Defaults to an internal
   * {@link PromptInjectionGuard}; structural type avoids importing the
   * concrete class here.
   */
  promptInjectionGuard?: {
    wrap: (
      content: string,
      opts?: { label?: string; screen?: boolean; delimit?: boolean }
    ) => string;
  };
  /**
   * Disable wrapping tool results via {@link promptInjectionGuard}. Defaults
   * to `true` (wrapping ON), mirroring `ToolLoopConfig.wrapToolResults`.
   */
  wrapToolResults?: boolean;
  tracer?: ToolLoopTracer;
  agentId?: string;
  runId?: string;
  /** Run-scoped human-contact identity; exact tool-call ID is added at invoke. */
  humanContactContext?: HumanContactRunContext;
  eventBus?: DzupEventBus;
  signal?: AbortSignal;
}
