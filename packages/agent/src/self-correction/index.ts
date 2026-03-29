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

export { SelfLearningPipelineHook } from './self-learning-hook.js'
export type {
  SelfLearningHookConfig,
  HookMetrics,
} from './self-learning-hook.js'

export { PostRunAnalyzer } from './post-run-analyzer.js'
export type {
  RunAnalysis,
  AnalysisResult,
  PostRunAnalyzerConfig,
  AnalysisHistoryEntry,
} from './post-run-analyzer.js'

export { AdaptivePromptEnricher } from './adaptive-prompt-enricher.js'
export type {
  PromptEnrichment,
  EnricherConfig,
  EnrichParams,
  EnrichWithBudgetParams,
} from './adaptive-prompt-enricher.js'

export { StrategySelector } from './strategy-selector.js'
export type {
  FixStrategy,
  StrategyRate,
  StrategyRecommendation,
  StrategySelectorConfig,
} from './strategy-selector.js'

export { SelfLearningRuntime } from './self-learning-runtime.js'
export type {
  SelfLearningConfig,
  SelfLearningRunResult,
} from './self-learning-runtime.js'

export { SpecialistRegistry } from './specialist-registry.js'
export type {
  ModelTier,
  SpecialistVerificationStrategy,
  RiskClass,
  SpecialistConfig,
  NodeConfig,
  SpecialistRegistryConfig,
} from './specialist-registry.js'

export { AgentPerformanceOptimizer } from './performance-optimizer.js'
export type {
  OptimizationDecision,
  PerformanceHistory,
  PerformanceOptimizerConfig,
} from './performance-optimizer.js'

export { LangGraphLearningMiddleware } from './langgraph-middleware.js'
export type {
  LangGraphLearningConfig,
  LearningRunMetrics,
  WrapNodeOptions,
} from './langgraph-middleware.js'

export { OutputRefinementLoop } from './output-refinement.js'
export type {
  RefinementDomain,
  RefinementConfig,
  RefinementIteration,
  RefinementResult,
  ScoreFn,
} from './output-refinement.js'

export { FeedbackCollector } from './feedback-collector.js'
export type {
  FeedbackType,
  FeedbackOutcome,
  FeedbackRecord,
  FeedbackStats,
  FeedbackCollectorConfig,
} from './feedback-collector.js'

export { LearningDashboardService } from './learning-dashboard.js'
export type {
  LearningOverview,
  QualityTrend,
  CostTrend,
  NodePerformanceSummary,
  LearningDashboard,
  DashboardServiceConfig,
} from './learning-dashboard.js'
