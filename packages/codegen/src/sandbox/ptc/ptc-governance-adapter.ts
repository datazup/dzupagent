/**
 * PtcGovernanceAdapter — bridges ToolGovernance into the PTC execution path.
 *
 * Every code execution request passes through `checkAccess` before the
 * WasmSandbox is invoked.  The adapter mirrors the approval-gate semantics
 * used by the agent tool-loop (RF-AGENT-04) so PTC and regular tool calls
 * are governed by the same policy object.
 */

import type { ToolGovernance } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'
import type { PtcGovernanceConfig, PtcRequest, PtcResult } from './ptc-types.js'

export interface PtcGovernanceAdapterOptions {
  /** Governance instance (from `@dzupagent/core`). */
  governance: ToolGovernance
  /** Event bus for `approval:requested` events. */
  eventBus?: DzupEventBus
  /** Durable run id forwarded as the correlation id on approval events. */
  runId?: string
  /** Governance config overrides (e.g. custom `toolName`). */
  ptcConfig?: PtcGovernanceConfig
}

/** Access decision returned by the adapter. */
export type PtcAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: string; approvalPending?: boolean }

/**
 * Check whether the given PTC request is allowed by governance.
 *
 * Returns `{ allowed: true }` when the sandbox may proceed.
 * Returns `{ allowed: false, reason, approvalPending? }` when blocked or
 * approval-gated.  The caller is responsible for emitting the blocked
 * `PtcResult` — this function only performs the policy check and
 * side-effects (event emission, audit).
 */
export function checkPtcAccess(
  request: PtcRequest,
  opts: PtcGovernanceAdapterOptions,
  callId?: string,
): PtcAccessDecision {
  const toolName = opts.ptcConfig?.toolName ?? 'ptc'

  if (opts.ptcConfig?.disabled) {
    return { allowed: false, reason: 'PTC execution is disabled by configuration' }
  }

  const input: Record<string, unknown> = {
    code: request.code,
    language: request.language,
    reason: request.reason,
  }

  const access = opts.governance.checkAccess(toolName, input)
  const caller = opts.runId ?? 'ptc'

  if (!access.allowed) {
    void opts.governance.audit({
      toolName,
      input,
      inputMetadataKeys: Object.keys(input),
      callerAgent: caller,
      timestamp: Date.now(),
      allowed: false,
      blockedReason: access.reason,
    })
    return { allowed: false, reason: access.reason ?? `Tool '${toolName}' is blocked by policy` }
  }

  if (access.requiresApproval) {
    const correlationId = opts.runId ?? callId ?? 'ptc'
    try {
      opts.eventBus?.emit({
        type: 'approval:requested',
        runId: correlationId,
        plan: { toolName, args: input },
      })
    } catch {
      // Non-fatal: event emission must not abort the run.
    }
    void opts.governance.audit({
      toolName,
      input,
      inputMetadataKeys: Object.keys(input),
      callerAgent: caller,
      timestamp: Date.now(),
      allowed: true,
      blockedReason: 'approval required',
    })
    return {
      allowed: false,
      reason: access.reason ?? 'Approval required before PTC execution',
      approvalPending: true,
    }
  }

  void opts.governance.audit({
    toolName,
    input,
    inputMetadataKeys: Object.keys(input),
    callerAgent: caller,
    timestamp: Date.now(),
    allowed: true,
  })
  return { allowed: true }
}

/** Build a blocked `PtcResult` for a denied access decision. */
export function buildBlockedPtcResult(decision: PtcAccessDecision & { allowed: false }): PtcResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 1,
    durationMs: 0,
    blocked: true,
    blockReason: decision.reason,
  }
}
