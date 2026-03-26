/**
 * DeployConfidenceCalculator — aggregates signals from multiple sources
 * and computes a weighted confidence score for deployment gating.
 *
 * Usage:
 * ```ts
 * const calc = new DeployConfidenceCalculator({ environment: 'production' })
 * calc.addDoctorSignal(doctorReport)
 * calc.addScorecardSignal(scorecardReport)
 * calc.addTestCoverageSignal(87)
 * const result = calc.compute()
 * // result.decision => 'auto_deploy' | 'deploy_with_warnings' | ...
 * ```
 */

import type { DoctorReport } from '../cli/doctor.js'
import type { ScorecardReport } from '../scorecard/integration-scorecard.js'
import type {
  ConfidenceSignal,
  DeployConfidence,
  DeployConfidenceConfig,
  ConfidenceThresholds,
  GateDecision,
} from './confidence-types.js'

const DEFAULT_THRESHOLDS: ConfidenceThresholds = {
  autoDeploy: 90,
  deployWithWarnings: 70,
  requireApproval: 50,
}

const DEFAULT_WEIGHTS: Record<string, number> = {
  testCoverage: 0.20,
  guardrailCompliance: 0.15,
  doctorHealth: 0.20,
  scorecardGrade: 0.15,
  historicalSuccess: 0.15,
  changeRisk: 0.10,
  recoveryReadiness: 0.05,
}

const DEFAULT_SIGNAL_MAX_AGE = 60 * 60 * 1000 // 1 hour

export class DeployConfidenceCalculator {
  private readonly config: DeployConfidenceConfig
  private readonly thresholds: ConfidenceThresholds
  private readonly weights: Record<string, number>
  private readonly signalMaxAge: number
  private signals: ConfidenceSignal[] = []

  constructor(config: DeployConfidenceConfig) {
    this.config = config
    this.thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...config.thresholds,
    }
    this.weights = {
      ...DEFAULT_WEIGHTS,
      ...config.weightOverrides,
    }
    this.signalMaxAge = config.signalMaxAge ?? DEFAULT_SIGNAL_MAX_AGE
  }

  // ---------------------------------------------------------------------------
  // Signal adders
  // ---------------------------------------------------------------------------

  /** Add a signal derived from a Doctor diagnostic report. */
  addDoctorSignal(report: DoctorReport): this {
    const { passed, failures, total } = report.summary
    let score = total > 0 ? Math.round((passed / total) * 100) : 0

    // Failures are severe — penalize heavily beyond the ratio
    if (failures > 0) {
      score = Math.max(0, score - failures * 10)
    }

    const details = `${passed}/${total} passed, ${failures} failures, ${report.summary.warnings} warnings`

    this.signals.push({
      name: 'doctorHealth',
      score,
      weight: this.weights['doctorHealth'] ?? DEFAULT_WEIGHTS['doctorHealth']!,
      source: 'doctor',
      stale: this.isStale(new Date(report.timestamp)),
      details,
      timestamp: new Date(report.timestamp),
    })

    return this
  }

  /** Add a signal derived from an Integration Scorecard report. */
  addScorecardSignal(report: ScorecardReport): this {
    const score = Math.min(100, Math.max(0, report.overallScore))
    const details = `Grade ${report.grade}, overall score ${report.overallScore}/100, ${report.recommendations.length} recommendations`

    this.signals.push({
      name: 'scorecardGrade',
      score,
      weight: this.weights['scorecardGrade'] ?? DEFAULT_WEIGHTS['scorecardGrade']!,
      source: 'scorecard',
      stale: this.isStale(report.generatedAt),
      details,
      timestamp: report.generatedAt,
    })

    return this
  }

  /** Add a signal from test coverage percentage (0-100). */
  addTestCoverageSignal(coveragePercent: number): this {
    const score = Math.min(100, Math.max(0, Math.round(coveragePercent)))
    const details = `Test coverage: ${coveragePercent.toFixed(1)}%`

    this.signals.push({
      name: 'testCoverage',
      score,
      weight: this.weights['testCoverage'] ?? DEFAULT_WEIGHTS['testCoverage']!,
      source: 'coverage',
      stale: false,
      details,
      timestamp: new Date(),
    })

    return this
  }

  /** Add a signal from guardrail validation results. */
  addGuardrailSignal(passed: boolean, errorCount: number, warningCount: number): this {
    let score: number
    if (passed) {
      score = 100
    } else {
      score = Math.max(0, 100 - errorCount * 20 - warningCount * 5)
    }

    const details = passed
      ? 'All guardrails passed'
      : `${errorCount} errors, ${warningCount} warnings`

    this.signals.push({
      name: 'guardrailCompliance',
      score,
      weight: this.weights['guardrailCompliance'] ?? DEFAULT_WEIGHTS['guardrailCompliance']!,
      source: 'guardrails',
      stale: false,
      details,
      timestamp: new Date(),
    })

    return this
  }

  /** Add a signal from historical deployment success rate. */
  addHistoricalSignal(successRate: number, totalDeployments: number): this {
    let score = Math.min(100, Math.max(0, Math.round(successRate * 100)))

    // Boost confidence if there is a meaningful history (>10 deployments)
    if (totalDeployments > 10 && score >= 80) {
      score = Math.min(100, score + 5)
    }

    // Reduce confidence if insufficient history
    if (totalDeployments < 3) {
      score = Math.max(0, score - 10)
    }

    const details = `${(successRate * 100).toFixed(1)}% success rate over ${totalDeployments} deployments`

    this.signals.push({
      name: 'historicalSuccess',
      score,
      weight: this.weights['historicalSuccess'] ?? DEFAULT_WEIGHTS['historicalSuccess']!,
      source: 'history',
      stale: false,
      details,
      timestamp: new Date(),
    })

    return this
  }

  /** Add a signal from change risk analysis (inverse — more change = lower score). */
  addChangeRiskSignal(filesChanged: number, linesChanged: number, criticalFilesChanged: boolean): this {
    // Start at 100, reduce based on change magnitude
    let score = 100

    // File count penalty: -2 per file, capped contribution at -40
    score -= Math.min(40, filesChanged * 2)

    // Lines changed penalty: -1 per 100 lines, capped at -30
    score -= Math.min(30, Math.floor(linesChanged / 100))

    // Critical files penalty
    if (criticalFilesChanged) {
      score -= 30
    }

    score = Math.max(0, Math.min(100, score))

    const details = `${filesChanged} files, ${linesChanged} lines changed${criticalFilesChanged ? ' (includes critical files)' : ''}`

    this.signals.push({
      name: 'changeRisk',
      score,
      weight: this.weights['changeRisk'] ?? DEFAULT_WEIGHTS['changeRisk']!,
      source: 'changeset',
      stale: false,
      details,
      timestamp: new Date(),
    })

    return this
  }

  /** Add a signal from recovery readiness (copilot + rollback availability). */
  addRecoverySignal(copilotConfigured: boolean, rollbackAvailable: boolean): this {
    const score = (copilotConfigured ? 50 : 0) + (rollbackAvailable ? 50 : 0)

    const parts: string[] = []
    parts.push(copilotConfigured ? 'recovery copilot configured' : 'no recovery copilot')
    parts.push(rollbackAvailable ? 'rollback available' : 'no rollback mechanism')
    const details = parts.join(', ')

    this.signals.push({
      name: 'recoveryReadiness',
      score,
      weight: this.weights['recoveryReadiness'] ?? DEFAULT_WEIGHTS['recoveryReadiness']!,
      source: 'recovery',
      stale: false,
      details,
      timestamp: new Date(),
    })

    return this
  }

  /** Add an arbitrary custom signal. */
  addCustomSignal(signal: ConfidenceSignal): this {
    this.signals.push(signal)
    return this
  }

  // ---------------------------------------------------------------------------
  // Compute
  // ---------------------------------------------------------------------------

  /** Compute the overall confidence score and gate decision. */
  compute(): DeployConfidence {
    if (this.signals.length === 0) {
      return {
        overallScore: 0,
        decision: 'block',
        signals: [],
        explanation: 'No signals provided — cannot assess deployment confidence.',
        environment: this.config.environment,
        computedAt: new Date(),
      }
    }

    // Weighted average
    let weightedSum = 0
    let totalWeight = 0

    for (const signal of this.signals) {
      weightedSum += signal.score * signal.weight
      totalWeight += signal.weight
    }

    const overallScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0

    // Stale signal penalty: if any signal is stale, reduce score by 5 per stale signal
    const staleCount = this.signals.filter((s) => s.stale).length
    const adjustedScore = Math.max(0, overallScore - staleCount * 5)

    // Determine gate decision
    const decision = this.resolveDecision(adjustedScore)

    // Build explanation
    const explanation = this.buildExplanation(adjustedScore, decision, staleCount)

    return {
      overallScore: adjustedScore,
      decision,
      signals: [...this.signals],
      explanation,
      environment: this.config.environment,
      computedAt: new Date(),
    }
  }

  /** Reset all signals for a fresh computation. */
  reset(): void {
    this.signals = []
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private isStale(timestamp: Date): boolean {
    return Date.now() - timestamp.getTime() > this.signalMaxAge
  }

  private resolveDecision(score: number): GateDecision {
    if (score >= this.thresholds.autoDeploy) return 'auto_deploy'
    if (score >= this.thresholds.deployWithWarnings) return 'deploy_with_warnings'
    if (score >= this.thresholds.requireApproval) return 'require_approval'
    return 'block'
  }

  private buildExplanation(score: number, decision: GateDecision, staleCount: number): string {
    const lines: string[] = []

    lines.push(`Deployment confidence for "${this.config.environment}": ${score}/100.`)

    switch (decision) {
      case 'auto_deploy':
        lines.push('All signals are healthy. Deployment can proceed automatically.')
        break
      case 'deploy_with_warnings':
        lines.push('Some signals indicate minor issues. Deployment can proceed with caution.')
        break
      case 'require_approval':
        lines.push('Confidence is below the safe threshold. Manual approval is required before deployment.')
        break
      case 'block':
        lines.push('Confidence is too low. Deployment is blocked until issues are resolved.')
        break
    }

    if (staleCount > 0) {
      lines.push(`Warning: ${staleCount} signal(s) are stale and may not reflect current state.`)
    }

    // List signals below threshold
    const weakSignals = this.signals.filter((s) => s.score < this.thresholds.deployWithWarnings)
    if (weakSignals.length > 0) {
      lines.push('Weak signals:')
      for (const s of weakSignals) {
        lines.push(`  - ${s.name}: ${s.score}/100 (${s.details ?? 'no details'})`)
      }
    }

    return lines.join('\n')
  }
}
