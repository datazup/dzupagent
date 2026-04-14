/**
 * Guardrail Reporter — formats violation reports as human-readable
 * text or structured JSON.
 */

import type {
  GuardrailReport,
  GuardrailViolation,
  GuardrailCategory,
  GuardrailSeverity,
} from './guardrail-types.js'

export type ReportFormat = 'text' | 'json'

export interface ReporterConfig {
  /** Output format (default: 'text') */
  format?: ReportFormat
  /** Show info-level violations (default: true) */
  showInfo?: boolean
  /** Show fix suggestions inline (default: true) */
  showSuggestions?: boolean
  /** Group by category (default: true for text, ignored for json) */
  groupByCategory?: boolean
}

const SEVERITY_ICONS: Record<GuardrailSeverity, string> = {
  error: 'ERROR',
  warning: 'WARN ',
  info: 'INFO ',
}

const SEVERITY_ORDER: Record<GuardrailSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
}

interface JsonViolation {
  ruleId: string
  file: string
  line?: number
  message: string
  severity: GuardrailSeverity
  suggestion?: string
  autoFixable: boolean
}

interface JsonReport {
  passed: boolean
  summary: {
    total: number
    errors: number
    warnings: number
    info: number
  }
  violations: JsonViolation[]
}

export class GuardrailReporter {
  private readonly config: Required<ReporterConfig>

  constructor(config?: ReporterConfig) {
    this.config = {
      format: config?.format ?? 'text',
      showInfo: config?.showInfo ?? true,
      showSuggestions: config?.showSuggestions ?? true,
      groupByCategory: config?.groupByCategory ?? true,
    }
  }

  /**
   * Format a guardrail report into a string.
   */
  format(report: GuardrailReport): string {
    if (this.config.format === 'json') {
      return this.formatJson(report)
    }
    return this.formatText(report)
  }

  private formatJson(report: GuardrailReport): string {
    const violations = this.filterViolations(report.violations)

    const output: JsonReport = {
      passed: report.passed,
      summary: {
        total: violations.length,
        errors: report.errorCount,
        warnings: report.warningCount,
        info: report.infoCount,
      },
      violations: violations.map((v) => {
        const jv: JsonViolation = {
          ruleId: v.ruleId,
          file: v.file,
          message: v.message,
          severity: v.severity,
          autoFixable: v.autoFixable,
        }
        if (v.line !== undefined) jv.line = v.line
        if (v.suggestion !== undefined) jv.suggestion = v.suggestion
        return jv
      }),
    }

    return JSON.stringify(output, null, 2)
  }

  private formatText(report: GuardrailReport): string {
    const lines: string[] = []

    // Header
    const status = report.passed ? 'PASSED' : 'FAILED'
    lines.push(`Guardrail Check: ${status}`)
    lines.push('='.repeat(50))

    // Summary
    lines.push(
      `Total: ${report.totalViolations} | Errors: ${report.errorCount} | Warnings: ${report.warningCount} | Info: ${report.infoCount}`,
    )

    const violations = this.filterViolations(report.violations)

    if (violations.length === 0) {
      lines.push('\nNo violations found.')
      return lines.join('\n')
    }

    lines.push('')

    if (this.config.groupByCategory) {
      this.appendGroupedByCategory(violations, lines)
    } else {
      this.appendFlat(violations, lines)
    }

    return lines.join('\n')
  }

  private filterViolations(violations: GuardrailViolation[]): GuardrailViolation[] {
    if (this.config.showInfo) return violations
    return violations.filter((v) => v.severity !== 'info')
  }

  private appendGroupedByCategory(violations: GuardrailViolation[], lines: string[]): void {
    const grouped = new Map<GuardrailCategory, GuardrailViolation[]>()

    for (const v of violations) {
      // Determine category from ruleId mapping
      const category = this.categoryFromViolation(v)
      const list = grouped.get(category) ?? []
      list.push(v)
      grouped.set(category, list)
    }

    // Sort categories by highest severity first
    const sortedCategories = [...grouped.entries()].sort((a, b) => {
      const aMin = Math.min(...a[1].map((v) => SEVERITY_ORDER[v.severity]))
      const bMin = Math.min(...b[1].map((v) => SEVERITY_ORDER[v.severity]))
      return aMin - bMin
    })

    for (const [category, categoryViolations] of sortedCategories) {
      lines.push(`--- ${category.toUpperCase()} ---`)

      // Sort by severity then file
      const sorted = [...categoryViolations].sort((a, b) => {
        const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
        if (sevDiff !== 0) return sevDiff
        return a.file.localeCompare(b.file)
      })

      for (const v of sorted) {
        this.appendViolation(v, lines)
      }

      lines.push('')
    }
  }

  private appendFlat(violations: GuardrailViolation[], lines: string[]): void {
    const sorted = [...violations].sort((a, b) => {
      const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
      if (sevDiff !== 0) return sevDiff
      return a.file.localeCompare(b.file)
    })

    for (const v of sorted) {
      this.appendViolation(v, lines)
    }
  }

  private appendViolation(v: GuardrailViolation, lines: string[]): void {
    const location = v.line ? `${v.file}:${v.line}` : v.file
    lines.push(`  [${SEVERITY_ICONS[v.severity]}] ${location}`)
    lines.push(`           ${v.message}`)

    if (this.config.showSuggestions && v.suggestion) {
      lines.push(`           Fix: ${v.suggestion}`)
    }
  }

  private categoryFromViolation(v: GuardrailViolation): GuardrailCategory {
    // Map ruleId to category
    const mapping: Record<string, GuardrailCategory> = {
      layering: 'layering',
      'import-restriction': 'imports',
      'naming-convention': 'naming',
      security: 'security',
      'type-safety': 'patterns',
      'contract-compliance': 'contracts',
    }
    return mapping[v.ruleId] ?? 'patterns'
  }
}
