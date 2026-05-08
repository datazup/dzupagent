import type { ToolMessage } from '@langchain/core/messages'
import type { DzupEventBus } from '@dzupagent/core/events'
import type { SafetyMonitor } from '@dzupagent/core/security'
import type { ToolGovernance } from '@dzupagent/core/tools'
import type { ToolPermissionPolicy } from '@dzupagent/agent-types'
import type {
  PiiMode,
  PromptInjectionMode,
} from '@dzupagent/security'
import type {
  ToolArgValidatorConfig,
} from './tool-arg-validator.js'
import type {
  ToolLoopTracer,
  ToolResultScanFailureMode,
  ToolStat,
} from './tool-loop.js'

export interface StreamingToolExecutionResult {
  message: ToolMessage
  eventResult: string
  approvalPending?: boolean
  stuckReason?: string
  stuckRecovery?: string
  repeatedTool?: string
  shouldStop?: boolean
  stuckNudge?: ToolMessage
}

export interface ToolStatTracker {
  record: (name: string, durationMs: number, error?: string) => void
  toArray: () => ToolStat[]
}

/**
 * MJ-AGENT-02 — public policy bundle threaded by `streamRun()` into
 * `executeStreamingToolCall` so the native streaming branch enforces the
 * same governance / permission / validation / timeout / safety stack as the
 * sequential `tool-loop.ts` path.
 */
export interface StreamingToolPolicyOptions {
  toolGovernance?: ToolGovernance
  toolPermissionPolicy?: ToolPermissionPolicy
  validateToolArgs?: boolean | ToolArgValidatorConfig
  toolTimeouts?: Record<string, number>
  safetyMonitor?: SafetyMonitor
  scanToolResults?: boolean
  scanFailureMode?: ToolResultScanFailureMode
  /**
   * RF-15 — prompt-injection scanning on tool results.
   *
   * When set, `ContentScanner` runs against every tool result after the
   * `safetyMonitor` pass. On `'block'`, the result is replaced with a
   * sanitized placeholder before reaching the model. On `'warn'`, matched
   * spans are rewritten and a `safety:violation` event is emitted.
   */
  promptInjectionToolResults?: PromptInjectionMode
  /**
   * PII scanning on tool results — mirrors `promptInjectionToolResults` for PII.
   */
  piiToolResults?: PiiMode
  tracer?: ToolLoopTracer
  agentId?: string
  runId?: string
  eventBus?: DzupEventBus
  signal?: AbortSignal
}
