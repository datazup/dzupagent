/**
 * Unified tool governance layer for DzupAgent.
 * Enforces access control, rate limits, and audit logging for tool invocations.
 */
import { defaultLogger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolGovernanceConfig {
  /** Tools that are always blocked */
  blockedTools?: string[];
  /** Tools that require approval before execution */
  approvalRequired?: string[];
  /** Per-tool rate limits (max calls per minute) */
  rateLimits?: Record<string, number>;
  /** Maximum execution time per tool call in ms */
  maxExecutionMs?: number;
  /** Custom validation function */
  validator?: (toolName: string, input: unknown) => ToolValidationResult;
  /** Audit handler for logging tool usage */
  auditHandler?: ToolAuditHandler;
  /**
   * Controls what `auditResult()` forwards as `ToolResultAuditEntry.output`.
   *
   * Defaults to `raw` for backwards compatibility. Use `metadata-only` when
   * audit sinks should receive shape information without the tool result value,
   * or `redacted` when a redacted placeholder/value should be retained.
   */
  resultAuditRetention?: ToolResultAuditRetention;
  /** Optional redactor used when `resultAuditRetention` is `redacted`. */
  resultAuditRedactor?: (
    output: unknown,
    entry: ToolResultAuditEntry,
  ) => unknown;
}

export type ToolResultAuditRetention = "raw" | "metadata-only" | "redacted";

export interface ToolValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Audit-sink callbacks return plain `void`, deliberately — not
 * `void | Promise<void>`.
 *
 * TypeScript's void-returning-function leniency lets a callback that returns a
 * value satisfy a `=> void` position, so
 * `{ onToolCall: (entry) => calls.push(entry) }` type-checks even though `push`
 * returns `number`. That leniency does not survive a union: under
 * `=> void | Promise<void>` the same expression is rejected with TS2322
 * ("Type 'number' is not assignable to type 'void | Promise<void>'"), so the
 * union an audit-sink author reads as *more* permissive is strictly *less*
 * permissive.
 *
 * `void` still accepts `async` sinks — a `Promise<void>` return is assignable
 * to a `void` return position — and `ToolGovernance` widens the returned value
 * to `unknown` so it still awaits (and therefore still catches rejections
 * from) whatever the sink actually returned.
 */
export interface ToolAuditHandler {
  onToolCall(entry: ToolAuditEntry): void;
  onToolResult?(entry: ToolResultAuditEntry): void;
}

export interface ToolAuditEntry {
  toolName: string;
  /** @deprecated Raw input values are not recorded by default. Use inputMetadataKeys. */
  input: unknown;
  inputMetadataKeys?: string[];
  callerAgent: string;
  timestamp: number;
  allowed: boolean;
  blockedReason?: string;
}

export interface ToolResultAuditEntry {
  toolName: string;
  output: unknown;
  outputMetadata?: ToolResultAuditMetadata;
  resultAuditRetention?: ToolResultAuditRetention;
  callerAgent: string;
  durationMs: number;
  success: boolean;
  timestamp: number;
}

export interface ToolResultAuditMetadata {
  outputType: string;
  outputKeys?: string[];
  outputLength?: number;
}

export interface ToolAccessResult {
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Reusable tool governance layer.
 * Can be used by both @dzupagent/agent and @dzupagent/agent-adapters.
 */
export class ToolGovernance {
  private readonly rateCounts = new Map<
    string,
    { count: number; windowStart: number }
  >();

  constructor(private readonly config: ToolGovernanceConfig = {}) {}

  /** Check if a tool call is allowed */
  checkAccess(toolName: string, input: unknown): ToolAccessResult {
    // 1. Check blocked list
    if (this.config.blockedTools?.includes(toolName)) {
      return {
        allowed: false,
        reason: `Tool '${toolName}' is blocked by policy`,
      };
    }

    // 2. Check rate limit
    if (this.config.rateLimits?.[toolName]) {
      const limit = this.config.rateLimits[toolName]!;
      if (!this.checkRateLimit(toolName, limit)) {
        return {
          allowed: false,
          reason: `Tool '${toolName}' rate limit exceeded (${limit}/min)`,
        };
      }
    }

    // 3. Custom validation
    if (this.config.validator) {
      const result = this.config.validator(toolName, input);
      if (!result.valid) {
        return {
          allowed: false,
          reason: result.reason ?? `Custom validation failed for '${toolName}'`,
        };
      }
    }

    // 4. Check approval required
    if (this.config.approvalRequired?.includes(toolName)) {
      return { allowed: true, requiresApproval: true };
    }

    return { allowed: true };
  }

  /** Record a tool call for audit */
  async audit(entry: ToolAuditEntry): Promise<void> {
    try {
      // Widened to `unknown` because `onToolCall` is declared `=> void` (see
      // ToolAuditHandler); `void` is assignable to `unknown`, and awaiting
      // `unknown` resolves a thenable and passes anything else through. The
      // call stays in method position so `this` is still bound to the sink.
      const audited: unknown = this.config.auditHandler?.onToolCall(entry);
      await audited;
    } catch (err) {
      // ERR-H-06: audit failures are non-fatal but must be observable
      defaultLogger.warn("[tool-governance] audit() swallowed error", {
        tool: entry.toolName,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Record a tool result for audit */
  async auditResult(entry: ToolResultAuditEntry): Promise<void> {
    try {
      // Widened to `unknown` for the same reason as audit() above.
      const audited: unknown = this.config.auditHandler?.onToolResult?.(
        this.prepareResultAuditEntry(entry),
      );
      await audited;
    } catch (err) {
      // ERR-H-06: audit failures are non-fatal but must be observable
      defaultLogger.warn("[tool-governance] auditResult() swallowed error", {
        tool: entry.toolName,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Reset rate limit counters */
  resetRateLimits(): void {
    this.rateCounts.clear();
  }

  private checkRateLimit(toolName: string, maxPerMinute: number): boolean {
    const now = Date.now();
    const entry = this.rateCounts.get(toolName);

    if (!entry || now - entry.windowStart >= 60_000) {
      this.rateCounts.set(toolName, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= maxPerMinute) {
      return false;
    }

    entry.count++;
    return true;
  }

  private prepareResultAuditEntry(
    entry: ToolResultAuditEntry,
  ): ToolResultAuditEntry {
    const retention = this.config.resultAuditRetention ?? "raw";
    if (retention === "raw") return entry;

    const outputMetadata = describeToolResultOutput(entry.output);
    if (retention === "metadata-only") {
      return {
        ...entry,
        output: undefined,
        outputMetadata,
        resultAuditRetention: retention,
      };
    }

    return {
      ...entry,
      output: this.config.resultAuditRedactor
        ? this.config.resultAuditRedactor(entry.output, entry)
        : "[REDACTED]",
      outputMetadata,
      resultAuditRetention: retention,
    };
  }
}

function describeToolResultOutput(output: unknown): ToolResultAuditMetadata {
  if (Array.isArray(output)) {
    return { outputType: "array", outputLength: output.length };
  }

  if (output === null) {
    return { outputType: "null" };
  }

  if (typeof output === "object") {
    return {
      outputType: "object",
      outputKeys: Object.keys(output as Record<string, unknown>),
    };
  }

  if (typeof output === "string") {
    return { outputType: "string", outputLength: output.length };
  }

  return { outputType: typeof output };
}
