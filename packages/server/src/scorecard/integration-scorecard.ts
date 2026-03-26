/**
 * Integration Scorecard — generates automated deployment health reports.
 *
 * Inspects a ForgeServerConfig and produces a scored report across five
 * categories: coverage, safety, cost controls, observability, and security.
 * Each category contains individual checks that produce pass/warn/fail/skip
 * results. The overall score is a weighted average.
 */
import type { ForgeServerConfig } from '../app.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'
export type Grade = 'A' | 'B' | 'C' | 'D' | 'F'
export type RecommendationPriority = 'critical' | 'high' | 'medium' | 'low'

export interface ScorecardCheck {
  name: string
  status: CheckStatus
  score: number
  message: string
  details?: Record<string, unknown>
}

export interface ScorecardCategory {
  name: string
  score: number
  weight: number
  checks: ScorecardCheck[]
}

export interface Recommendation {
  priority: RecommendationPriority
  category: string
  message: string
  action: string
}

export interface ScorecardReport {
  generatedAt: Date
  overallScore: number
  grade: Grade
  categories: ScorecardCategory[]
  recommendations: Recommendation[]
}

// ---------------------------------------------------------------------------
// Optional probe inputs (provided by the caller, not read from disk)
// ---------------------------------------------------------------------------

/** Extra information the caller may supply so the scorecard can score
 *  items that are not directly discoverable from ForgeServerConfig. */
export interface ScorecardProbeInput {
  /** Test coverage percentage (0-100), if known. */
  testCoveragePercent?: number
  /** Whether critical-path tests exist (e.g., run lifecycle). */
  hasCriticalPathTests?: boolean
  /** Whether integration tests exist. */
  hasIntegrationTests?: boolean
  /** Whether a policy engine is configured upstream. */
  policyEngineConfigured?: boolean
  /** Whether audit trail / structured logging is enabled. */
  auditTrailEnabled?: boolean
  /** Whether secret detection (e.g., Gitleaks) is active. */
  secretDetectionActive?: boolean
  /** Whether input sanitization middleware is present. */
  inputSanitizationPresent?: boolean
  /** Whether token budget limits are set on the model registry. */
  tokenBudgetLimitsSet?: boolean
  /** Whether model fallback chains are configured. */
  modelFallbackConfigured?: boolean
  /** Whether an OTEL exporter is configured. */
  otelExporterConfigured?: boolean
  /** Whether error alerting (e.g., PagerDuty, Slack webhook) is wired. */
  errorAlertingConfigured?: boolean
  /** Whether CORS is restricted (not wildcard). */
  corsRestricted?: boolean
  /** Whether API key rotation is enabled. */
  apiKeyRotationEnabled?: boolean
  /** Whether RBAC enforcement middleware is present. */
  rbacEnforcementPresent?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeGrade(score: number): Grade {
  if (score >= 90) return 'A'
  if (score >= 75) return 'B'
  if (score >= 60) return 'C'
  if (score >= 40) return 'D'
  return 'F'
}

function passCheck(name: string, message: string, details?: Record<string, unknown>): ScorecardCheck {
  return { name, status: 'pass', score: 100, message, details }
}

function warnCheck(name: string, message: string, score: number, details?: Record<string, unknown>): ScorecardCheck {
  return { name, status: 'warn', score, message, details }
}

function failCheck(name: string, message: string, details?: Record<string, unknown>): ScorecardCheck {
  return { name, status: 'fail', score: 0, message, details }
}

function skipCheck(name: string, message: string): ScorecardCheck {
  return { name, status: 'skip', score: 0, message }
}

function categoryScore(checks: ScorecardCheck[]): number {
  const scored = checks.filter((c) => c.status !== 'skip')
  if (scored.length === 0) return 0
  const total = scored.reduce((sum, c) => sum + c.score, 0)
  return Math.round(total / scored.length)
}

// ---------------------------------------------------------------------------
// Category evaluators
// ---------------------------------------------------------------------------

function evaluateCoverage(probe: ScorecardProbeInput): ScorecardCategory {
  const checks: ScorecardCheck[] = []

  // Test coverage percentage
  if (probe.testCoveragePercent !== undefined) {
    const pct = probe.testCoveragePercent
    if (pct >= 80) {
      checks.push(passCheck('Test coverage', `Coverage is at ${pct}%`, { percent: pct }))
    } else if (pct >= 50) {
      checks.push(warnCheck('Test coverage', `Coverage is ${pct}% — aim for 80%+`, pct, { percent: pct }))
    } else {
      checks.push(failCheck('Test coverage', `Coverage is only ${pct}%`, { percent: pct }))
    }
  } else {
    checks.push(skipCheck('Test coverage', 'Coverage percentage not provided'))
  }

  // Critical path tests
  if (probe.hasCriticalPathTests !== undefined) {
    checks.push(
      probe.hasCriticalPathTests
        ? passCheck('Critical path tests', 'Critical-path tests are present')
        : failCheck('Critical path tests', 'No critical-path tests detected'),
    )
  } else {
    checks.push(skipCheck('Critical path tests', 'Not evaluated'))
  }

  // Integration tests
  if (probe.hasIntegrationTests !== undefined) {
    checks.push(
      probe.hasIntegrationTests
        ? passCheck('Integration tests', 'Integration tests are present')
        : warnCheck('Integration tests', 'No integration tests detected', 30),
    )
  } else {
    checks.push(skipCheck('Integration tests', 'Not evaluated'))
  }

  return { name: 'Coverage', score: categoryScore(checks), weight: 0.20, checks }
}

function evaluateSafety(config: ForgeServerConfig, probe: ScorecardProbeInput): ScorecardCategory {
  const checks: ScorecardCheck[] = []

  // Policy engine
  if (probe.policyEngineConfigured !== undefined) {
    checks.push(
      probe.policyEngineConfigured
        ? passCheck('Policy engine', 'Policy engine is configured')
        : failCheck('Policy engine', 'No policy engine configured'),
    )
  } else {
    checks.push(skipCheck('Policy engine', 'Not evaluated'))
  }

  // Audit trail (we can infer this if metrics or event gateway exists)
  if (probe.auditTrailEnabled !== undefined) {
    checks.push(
      probe.auditTrailEnabled
        ? passCheck('Audit trail', 'Audit trail is enabled')
        : failCheck('Audit trail', 'Audit trail is not enabled'),
    )
  } else if (config.metrics || config.eventGateway) {
    checks.push(warnCheck('Audit trail', 'Metrics/events present but dedicated audit trail not confirmed', 50))
  } else {
    checks.push(failCheck('Audit trail', 'No audit trail or event system detected'))
  }

  // Secret detection
  if (probe.secretDetectionActive !== undefined) {
    checks.push(
      probe.secretDetectionActive
        ? passCheck('Secret detection', 'Secret detection is active')
        : failCheck('Secret detection', 'Secret detection not configured'),
    )
  } else {
    checks.push(skipCheck('Secret detection', 'Not evaluated'))
  }

  // Input sanitization
  if (probe.inputSanitizationPresent !== undefined) {
    checks.push(
      probe.inputSanitizationPresent
        ? passCheck('Input sanitization', 'Input sanitization is present')
        : failCheck('Input sanitization', 'No input sanitization detected'),
    )
  } else {
    checks.push(skipCheck('Input sanitization', 'Not evaluated'))
  }

  return { name: 'Safety', score: categoryScore(checks), weight: 0.25, checks }
}

function evaluateCostControls(config: ForgeServerConfig, probe: ScorecardProbeInput): ScorecardCategory {
  const checks: ScorecardCheck[] = []

  // Token budget limits
  if (probe.tokenBudgetLimitsSet !== undefined) {
    checks.push(
      probe.tokenBudgetLimitsSet
        ? passCheck('Token budget limits', 'Token budget limits are set')
        : failCheck('Token budget limits', 'No token budget limits configured'),
    )
  } else {
    checks.push(skipCheck('Token budget limits', 'Not evaluated'))
  }

  // Model fallback chains
  if (probe.modelFallbackConfigured !== undefined) {
    checks.push(
      probe.modelFallbackConfigured
        ? passCheck('Model fallback chains', 'Model fallback chains are configured')
        : warnCheck('Model fallback chains', 'No model fallback chains configured', 40),
    )
  } else {
    // Try to infer from model registry provider count
    const providerHealth = config.modelRegistry.getProviderHealth()
    const providerCount = Object.keys(providerHealth).length
    if (providerCount > 1) {
      checks.push(passCheck('Model fallback chains', `${providerCount} providers configured — fallback possible`, { providerCount }))
    } else if (providerCount === 1) {
      checks.push(warnCheck('Model fallback chains', 'Only 1 provider configured — no fallback', 40, { providerCount }))
    } else {
      checks.push(failCheck('Model fallback chains', 'No providers configured'))
    }
  }

  // Rate limiting
  if (config.rateLimit) {
    checks.push(passCheck('Rate limiting', 'Rate limiting is active', {
      maxRequests: config.rateLimit.maxRequests,
      windowMs: config.rateLimit.windowMs,
    }))
  } else {
    checks.push(failCheck('Rate limiting', 'Rate limiting is not configured'))
  }

  // Quota enforcement (run queue presence is a proxy)
  if (config.runQueue) {
    checks.push(passCheck('Quota enforcement', 'Run queue is configured for quota enforcement'))
  } else {
    checks.push(warnCheck('Quota enforcement', 'No run queue — quota enforcement limited', 30))
  }

  return { name: 'Cost Controls', score: categoryScore(checks), weight: 0.15, checks }
}

function evaluateObservability(config: ForgeServerConfig, probe: ScorecardProbeInput): ScorecardCategory {
  const checks: ScorecardCheck[] = []

  // OTEL exporter
  if (probe.otelExporterConfigured !== undefined) {
    checks.push(
      probe.otelExporterConfigured
        ? passCheck('OTEL exporter', 'OpenTelemetry exporter is configured')
        : failCheck('OTEL exporter', 'No OTEL exporter configured'),
    )
  } else {
    checks.push(skipCheck('OTEL exporter', 'Not evaluated'))
  }

  // Health checks (these are always present in the server)
  checks.push(passCheck('Health checks', 'Health endpoints are available (/api/health, /api/health/ready)'))

  // Error alerting
  if (probe.errorAlertingConfigured !== undefined) {
    checks.push(
      probe.errorAlertingConfigured
        ? passCheck('Error alerting', 'Error alerting is configured')
        : failCheck('Error alerting', 'No error alerting configured'),
    )
  } else {
    checks.push(skipCheck('Error alerting', 'Not evaluated'))
  }

  // Metrics collection
  if (config.metrics) {
    checks.push(passCheck('Metrics collection', 'Metrics collector is active'))
  } else {
    checks.push(failCheck('Metrics collection', 'No metrics collector configured'))
  }

  return { name: 'Observability', score: categoryScore(checks), weight: 0.20, checks }
}

function evaluateSecurity(config: ForgeServerConfig, probe: ScorecardProbeInput): ScorecardCategory {
  const checks: ScorecardCheck[] = []

  // Auth middleware
  if (config.auth) {
    if (config.auth.mode === 'api-key') {
      checks.push(passCheck('Auth middleware', 'API key authentication is active'))
    } else {
      checks.push(warnCheck('Auth middleware', `Auth mode is "${config.auth.mode}" — no enforcement`, 20))
    }
  } else {
    checks.push(failCheck('Auth middleware', 'No authentication configured'))
  }

  // CORS configuration
  if (probe.corsRestricted !== undefined) {
    checks.push(
      probe.corsRestricted
        ? passCheck('CORS configuration', 'CORS is properly restricted')
        : warnCheck('CORS configuration', 'CORS allows all origins', 30),
    )
  } else {
    // Infer from config
    const origins = config.corsOrigins
    if (origins && origins !== '*') {
      checks.push(passCheck('CORS configuration', 'CORS origins are restricted', { origins }))
    } else {
      checks.push(warnCheck('CORS configuration', 'CORS allows all origins (wildcard or unset)', 30))
    }
  }

  // API key rotation
  if (probe.apiKeyRotationEnabled !== undefined) {
    checks.push(
      probe.apiKeyRotationEnabled
        ? passCheck('API key rotation', 'API key rotation is enabled')
        : warnCheck('API key rotation', 'API key rotation not enabled', 40),
    )
  } else {
    checks.push(skipCheck('API key rotation', 'Not evaluated'))
  }

  // RBAC enforcement
  if (probe.rbacEnforcementPresent !== undefined) {
    checks.push(
      probe.rbacEnforcementPresent
        ? passCheck('RBAC enforcement', 'RBAC enforcement is active')
        : warnCheck('RBAC enforcement', 'RBAC enforcement not detected', 30),
    )
  } else {
    checks.push(skipCheck('RBAC enforcement', 'Not evaluated'))
  }

  return { name: 'Security', score: categoryScore(checks), weight: 0.20, checks }
}

// ---------------------------------------------------------------------------
// Recommendation generator
// ---------------------------------------------------------------------------

function generateRecommendations(categories: ScorecardCategory[]): Recommendation[] {
  const recommendations: Recommendation[] = []

  for (const cat of categories) {
    for (const check of cat.checks) {
      if (check.status === 'fail') {
        recommendations.push({
          priority: cat.weight >= 0.20 ? 'critical' : 'high',
          category: cat.name,
          message: check.message,
          action: `Fix: ${check.name} — ${check.message}`,
        })
      } else if (check.status === 'warn') {
        recommendations.push({
          priority: check.score < 40 ? 'high' : 'medium',
          category: cat.name,
          message: check.message,
          action: `Improve: ${check.name}`,
        })
      }
    }
  }

  // Sort by priority
  const priorityOrder: Record<RecommendationPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  }
  recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])

  return recommendations
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

export class IntegrationScorecard {
  private readonly config: ForgeServerConfig
  private readonly probe: ScorecardProbeInput

  constructor(config: ForgeServerConfig, probe?: ScorecardProbeInput) {
    this.config = config
    this.probe = probe ?? {}
  }

  /** Generate the full scorecard report. */
  generate(): ScorecardReport {
    const categories: ScorecardCategory[] = [
      evaluateCoverage(this.probe),
      evaluateSafety(this.config, this.probe),
      evaluateCostControls(this.config, this.probe),
      evaluateObservability(this.config, this.probe),
      evaluateSecurity(this.config, this.probe),
    ]

    // Weighted average (skip categories where all checks were skipped)
    let weightedSum = 0
    let totalWeight = 0
    for (const cat of categories) {
      const hasScored = cat.checks.some((c) => c.status !== 'skip')
      if (hasScored) {
        weightedSum += cat.score * cat.weight
        totalWeight += cat.weight
      }
    }

    const overallScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0

    return {
      generatedAt: new Date(),
      overallScore,
      grade: computeGrade(overallScore),
      categories,
      recommendations: generateRecommendations(categories),
    }
  }
}
