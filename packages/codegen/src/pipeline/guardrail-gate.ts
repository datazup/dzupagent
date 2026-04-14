/**
 * Guardrail Gate — a composable quality gate that runs the GuardrailEngine
 * and determines pass/fail based on severity thresholds.
 *
 * Designed to be wired into pipelines (GenPipelineBuilder, PipelineExecutor)
 * as a non-blocking optional step.
 */

import type { GuardrailEngine } from '../guardrails/guardrail-engine.js'
import type { GuardrailReporter } from '../guardrails/guardrail-reporter.js'
import type { GuardrailContext, GuardrailReport } from '../guardrails/guardrail-types.js'

export interface GuardrailGateConfig {
  engine: GuardrailEngine
  /** If true, warnings also block (default: false, only errors block) */
  strictMode?: boolean
  /** Reporter for formatting violation output */
  reporter?: GuardrailReporter
}

export interface GuardrailGateResult {
  passed: boolean
  report: GuardrailReport
  /** Formatted report string (only present when a reporter is configured) */
  formattedReport?: string
}

/**
 * Run the guardrail engine against the provided context and determine
 * whether the gate passes based on the configured strictness.
 *
 * - Normal mode: fails only when there are error-severity violations.
 * - Strict mode: fails when there are any error OR warning violations.
 */
export function runGuardrailGate(
  config: GuardrailGateConfig,
  context: GuardrailContext,
): GuardrailGateResult {
  const report = config.engine.evaluate(context)

  const passed = config.strictMode
    ? report.errorCount === 0 && report.warningCount === 0
    : report.errorCount === 0

  const result: GuardrailGateResult = { passed, report }
  if (config.reporter) {
    result.formattedReport = config.reporter.format(report)
  }
  return result
}

/**
 * Build a summary string from a GuardrailGateResult suitable for
 * embedding in phase error messages.
 */
export function summarizeGateResult(result: GuardrailGateResult): string {
  const { report } = result
  const lines: string[] = []

  lines.push(
    `Guardrail gate ${result.passed ? 'PASSED' : 'FAILED'}: ` +
      `${report.errorCount} error(s), ${report.warningCount} warning(s), ${report.infoCount} info`,
  )

  if (!result.passed) {
    const blocking = report.violations.filter(
      (v) => v.severity === 'error' || v.severity === 'warning',
    )
    const limit = Math.min(blocking.length, 10)
    for (let i = 0; i < limit; i++) {
      const v = blocking[i]!
      lines.push(`  - [${v.severity.toUpperCase()}] ${v.file}: ${v.message}`)
    }
    if (blocking.length > limit) {
      lines.push(`  ... and ${blocking.length - limit} more`)
    }
  }

  return lines.join('\n')
}
