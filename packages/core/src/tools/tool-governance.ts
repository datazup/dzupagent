/**
 * Unified tool governance layer for DzupAgent.
 * Enforces access control, rate limits, and audit logging for tool invocations.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolGovernanceConfig {
  /** Tools that are always blocked */
  blockedTools?: string[]
  /** Tools that require approval before execution */
  approvalRequired?: string[]
  /** Per-tool rate limits (max calls per minute) */
  rateLimits?: Record<string, number>
  /** Maximum execution time per tool call in ms */
  maxExecutionMs?: number
  /** Custom validation function */
  validator?: (toolName: string, input: unknown) => ToolValidationResult
  /** Audit handler for logging tool usage */
  auditHandler?: ToolAuditHandler
}

export interface ToolValidationResult {
  valid: boolean
  reason?: string
}

export interface ToolAuditHandler {
  onToolCall(entry: ToolAuditEntry): void | Promise<void>
  onToolResult?(entry: ToolResultAuditEntry): void | Promise<void>
}

export interface ToolAuditEntry {
  toolName: string
  /** @deprecated Raw input values are not recorded by default. Use inputMetadataKeys. */
  input: unknown
  inputMetadataKeys?: string[]
  callerAgent: string
  timestamp: number
  allowed: boolean
  blockedReason?: string
}

export interface ToolResultAuditEntry {
  toolName: string
  output: unknown
  callerAgent: string
  durationMs: number
  success: boolean
  timestamp: number
}

export interface ToolAccessResult {
  allowed: boolean
  reason?: string
  requiresApproval?: boolean
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Reusable tool governance layer.
 * Can be used by both @dzupagent/agent and @dzupagent/agent-adapters.
 */
export class ToolGovernance {
  private readonly rateCounts = new Map<string, { count: number; windowStart: number }>()

  constructor(private readonly config: ToolGovernanceConfig = {}) {}

  /** Check if a tool call is allowed */
  checkAccess(toolName: string, input: unknown): ToolAccessResult {
    // 1. Check blocked list
    if (this.config.blockedTools?.includes(toolName)) {
      return { allowed: false, reason: `Tool '${toolName}' is blocked by policy` }
    }

    // 2. Check rate limit
    if (this.config.rateLimits?.[toolName]) {
      const limit = this.config.rateLimits[toolName]!
      if (!this.checkRateLimit(toolName, limit)) {
        return { allowed: false, reason: `Tool '${toolName}' rate limit exceeded (${limit}/min)` }
      }
    }

    // 3. Custom validation
    if (this.config.validator) {
      const result = this.config.validator(toolName, input)
      if (!result.valid) {
        return { allowed: false, reason: result.reason ?? `Custom validation failed for '${toolName}'` }
      }
    }

    // 4. Check approval required
    if (this.config.approvalRequired?.includes(toolName)) {
      return { allowed: true, requiresApproval: true }
    }

    return { allowed: true }
  }

  /** Record a tool call for audit */
  async audit(entry: ToolAuditEntry): Promise<void> {
    try {
      await this.config.auditHandler?.onToolCall(entry)
    } catch {
      // Audit failures are non-fatal
    }
  }

  /** Record a tool result for audit */
  async auditResult(entry: ToolResultAuditEntry): Promise<void> {
    try {
      await this.config.auditHandler?.onToolResult?.(entry)
    } catch {
      // Audit failures are non-fatal
    }
  }

  /** Reset rate limit counters */
  resetRateLimits(): void {
    this.rateCounts.clear()
  }

  private checkRateLimit(toolName: string, maxPerMinute: number): boolean {
    const now = Date.now()
    const entry = this.rateCounts.get(toolName)

    if (!entry || now - entry.windowStart >= 60_000) {
      this.rateCounts.set(toolName, { count: 1, windowStart: now })
      return true
    }

    if (entry.count >= maxPerMinute) {
      return false
    }

    entry.count++
    return true
  }
}
