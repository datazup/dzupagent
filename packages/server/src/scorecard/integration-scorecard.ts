/**
 * Integration Scorecard — generates automated deployment health reports.
 *
 * Inspects a ForgeServerConfig and produces a scored report across five
 * categories: coverage, safety, cost controls, observability, and security.
 * Each category contains individual checks that produce pass/warn/fail/skip
 * results. The overall score is a weighted average.
 */
import type { ForgeServerConfig } from '../composition/types.js'
import {
  collectScorecardProbes,
  type ScorecardProbeCollectionOptions,
  type ScorecardProbeField,
  type ScorecardProbeFieldMetadata,
} from './probe-collector.js'

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
// Optional probe inputs (provided by the caller or collected automatically)
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

export interface IntegrationScorecardOptions extends ScorecardProbeCollectionOptions {
  /** Disable filesystem and environment probe collection. */
  autoCollectProbe?: boolean
}

type ScorecardProbeMetadata = Partial<Record<ScorecardProbeField, ScorecardProbeFieldMetadata>>

const PROBE_FIELDS: ScorecardProbeField[] = [
  'testCoveragePercent',
  'hasCriticalPathTests',
  'hasIntegrationTests',
  'policyEngineConfigured',
  'auditTrailEnabled',
  'secretDetectionActive',
  'inputSanitizationPresent',
  'tokenBudgetLimitsSet',
  'modelFallbackConfigured',
  'otelExporterConfigured',
  'errorAlertingConfigured',
  'corsRestricted',
  'apiKeyRotationEnabled',
  'rbacEnforcementPresent',
]

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

function skipCheck(name: string, message: string, details?: Record<string, unknown>): ScorecardCheck {
  return { name, status: 'skip', score: 0, message, details }
}

function categoryScore(checks: ScorecardCheck[]): number {
  const scored = checks.filter((c) => c.status !== 'skip')
  if (scored.length === 0) return 0
  const total = scored.reduce((sum, c) => sum + c.score, 0)
  return Math.round(total / scored.length)
}

function attachProbeDetails(
  details: Record<string, unknown> | undefined,
  metadata: ScorecardProbeFieldMetadata | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return details
  }

  return {
    ...details,
    probeSource: metadata.source,
    probeReason: metadata.reason,
    ...(metadata.rootDir ? { probeRootDir: metadata.rootDir } : {}),
    ...(metadata.evidence && metadata.evidence.length > 0 ? { probeEvidence: metadata.evidence } : {}),
    ...(metadata.diagnostic ? { probeDiagnostic: metadata.diagnostic } : {}),
  }
}

function resolveProbeContext(
  probe: ScorecardProbeInput | undefined,
  options: IntegrationScorecardOptions | undefined,
): { probe: ScorecardProbeInput; metadata: ScorecardProbeMetadata } {
  const mergedProbe: ScorecardProbeInput = {}
  const metadata: ScorecardProbeMetadata = {}
  const writableProbe = mergedProbe as Record<ScorecardProbeField, number | boolean | undefined>

  if (options?.autoCollectProbe !== false) {
    const collected = collectScorecardProbes({
      rootDir: options?.rootDir,
      env: options?.env,
    })

    Object.assign(mergedProbe, collected.probe)
    Object.assign(metadata, collected.metadata)
  }

  for (const field of PROBE_FIELDS) {
    const value = probe?.[field]
    if (value !== undefined) {
      writableProbe[field] = value
      metadata[field] = {
        source: 'input',
        reason: 'Caller-provided probe input',
      }
    }
  }

  return { probe: mergedProbe, metadata }
}

// ---------------------------------------------------------------------------
// Category evaluators
// ---------------------------------------------------------------------------

function evaluateCoverage(probe: ScorecardProbeInput, metadata: ScorecardProbeMetadata): ScorecardCategory {
  const checks: ScorecardCheck[] = []

  if (probe.testCoveragePercent !== undefined) {
    const pct = probe.testCoveragePercent
    const details = attachProbeDetails({ percent: pct }, metadata.testCoveragePercent)
    if (pct >= 80) {
      checks.push(passCheck('Test coverage', `Coverage is at ${pct}%`, details))
    } else if (pct >= 50) {
      checks.push(warnCheck('Test coverage', `Coverage is ${pct}% — aim for 80%+`, pct, details))
    } else {
      checks.push(failCheck('Test coverage', `Coverage is only ${pct}%`, details))
    }
  } else {
    checks.push(skipCheck('Test coverage', 'Coverage percentage not provided', attachProbeDetails(undefined, metadata.testCoveragePercent)))
  }

  if (probe.hasCriticalPathTests !== undefined) {
    checks.push(
      probe.hasCriticalPathTests
        ? passCheck('Critical path tests', 'Critical-path tests are present', attachProbeDetails(undefined, metadata.hasCriticalPathTests))
        : failCheck('Critical path tests', 'No critical-path tests detected', attachProbeDetails(undefined, metadata.hasCriticalPathTests)),
    )
  } else {
    checks.push(skipCheck('Critical path tests', 'Not evaluated', attachProbeDetails(undefined, metadata.hasCriticalPathTests)))
  }

  if (probe.hasIntegrationTests !== undefined) {
    checks.push(
      probe.hasIntegrationTests
        ? passCheck('Integration tests', 'Integration tests are present', attachProbeDetails(undefined, metadata.hasIntegrationTests))
        : warnCheck('Integration tests', 'No integration tests detected', 30, attachProbeDetails(undefined, metadata.hasIntegrationTests)),
    )
  } else {
    checks.push(skipCheck('Integration tests', 'Not evaluated', attachProbeDetails(undefined, metadata.hasIntegrationTests)))
  }

  return { name: 'Coverage', score: categoryScore(checks), weight: 0.20, checks }
}

function evaluateSafety(config: ForgeServerConfig, probe: ScorecardProbeInput, metadata: ScorecardProbeMetadata): ScorecardCategory {
  const checks: ScorecardCheck[] = []

  if (probe.policyEngineConfigured !== undefined) {
    checks.push(
      probe.policyEngineConfigured
        ? passCheck('Policy engine', 'Policy engine is configured', attachProbeDetails(undefined, metadata.policyEngineConfigured))
        : failCheck('Policy engine', 'No policy engine configured', attachProbeDetails(undefined, metadata.policyEngineConfigured)),
    )
  } else {
    checks.push(skipCheck('Policy engine', 'Not evaluated', attachProbeDetails(undefined, metadata.policyEngineConfigured)))
  }

  if (probe.auditTrailEnabled !== undefined) {
    checks.push(
      probe.auditTrailEnabled
        ? passCheck('Audit trail', 'Audit trail is enabled', attachProbeDetails(undefined, metadata.auditTrailEnabled))
        : failCheck('Audit trail', 'Audit trail is not enabled', attachProbeDetails(undefined, metadata.auditTrailEnabled)),
    )
  } else if (config.metrics || config.eventGateway) {
    checks.push(warnCheck('Audit trail', 'Metrics/events present but dedicated audit trail not confirmed', 50))
  } else {
    checks.push(failCheck('Audit trail', 'No audit trail or event system detected'))
  }

  if (probe.secretDetectionActive !== undefined) {
    checks.push(
      probe.secretDetectionActive
        ? passCheck('Secret detection', 'Secret detection is active', attachProbeDetails(undefined, metadata.secretDetectionActive))
        : failCheck('Secret detection', 'Secret detection not configured', attachProbeDetails(undefined, metadata.secretDetectionActive)),
    )
  } else {
    checks.push(skipCheck('Secret detection', 'Not evaluated', attachProbeDetails(undefined, metadata.secretDetectionActive)))
  }

  if (probe.inputSanitizationPresent !== undefined) {
    checks.push(
      probe.inputSanitizationPresent
        ? passCheck('Input sanitization', 'Input sanitization is present', attachProbeDetails(undefined, metadata.inputSanitizationPresent))
        : failCheck('Input sanitization', 'No input sanitization detected', attachProbeDetails(undefined, metadata.inputSanitizationPresent)),
    )
  } else {
    checks.push(skipCheck('Input sanitization', 'Not evaluated', attachProbeDetails(undefined, metadata.inputSanitizationPresent)))
  }

  return { name: 'Safety', score: categoryScore(checks), weight: 0.25, checks }
}

function evaluateCostControls(config: ForgeServerConfig, probe: ScorecardProbeInput, metadata: ScorecardProbeMetadata): ScorecardCategory {
  const checks: ScorecardCheck[] = []

  if (probe.tokenBudgetLimitsSet !== undefined) {
    checks.push(
      probe.tokenBudgetLimitsSet
        ? passCheck('Token budget limits', 'Token budget limits are set', attachProbeDetails(undefined, metadata.tokenBudgetLimitsSet))
        : failCheck('Token budget limits', 'No token budget limits configured', attachProbeDetails(undefined, metadata.tokenBudgetLimitsSet)),
    )
  } else {
    checks.push(skipCheck('Token budget limits', 'Not evaluated', attachProbeDetails(undefined, metadata.tokenBudgetLimitsSet)))
  }

  if (probe.modelFallbackConfigured !== undefined) {
    checks.push(
      probe.modelFallbackConfigured
        ? passCheck('Model fallback chains', 'Model fallback chains are configured', attachProbeDetails(undefined, metadata.modelFallbackConfigured))
        : warnCheck(
            'Model fallback chains',
            'No model fallback chains configured',
            40,
            attachProbeDetails(undefined, metadata.modelFallbackConfigured),
          ),
    )
  } else {
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

  if (config.rateLimit) {
    checks.push(passCheck('Rate limiting', 'Rate limiting is active', {
      maxRequests: config.rateLimit.maxRequests,
      windowMs: config.rateLimit.windowMs,
    }))
  } else {
    checks.push(failCheck('Rate limiting', 'Rate limiting is not configured'))
  }

  if (config.runQueue) {
    checks.push(passCheck('Quota enforcement', 'Run queue is configured for quota enforcement'))
  } else {
    checks.push(warnCheck('Quota enforcement', 'No run queue — quota enforcement limited', 30))
  }

  return { name: 'Cost Controls', score: categoryScore(checks), weight: 0.15, checks }
}

function evaluateObservability(
  config: ForgeServerConfig,
  probe: ScorecardProbeInput,
  metadata: ScorecardProbeMetadata,
): ScorecardCategory {
  const checks: ScorecardCheck[] = []

  if (probe.otelExporterConfigured !== undefined) {
    checks.push(
      probe.otelExporterConfigured
        ? passCheck('OTEL exporter', 'OpenTelemetry exporter is configured', attachProbeDetails(undefined, metadata.otelExporterConfigured))
        : failCheck('OTEL exporter', 'No OTEL exporter configured', attachProbeDetails(undefined, metadata.otelExporterConfigured)),
    )
  } else {
    checks.push(skipCheck('OTEL exporter', 'Not evaluated', attachProbeDetails(undefined, metadata.otelExporterConfigured)))
  }

  checks.push(passCheck('Health checks', 'Health endpoints are available (/api/health, /api/health/ready)'))

  if (probe.errorAlertingConfigured !== undefined) {
    checks.push(
      probe.errorAlertingConfigured
        ? passCheck('Error alerting', 'Error alerting is configured', attachProbeDetails(undefined, metadata.errorAlertingConfigured))
        : failCheck('Error alerting', 'No error alerting configured', attachProbeDetails(undefined, metadata.errorAlertingConfigured)),
    )
  } else {
    checks.push(skipCheck('Error alerting', 'Not evaluated', attachProbeDetails(undefined, metadata.errorAlertingConfigured)))
  }

  if (config.metrics) {
    checks.push(passCheck('Metrics collection', 'Metrics collector is active'))
  } else {
    checks.push(failCheck('Metrics collection', 'No metrics collector configured'))
  }

  return { name: 'Observability', score: categoryScore(checks), weight: 0.20, checks }
}

function evaluateSecurity(config: ForgeServerConfig, probe: ScorecardProbeInput, metadata: ScorecardProbeMetadata): ScorecardCategory {
  const checks: ScorecardCheck[] = []

  if (config.auth) {
    if (config.auth.mode === 'api-key') {
      checks.push(passCheck('Auth middleware', 'API key authentication is active'))
    } else {
      checks.push(warnCheck('Auth middleware', `Auth mode is "${config.auth.mode}" — no enforcement`, 20))
    }
  } else {
    checks.push(failCheck('Auth middleware', 'No authentication configured'))
  }

  if (probe.corsRestricted !== undefined) {
    checks.push(
      probe.corsRestricted
        ? passCheck('CORS configuration', 'CORS is properly restricted', attachProbeDetails(undefined, metadata.corsRestricted))
        : warnCheck('CORS configuration', 'CORS allows all origins', 30, attachProbeDetails(undefined, metadata.corsRestricted)),
    )
  } else {
    const origins = config.corsOrigins
    if (origins && origins !== '*') {
      checks.push(passCheck('CORS configuration', 'CORS origins are restricted', { origins }))
    } else {
      checks.push(warnCheck('CORS configuration', 'CORS allows all origins (wildcard or unset)', 30))
    }
  }

  if (probe.apiKeyRotationEnabled !== undefined) {
    checks.push(
      probe.apiKeyRotationEnabled
        ? passCheck('API key rotation', 'API key rotation is enabled', attachProbeDetails(undefined, metadata.apiKeyRotationEnabled))
        : warnCheck('API key rotation', 'API key rotation not enabled', 40, attachProbeDetails(undefined, metadata.apiKeyRotationEnabled)),
    )
  } else {
    checks.push(skipCheck('API key rotation', 'Not evaluated', attachProbeDetails(undefined, metadata.apiKeyRotationEnabled)))
  }

  if (probe.rbacEnforcementPresent !== undefined) {
    checks.push(
      probe.rbacEnforcementPresent
        ? passCheck('RBAC enforcement', 'RBAC enforcement is active', attachProbeDetails(undefined, metadata.rbacEnforcementPresent))
        : warnCheck('RBAC enforcement', 'RBAC enforcement not detected', 30, attachProbeDetails(undefined, metadata.rbacEnforcementPresent)),
    )
  } else {
    checks.push(skipCheck('RBAC enforcement', 'Not evaluated', attachProbeDetails(undefined, metadata.rbacEnforcementPresent)))
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
  private readonly probeMetadata: ScorecardProbeMetadata

  constructor(config: ForgeServerConfig, probe?: ScorecardProbeInput, options?: IntegrationScorecardOptions) {
    this.config = config
    const resolved = resolveProbeContext(probe, options)
    this.probe = resolved.probe
    this.probeMetadata = resolved.metadata
  }

  /** Generate the full scorecard report. */
  generate(): ScorecardReport {
    const categories: ScorecardCategory[] = [
      evaluateCoverage(this.probe, this.probeMetadata),
      evaluateSafety(this.config, this.probe, this.probeMetadata),
      evaluateCostControls(this.config, this.probe, this.probeMetadata),
      evaluateObservability(this.config, this.probe, this.probeMetadata),
      evaluateSecurity(this.config, this.probe, this.probeMetadata),
    ]

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
