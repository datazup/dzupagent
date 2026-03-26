/**
 * Self-correction module --- iterative refinement via drafter/critic loops,
 * adaptive iteration control, and recovery feedback.
 *
 * @module self-correction
 */

export { ReflectionLoop, parseCriticResponse } from './reflection-loop.js'
export type {
  ReflectionConfig,
  ReflectionIteration,
  ReflectionResult,
  ScoreResult,
} from './reflection-loop.js'

export { AdaptiveIterationController } from './iteration-controller.js'
export type { IterationDecision, IterationControllerConfig } from './iteration-controller.js'

export { PipelineStuckDetector } from './pipeline-stuck-detector.js'
export type {
  PipelineStuckConfig,
  PipelineStuckStatus,
  PipelineStuckSummary,
  PipelineSuggestedAction,
} from './pipeline-stuck-detector.js'

export { RecoveryFeedback } from './recovery-feedback.js'
export type { RecoveryLesson, RecoveryFeedbackConfig } from './recovery-feedback.js'

export { createSelfCorrectingExecutor } from './self-correcting-node.js'
export type { SelfCorrectingConfig, SelfCorrectingResult } from './self-correcting-node.js'

export { TrajectoryCalibrator } from './trajectory-calibrator.js'
export type {
  StepReward,
  TrajectoryRecord,
  SuboptimalResult,
  TrajectoryCalibratorConfig,
} from './trajectory-calibrator.js'

export { ErrorDetectionOrchestrator } from './error-detector.js'
export type {
  ErrorSource,
  ErrorSeverity,
  DetectedError,
  ErrorDetectorConfig,
} from './error-detector.js'

export { RootCauseAnalyzer } from './root-cause-analyzer.js'
export type {
  RootCauseReport,
  RootCauseAnalyzerConfig,
  AnalyzeParams,
  HeuristicClassification,
} from './root-cause-analyzer.js'

export { VerificationProtocol, jaccardSimilarity } from './verification-protocol.js'
export type {
  VerificationStrategy,
  VerificationResult,
  VerificationConfig,
} from './verification-protocol.js'

export { ObservabilityCorrectionBridge } from './observability-bridge.js'
export type {
  CorrectionSignal,
  CorrectionSignalType,
  SignalSeverity,
  ObservabilityThresholds,
  ObservabilityBridgeConfig,
} from './observability-bridge.js'
