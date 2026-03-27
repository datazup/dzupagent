/**
 * @dzipagent/core/security — Curated API facade for security, policy,
 * auditing, and data protection capabilities.
 *
 * @example
 * ```ts
 * import {
 *   PolicyEvaluator,
 *   scanForSecrets,
 *   ComplianceAuditLogger,
 * } from '@dzipagent/core/security';
 * ```
 */

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------
export { createRiskClassifier } from '../security/risk-classifier.js'
export type {
  RiskTier,
  RiskClassification,
  RiskClassifierConfig,
  RiskClassifier,
} from '../security/risk-classifier.js'

// ---------------------------------------------------------------------------
// Tool permission tiers
// ---------------------------------------------------------------------------
export {
  DEFAULT_AUTO_APPROVE_TOOLS,
  DEFAULT_LOG_TOOLS,
  DEFAULT_REQUIRE_APPROVAL_TOOLS,
} from '../security/tool-permission-tiers.js'

// ---------------------------------------------------------------------------
// Secrets scanning
// ---------------------------------------------------------------------------
export { scanForSecrets, redactSecrets } from '../security/secrets-scanner.js'
export type { SecretMatch, ScanResult } from '../security/secrets-scanner.js'

// ---------------------------------------------------------------------------
// PII detection
// ---------------------------------------------------------------------------
export { detectPII, redactPII } from '../security/pii-detector.js'
export type { PIIType, PIIMatch, PIIDetectionResult } from '../security/pii-detector.js'

// ---------------------------------------------------------------------------
// Output pipeline (sanitization)
// ---------------------------------------------------------------------------
export { OutputPipeline, createDefaultPipeline } from '../security/output-pipeline.js'
export type { SanitizationStage, OutputPipelineConfig, PipelineResult } from '../security/output-pipeline.js'

// ---------------------------------------------------------------------------
// Compliance Audit Trail (ECO-145)
// ---------------------------------------------------------------------------
export { InMemoryAuditStore, ComplianceAuditLogger } from '../security/audit/index.js'
export type {
  AuditActorType,
  AuditActor,
  AuditResult,
  ComplianceAuditEntry,
  AuditFilter,
  AuditRetentionPolicy,
  IntegrityCheckResult,
  ComplianceAuditStore,
  AuditLoggerConfig,
} from '../security/audit/index.js'

// ---------------------------------------------------------------------------
// Policy engine (ECO-140/141/143)
// ---------------------------------------------------------------------------
export { InMemoryPolicyStore, PolicyEvaluator, PolicyTranslator } from '../security/policy/index.js'
export type {
  PolicyEffect,
  PrincipalType,
  ConditionOperator,
  PolicyCondition,
  PolicyPrincipal,
  PolicyRule,
  PolicySet,
  PolicyContext,
  PolicyDecision,
  PolicyStore,
  PolicyTranslatorConfig,
  PolicyTranslationResult,
} from '../security/policy/index.js'

// ---------------------------------------------------------------------------
// Safety Monitor (ECO-144)
// ---------------------------------------------------------------------------
export { createSafetyMonitor, getBuiltInRules } from '../security/monitor/index.js'
export type {
  SafetyMonitor,
  SafetyMonitorConfig,
  SafetyCategory,
  SafetySeverity,
  SafetyAction,
  SafetyViolation,
  SafetyRule,
} from '../security/monitor/index.js'

// ---------------------------------------------------------------------------
// Memory Poisoning Defense (ECO-147)
// ---------------------------------------------------------------------------
export { createMemoryDefense } from '../security/memory/index.js'
export type {
  MemoryDefense,
  MemoryDefenseConfig,
  MemoryDefenseResult,
  MemoryThreat,
  MemoryThreatAction,
  EncodedContentMatch,
} from '../security/memory/index.js'

// ---------------------------------------------------------------------------
// Enhanced Output Filters (ECO-149)
// ---------------------------------------------------------------------------
export { createHarmfulContentFilter, createClassificationAwareRedactor } from '../security/output/index.js'
export type { HarmfulContentCategory } from '../security/output/index.js'

// ---------------------------------------------------------------------------
// Data Classification (ECO-182)
// ---------------------------------------------------------------------------
export { DataClassifier, DEFAULT_CLASSIFICATION_PATTERNS } from '../security/classification/index.js'
export type {
  ClassificationLevel,
  DataClassificationTag,
  ClassificationPattern,
  ClassificationConfig,
} from '../security/classification/index.js'
