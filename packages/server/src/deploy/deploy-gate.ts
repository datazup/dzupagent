/**
 * DeployGate — wraps a DeployConfidenceCalculator and provides
 * CI-friendly output formatting and exit codes for deployment pipelines.
 *
 * Usage in CI:
 * ```ts
 * const gate = new DeployGate(calculator)
 * const result = gate.check()
 * console.log(gate.formatForCI(result))
 * process.exit(gate.exitCode(result))
 * ```
 */

import type { DeployConfidenceCalculator } from './confidence-calculator.js'
import type { DeployConfidence, GateDecision } from './confidence-types.js'

const DECISION_LABELS: Record<GateDecision, string> = {
  auto_deploy: 'AUTO DEPLOY',
  deploy_with_warnings: 'DEPLOY WITH WARNINGS',
  require_approval: 'REQUIRES APPROVAL',
  block: 'BLOCKED',
}

const DECISION_ICONS: Record<GateDecision, string> = {
  auto_deploy: '[PASS]',
  deploy_with_warnings: '[WARN]',
  require_approval: '[HOLD]',
  block: '[FAIL]',
}

export class DeployGate {
  constructor(private readonly calculator: DeployConfidenceCalculator) {}

  /** Compute confidence and return the full assessment. */
  check(): DeployConfidence {
    return this.calculator.compute()
  }

  /**
   * Format the confidence result for CI log output.
   * Produces a plain-text block suitable for GitHub Actions, GitLab CI, etc.
   */
  formatForCI(confidence: DeployConfidence): string {
    const lines: string[] = []

    const icon = DECISION_ICONS[confidence.decision]
    const label = DECISION_LABELS[confidence.decision]

    lines.push('='.repeat(60))
    lines.push(`  Deploy Gate: ${icon} ${label}`)
    lines.push(`  Environment: ${confidence.environment}`)
    lines.push(`  Confidence:  ${confidence.overallScore}/100`)
    lines.push(`  Computed:    ${confidence.computedAt.toISOString()}`)
    lines.push('='.repeat(60))

    if (confidence.signals.length > 0) {
      lines.push('')
      lines.push('  Signals:')

      // Sort signals by score ascending so weakest appear first
      const sorted = [...confidence.signals].sort((a, b) => a.score - b.score)

      for (const signal of sorted) {
        const staleTag = signal.stale ? ' [STALE]' : ''
        const scoreBar = buildScoreBar(signal.score)
        lines.push(`    ${scoreBar} ${signal.name}: ${signal.score}/100${staleTag}`)
        if (signal.details) {
          lines.push(`         ${signal.details}`)
        }
      }
    }

    if (confidence.decision === 'block' || confidence.decision === 'require_approval') {
      lines.push('')
      lines.push('  Action Required:')
      if (confidence.decision === 'block') {
        lines.push('    Resolve failing signals before deployment can proceed.')
      } else {
        lines.push('    A manual approval is required to continue deployment.')
      }
    }

    lines.push('')
    return lines.join('\n')
  }

  /**
   * Return the process exit code for CI integration.
   *   0 = deployment may proceed (auto_deploy or deploy_with_warnings)
   *   1 = deployment is blocked or requires approval
   */
  exitCode(confidence: DeployConfidence): number {
    switch (confidence.decision) {
      case 'auto_deploy':
      case 'deploy_with_warnings':
        return 0
      case 'require_approval':
      case 'block':
        return 1
    }
  }
}

/**
 * Build a simple ASCII progress bar for a score 0-100.
 * Example: "[========--]" for score 80.
 */
function buildScoreBar(score: number): string {
  const width = 10
  const filled = Math.round((score / 100) * width)
  const empty = width - filled
  return `[${'='.repeat(filled)}${'-'.repeat(empty)}]`
}
