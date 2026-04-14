/**
 * Guardrail and iteration budget types for agent safety boundaries.
 */

import type { StuckDetectorConfig } from './stuck-detector.js'

/** Configuration for agent guardrails */
export interface GuardrailConfig {
  /** Maximum total input + output tokens across all LLM calls */
  maxTokens?: number
  /** Maximum spend in cents across all LLM calls */
  maxCostCents?: number
  /** Maximum tool-call loop iterations (overrides DzupAgentConfig.maxIterations) */
  maxIterations?: number
  /** Tool names that this agent is forbidden from calling */
  blockedTools?: string[]
  /** Thresholds (0-1) at which budget warnings are emitted (default: [0.7, 0.9]) */
  budgetWarnings?: number[]
  /** Content filter applied to the agent's final output */
  outputFilter?: (output: string) => Promise<string | null>
  /**
   * Stuck detector configuration. When provided, these thresholds override
   * the StuckDetector defaults (maxRepeatCalls=3, maxErrorsInWindow=5, etc.).
   * Set to `false` to disable stuck detection entirely.
   */
  stuckDetector?: Partial<StuckDetectorConfig> | false
}

/** Budget tracking state shared across parent and child agents */
export interface BudgetState {
  totalInputTokens: number
  totalOutputTokens: number
  totalCostCents: number
  llmCalls: number
  iterations: number
  warnings: BudgetWarning[]
}

/** A budget warning emitted when a threshold is crossed */
export interface BudgetWarning {
  type: 'tokens' | 'cost' | 'iterations'
  threshold: number
  current: number
  limit: number
  message: string
}
