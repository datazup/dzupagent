/**
 * Signal checkers — orchestrate signal collection for the confidence calculator.
 *
 * These functions check recovery copilot configuration, rollback availability,
 * and aggregate all signals into a confidence calculator for a deployment decision.
 */

import { DeployConfidenceCalculator } from './confidence-calculator.js'
import type { DeployConfidenceConfig, DeployConfidence } from './confidence-types.js'
import type { DeploymentHistoryStoreInterface, SuccessRateResult } from './deployment-history-store.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Agent configuration shape — uses structural typing to avoid hard dependency on @dzupagent/agent. */
export interface AgentConfigLike {
  tools?: Array<{ name: string } | string>
  guardrails?: Record<string, unknown>
  [key: string]: unknown
}

/** Rollback check result. */
export interface RollbackCheckResult {
  available: boolean
  revisionCount: number
  latestRevisionId?: string
}

/** Function that checks whether a project has rollback revisions available. */
export type RollbackChecker = (projectId: string) => Promise<RollbackCheckResult>

/** Result of a full signal computation. */
export interface SignalComputationResult {
  confidence: DeployConfidence
  recoveryConfigured: boolean
  rollbackAvailable: boolean
  historicalRate: SuccessRateResult | null
}

/** Configuration for computeAllSignals. */
export interface SignalComputationConfig {
  /** Confidence calculator settings. */
  confidenceConfig: DeployConfidenceConfig
  /** Optional agent config to check for recovery copilot. */
  agentConfig?: AgentConfigLike
  /** Optional project ID for rollback check. */
  projectId?: string
  /** Optional function that checks rollback availability. */
  rollbackChecker?: RollbackChecker
  /** Optional deployment history store for historical success rate. */
  historyStore?: DeploymentHistoryStoreInterface
  /** Optional test coverage percentage (0-100). */
  testCoverage?: number
  /** Optional guardrail check results. */
  guardrails?: { passed: boolean; errorCount: number; warningCount: number }
  /** Optional change risk data. */
  changeRisk?: { filesChanged: number; linesChanged: number; criticalFilesChanged: boolean }
}

// ---------------------------------------------------------------------------
// Individual signal checkers
// ---------------------------------------------------------------------------

/**
 * Check whether the RecoveryCopilot is configured in the agent's tool list.
 *
 * Uses structural typing — checks for a tool named `recovery_copilot` or
 * `RecoveryCopilot` in the agent config tools array, or checks if the
 * agent config has a `recovery` or `recoveryCopilot` key.
 */
export function checkRecoveryCopilotConfigured(config: AgentConfigLike | undefined): boolean {
  if (!config) return false

  // Check for recovery-related configuration keys
  if ('recovery' in config || 'recoveryCopilot' in config) {
    return true
  }

  // Check tools array for a recovery copilot tool
  if (Array.isArray(config.tools)) {
    return config.tools.some((tool) => {
      const name = typeof tool === 'string' ? tool : tool.name
      const lower = name.toLowerCase()
      return (
        lower === 'recovery_copilot' ||
        lower === 'recoverycopilot' ||
        lower === 'recovery-copilot' ||
        lower.includes('recovery')
      )
    })
  }

  return false
}

/**
 * Check whether a project has rollback revisions available.
 *
 * Uses the provided `rollbackChecker` function. If none is provided,
 * returns `{ available: false, revisionCount: 0 }`.
 */
export async function checkRollbackAvailable(
  projectId: string | undefined,
  checker?: RollbackChecker,
): Promise<RollbackCheckResult> {
  if (!projectId || !checker) {
    return { available: false, revisionCount: 0 }
  }

  try {
    return await checker(projectId)
  } catch {
    return { available: false, revisionCount: 0 }
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Compute all signals and return a full confidence result.
 *
 * This function orchestrates all available signal checkers, feeds their
 * results into a DeployConfidenceCalculator, and returns the computed
 * confidence along with individual check results.
 */
export async function computeAllSignals(
  config: SignalComputationConfig,
): Promise<SignalComputationResult> {
  const calculator = new DeployConfidenceCalculator(config.confidenceConfig)

  // --- Recovery readiness ---
  const recoveryConfigured = checkRecoveryCopilotConfigured(config.agentConfig)
  const rollbackResult = await checkRollbackAvailable(config.projectId, config.rollbackChecker)
  calculator.addRecoverySignal(recoveryConfigured, rollbackResult.available)

  // --- Historical success rate ---
  let historicalRate: SuccessRateResult | null = null
  if (config.historyStore) {
    historicalRate = await config.historyStore.getSuccessRate(
      config.confidenceConfig.environment,
      30,
    )
    calculator.addHistoricalSignal(historicalRate.successRate, historicalRate.totalDeployments)
  }

  // --- Test coverage ---
  if (config.testCoverage !== undefined) {
    calculator.addTestCoverageSignal(config.testCoverage)
  }

  // --- Guardrail compliance ---
  if (config.guardrails) {
    calculator.addGuardrailSignal(
      config.guardrails.passed,
      config.guardrails.errorCount,
      config.guardrails.warningCount,
    )
  }

  // --- Change risk ---
  if (config.changeRisk) {
    calculator.addChangeRiskSignal(
      config.changeRisk.filesChanged,
      config.changeRisk.linesChanged,
      config.changeRisk.criticalFilesChanged,
    )
  }

  const confidence = calculator.compute()

  return {
    confidence,
    recoveryConfigured,
    rollbackAvailable: rollbackResult.available,
    historicalRate,
  }
}
