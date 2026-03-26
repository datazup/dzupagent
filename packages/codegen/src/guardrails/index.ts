/**
 * Architecture Guardrail Engine — module barrel.
 */

// Types
export type {
  GuardrailCategory,
  GuardrailSeverity,
  GeneratedFile,
  ProjectStructure,
  PackageInfo,
  ConventionSet,
  FileNamingPattern,
  ExportNamingPattern,
  ImportStylePattern,
  RequiredPattern,
  GuardrailContext,
  GuardrailViolation,
  GuardrailResult,
  GuardrailRule,
  GuardrailReport,
} from './guardrail-types.js'

// Engine
export { GuardrailEngine } from './guardrail-engine.js'
export type { GuardrailEngineConfig } from './guardrail-engine.js'

// Convention Learner
export { ConventionLearner } from './convention-learner.js'
export type { ConventionLearnerConfig } from './convention-learner.js'

// Reporter
export { GuardrailReporter } from './guardrail-reporter.js'
export type { ReportFormat, ReporterConfig } from './guardrail-reporter.js'

// Built-in Rules
export {
  createBuiltinRules,
  createLayeringRule,
  createImportRestrictionRule,
  createNamingConventionRule,
  createSecurityRule,
  createTypeSafetyRule,
  createContractComplianceRule,
} from './rules/index.js'
export type { ImportRestrictionConfig } from './rules/index.js'
