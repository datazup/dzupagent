/**
 * Architecture Guardrail Engine.
 *
 * Validates generated code against a set of configurable rules
 * covering layering, naming, imports, security, type safety,
 * and contract compliance.
 */

import type {
  GuardrailRule,
  GuardrailContext,
  GuardrailReport,
  GuardrailCategory,
  GuardrailSeverity,
  GuardrailViolation,
} from './guardrail-types.js'

export interface GuardrailEngineConfig {
  /** Stop on first error-severity violation (default: false) */
  failFast?: boolean
  /** Categories to skip */
  disabledCategories?: GuardrailCategory[]
  /** Specific rule IDs to skip */
  disabledRules?: string[]
  /** Override severity for specific rules */
  severityOverrides?: Map<string, GuardrailSeverity>
}

export class GuardrailEngine {
  private readonly rules: GuardrailRule[] = []
  private readonly config: Required<GuardrailEngineConfig>

  constructor(config?: GuardrailEngineConfig) {
    this.config = {
      failFast: config?.failFast ?? false,
      disabledCategories: config?.disabledCategories ?? [],
      disabledRules: config?.disabledRules ?? [],
      severityOverrides: config?.severityOverrides ?? new Map(),
    }
  }

  /**
   * Register a single guardrail rule.
   */
  addRule(rule: GuardrailRule): this {
    this.rules.push(rule)
    return this
  }

  /**
   * Register multiple guardrail rules at once.
   */
  addRules(rules: GuardrailRule[]): this {
    this.rules.push(...rules)
    return this
  }

  /**
   * Get the list of currently registered rules.
   */
  getRules(): readonly GuardrailRule[] {
    return this.rules
  }

  /**
   * Run all enabled rules against the provided context.
   */
  evaluate(context: GuardrailContext): GuardrailReport {
    const ruleResults = new Map<string, { passed: boolean; violations: GuardrailViolation[] }>()
    const allViolations: GuardrailViolation[] = []

    const enabledRules = this.rules.filter(
      (r) =>
        !this.config.disabledCategories.includes(r.category) &&
        !this.config.disabledRules.includes(r.id),
    )

    for (const rule of enabledRules) {
      const result = rule.check(context)

      // Apply severity overrides
      const overrideSeverity = this.config.severityOverrides.get(rule.id)
      const violations = result.violations.map((v) => ({
        ...v,
        severity: overrideSeverity ?? v.severity,
      }))

      const ruleResult = {
        passed: violations.filter((v) => v.severity === 'error').length === 0,
        violations,
      }

      ruleResults.set(rule.id, ruleResult)
      allViolations.push(...violations)

      if (this.config.failFast && !ruleResult.passed) {
        break
      }
    }

    const errorCount = allViolations.filter((v) => v.severity === 'error').length
    const warningCount = allViolations.filter((v) => v.severity === 'warning').length
    const infoCount = allViolations.filter((v) => v.severity === 'info').length

    return {
      passed: errorCount === 0,
      totalViolations: allViolations.length,
      errorCount,
      warningCount,
      infoCount,
      ruleResults,
      violations: allViolations,
    }
  }
}
