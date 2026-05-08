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
