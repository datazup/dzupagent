// --- Audit ---
export {
  InMemoryAuditStore,
  ComplianceAuditLogger,
} from './audit/index.js'
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
} from './audit/index.js'

// --- Policy ---
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
} from './policy/index.js'
export { InMemoryPolicyStore, PolicyEvaluator, PolicyTranslator } from './policy/index.js'

export { scanForSecrets, redactSecrets } from './secrets-scanner.js'
export type { SecretMatch, ScanResult } from './secrets-scanner.js'

export { detectPII, redactPII } from './pii-detector.js'
export type { PIIType, PIIMatch, PIIDetectionResult } from './pii-detector.js'

export { OutputPipeline, createDefaultPipeline } from './output-pipeline.js'
export type { SanitizationStage, OutputPipelineConfig, PipelineResult } from './output-pipeline.js'

export { createRiskClassifier } from './risk-classifier.js'
export type { RiskTier, RiskClassification, RiskClassifierConfig, RiskClassifier } from './risk-classifier.js'
export {
  DEFAULT_AUTO_APPROVE_TOOLS,
  DEFAULT_LOG_TOOLS,
  DEFAULT_REQUIRE_APPROVAL_TOOLS,
} from './tool-permission-tiers.js'

// --- Monitor ---
export { createSafetyMonitor, getBuiltInRules } from './monitor/index.js'
export type {
  SafetyMonitor, SafetyMonitorConfig,
  SafetyCategory, SafetySeverity, SafetyAction, SafetyViolation, SafetyRule,
} from './monitor/index.js'

// --- Memory Defense ---
export { createMemoryDefense } from './memory/index.js'
export type {
  MemoryDefense, MemoryDefenseConfig, MemoryDefenseResult,
  MemoryThreat, MemoryThreatAction, EncodedContentMatch,
} from './memory/index.js'

// --- Enhanced Output Filters ---
export { createHarmfulContentFilter, createClassificationAwareRedactor } from './output/index.js'
export type { HarmfulContentCategory } from './output/index.js'

// --- Data Classification ---
export { DataClassifier, DEFAULT_CLASSIFICATION_PATTERNS } from './classification/index.js'
export type {
  ClassificationLevel,
  DataClassificationTag,
  ClassificationPattern,
  ClassificationConfig,
} from './classification/index.js'
