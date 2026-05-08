/**
 * Tool execution policy types for {@link DzupAgentConfig.toolExecution}.
 *
 * Extracted from the original `agent-types.ts` barrel — see that file for the
 * authoritative re-exports.
 */
import type { SafetyMonitor } from '@dzupagent/core/security'
import type { ToolGovernance } from '@dzupagent/core/tools'
import type { ToolPermissionPolicy } from '@dzupagent/agent-types'
import type { ToolResultScanFailureMode, ToolLoopTracer } from './tool-loop.js'
import type { ToolArgValidatorConfig } from './tool-arg-validator.js'

/**
 * Per-tool execution timeout map.
 *
 * Keys are tool names; values are timeout durations in milliseconds.
 * Forwarded directly to {@link ToolLoopConfig.toolTimeouts}.
 *
 * Example: `{ fetchUrl: 10_000, expensiveQuery: 60_000 }`.
 */
export type PerToolTimeoutMap = Record<string, number>

/**
 * Argument validator configuration.
 *
 * - `true`            — validate with auto-repair enabled
 * - `false`           — disable validation (default)
 * - `ToolArgValidatorConfig` — explicit knob bag (e.g. `{ autoRepair: false }`)
 *
 * Forwarded directly to {@link ToolLoopConfig.validateToolArgs}.
 */
export type ArgumentValidator = boolean | ToolArgValidatorConfig

/**
 * Tool tracer, structurally compatible with `DzupTracer` / `OTelSpan` from
 * `@dzupagent/otel`. Re-exported as the public alias for the
 * `toolExecution.tracer` slot so consumers don't have to know the
 * tool-loop's internal naming.
 */
export type ToolTracer = ToolLoopTracer

/**
 * Public surface for governing tool execution from a top-level
 * {@link DzupAgentConfig} (audit fix MJ-AGENT-01).
 *
 * Each field is optional; omitting any field preserves the legacy default.
 * The bundle is passed through to {@link ToolLoopConfig} during
 * `generate()` / `stream()` execution and is enforced by the internal
 * policy-enabled tool execution stage. That keeps scheduling/model-turn
 * kernels narrow while preserving the public `DzupAgent` config surface.
 */
export interface ToolExecutionConfig {
  /**
   * Tool governance layer — declares blocked tools, approval-required
   * tools, audit handlers, and access checks. Forwarded to
   * {@link ToolLoopConfig.toolGovernance}.
   *
   * When set, every tool call passes through `governance.checkAccess` and
   * (for non-`success` outcomes) `governance.auditResult`. Approval-
   * required tools trigger a hard execution gate that halts the loop with
   * `stopReason: 'approval_pending'`.
   */
  governance?: ToolGovernance

  /**
   * Safety monitor used to scan tool RESULTS for unsafe content (prompt
   * injection, secrets exfiltration, etc.) before they reach the LLM.
   * Forwarded to {@link ToolLoopConfig.safetyMonitor}.
   *
   * Critical / `block` / `kill` violations replace the tool output with a
   * safe rejection message.
   */
  safetyMonitor?: SafetyMonitor

  /**
   * Alias for {@link safetyMonitor}, provided so the public surface
   * matches the audit-spec naming. If both fields are supplied,
   * `safetyMonitor` wins.
   */
  resultScanner?: SafetyMonitor

  /**
   * Disable scanning tool results via {@link safetyMonitor}.
   * Defaults to `true` when a safetyMonitor is provided. Set to `false`
   * to opt out (e.g. when upstream scanning already happened).
   *
   * Forwarded to {@link ToolLoopConfig.scanToolResults}.
   */
  scanToolResults?: boolean

  /**
   * Controls scanner-exception behavior for tool result scanning.
   *
   * Defaults to `fail-open` for backwards compatibility. Set to
   * `fail-closed` for production or untrusted presets that must withhold
   * tool output when the safety scanner itself fails.
   *
   * Forwarded to {@link ToolLoopConfig.scanFailureMode}.
   */
  scanFailureMode?: ToolResultScanFailureMode

  /**
   * Per-tool execution timeouts in milliseconds. Forwarded to
   * {@link ToolLoopConfig.toolTimeouts}.
   */
  timeouts?: PerToolTimeoutMap

  /**
   * Optional OTel tracer for emitting one span per tool invocation.
   * Forwarded to {@link ToolLoopConfig.tracer}.
   */
  tracer?: ToolTracer

  /**
   * Identity of the agent that owns this tool loop invocation.
   *
   * When omitted, falls back to {@link DzupAgentConfig.id}. Forwarded to
   * {@link ToolLoopConfig.agentId}.
   */
  agentId?: string

  /**
   * Durable run identifier for canonical tool lifecycle events. Used as
   * the correlation id on `approval:requested` events. Forwarded to
   * {@link ToolLoopConfig.runId}.
   */
  runId?: string

  /**
   * Validate tool arguments against the tool's schema before execution.
   * Forwarded to {@link ToolLoopConfig.validateToolArgs}.
   */
  argumentValidator?: ArgumentValidator

  /**
   * Pluggable permission policy. When omitted, no permission checks run.
   * Forwarded to {@link ToolLoopConfig.toolPermissionPolicy}.
   */
  permissionPolicy?: ToolPermissionPolicy
}
