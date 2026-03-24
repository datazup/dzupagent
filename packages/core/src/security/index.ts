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
