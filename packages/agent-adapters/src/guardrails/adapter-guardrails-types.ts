/**
 * Adapter guardrails — shared types, constants, and small helpers.
 *
 * Extracted from `adapter-guardrails.ts` (MC-027a-2). The runtime
 * `AdapterGuardrails` orchestrator and `AdapterStuckDetector` subclass live
 * in sibling modules so the main file stays focused on the wrap pipeline.
 */
import type { StuckDetectorConfig, StuckStatus as CoreStuckStatus } from '@dzupagent/core/utils'
import type { DzupEventBus } from '@dzupagent/core/events'
import type { AgentStreamEvent } from '../types.js'

export type { StuckDetectorConfig }

/**
 * Re-exported here to preserve the long-standing
 * `@dzupagent/agent-adapters` public surface. The canonical type lives in
 * `@dzupagent/core` (RF-11).
 */
export type StuckStatus = CoreStuckStatus

export interface AdapterGuardrailsConfig {
  /** Max total iterations (tool call rounds) across the execution. Default 50 */
  maxIterations?: number
  /** Max total tokens (input + output). Default: unlimited */
  maxTokens?: number
  /** Max total cost in cents. Default: unlimited */
  maxCostCents?: number
  /** Max duration in ms. Default: 300_000 (5 min) */
  maxDurationMs?: number
  /** Stuck detector config. Set to false to disable. */
  stuckDetector?: Partial<StuckDetectorConfig> | false
  /** Tool names that are forbidden */
  blockedTools?: string[]
  /** Warning thresholds (0-1). Default [0.7, 0.9] */
  warningThresholds?: number[]
  /** Event bus for emitting guardrail events */
  eventBus?: DzupEventBus
  /** Content filter for output */
  outputFilter?: (output: string) => Promise<string | null>
  /** Callback invoked when a guardrail rule violation is detected (for governance side-channel). */
  onRuleViolation?: (ruleId: string, severity: 'warn' | 'block', detail: string) => void
}

export interface GuardrailViolation {
  type: 'stuck' | 'budget_exceeded' | 'blocked_tool' | 'timeout' | 'output_filtered'
  message: string
  severity: 'warning' | 'critical'
}

export interface BudgetState {
  iterations: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCostCents: number
  durationMs: number
  warnings: string[]
}

export interface GuardrailStatus {
  safe: boolean
  violations: GuardrailViolation[]
  budgetState: BudgetState
  stuckStatus: StuckStatus
}

export const DEFAULT_MAX_ITERATIONS = 50
export const DEFAULT_MAX_DURATION_MS = 300_000
export const DEFAULT_WARNING_THRESHOLDS = [0.7, 0.9]

/** Type guard for `adapter:provider_raw` events that bypass guardrails. */
export function isProviderRawStreamEvent(
  event: AgentStreamEvent,
): event is Extract<AgentStreamEvent, { type: 'adapter:provider_raw' }> {
  return event.type === 'adapter:provider_raw'
}

/**
 * Simple heuristic to detect error-like output from tool results.
 * Looks for common error patterns without being too aggressive.
 */
export function looksLikeError(output: string): boolean {
  const lower = output.toLowerCase()
  return (
    lower.startsWith('error:') ||
    lower.startsWith('error -') ||
    lower.includes('traceback (most recent call last)') ||
    lower.includes('exception:') ||
    lower.includes('fatal:') ||
    lower.includes('enoent') ||
    lower.includes('permission denied') ||
    lower.includes('command not found')
  )
}
