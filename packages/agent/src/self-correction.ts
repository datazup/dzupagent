/**
 * @dzupagent/agent/self-correction — adaptive iteration, reflection, and
 * recovery feedback subsystems.
 *
 * Use this subpath for the full self-correction toolbox: reflection loops,
 * adaptive controllers, error/root-cause analysis, verification protocols,
 * post-run analyzers, prompt enrichers, strategy selection, learning hooks,
 * and dashboards. The root barrel re-exports these symbols (annotated as
 * `@deprecated`) for backwards compatibility.
 */

export { ReflectionLoop, parseCriticResponse } from './self-correction/reflection-loop.js'
export type {
  ReflectionConfig,
  ReflectionIteration,
  ReflectionResult,
  ScoreResult,
} from './self-correction/reflection-loop.js'

export { AdaptiveIterationController } from './self-correction/iteration-controller.js'
export type {
  IterationDecision,
  IterationControllerConfig,
} from './self-correction/iteration-controller.js'

export { createSelfCorrectingExecutor } from './self-correction/self-correcting-node.js'
export type {
  SelfCorrectingConfig,
  SelfCorrectingResult,
} from './self-correction/self-correcting-node.js'

export { ErrorDetectionOrchestrator } from './self-correction/error-detector.js'
export type {
  ErrorSource,
  ErrorSeverity,
  DetectedError,
  ErrorDetectorConfig,
} from './self-correction/error-detector.js'

export { RootCauseAnalyzer } from './self-correction/root-cause-analyzer.js'
export type {
  RootCauseReport,
  RootCauseAnalyzerConfig,
  AnalyzeParams,
  HeuristicClassification,
} from './self-correction/root-cause-analyzer.js'

export { VerificationProtocol, jaccardSimilarity } from './self-correction/verification-protocol.js'
export type {
  VerificationStrategy,
  VerificationResult,
  VerificationConfig,
} from './self-correction/verification-protocol.js'

export { SelfLearningRuntime } from './self-correction/self-learning-runtime.js'
export type {
  SelfLearningConfig,
  SelfLearningRunResult,
} from './self-correction/self-learning-runtime.js'

export { SelfLearningPipelineHook } from './self-correction/self-learning-hook.js'
export type {
  SelfLearningHookConfig,
  HookMetrics,
} from './self-correction/self-learning-hook.js'

export { PostRunAnalyzer } from './self-correction/post-run-analyzer.js'
export type {
  RunAnalysis,
  AnalysisResult,
  PostRunAnalyzerConfig,
  AnalysisHistoryEntry,
} from './self-correction/post-run-analyzer.js'

export { AdaptivePromptEnricher } from './self-correction/adaptive-prompt-enricher.js'
export type {
  PromptEnrichment,
  EnricherConfig,
  EnrichParams,
  EnrichWithBudgetParams,
} from './self-correction/adaptive-prompt-enricher.js'

export { PipelineStuckDetector } from './self-correction/pipeline-stuck-detector.js'
export type {
  PipelineStuckConfig,
  PipelineStuckStatus,
  PipelineStuckSummary,
  PipelineSuggestedAction,
} from './self-correction/pipeline-stuck-detector.js'

export { TrajectoryCalibrator } from './self-correction/trajectory-calibrator.js'
export type {
  StepReward,
  TrajectoryRecord,
  SuboptimalResult,
  TrajectoryCalibratorConfig,
} from './self-correction/trajectory-calibrator.js'

export { ObservabilityCorrectionBridge } from './self-correction/observability-bridge.js'
export type {
  CorrectionSignal,
  CorrectionSignalType,
  SignalSeverity,
  ObservabilityThresholds,
  ObservabilityBridgeConfig,
} from './self-correction/observability-bridge.js'

export { StrategySelector } from './self-correction/strategy-selector.js'
export type {
  FixStrategy,
  StrategyRate,
  StrategyRecommendation,
  StrategySelectorConfig,
} from './self-correction/strategy-selector.js'

export { RecoveryFeedback } from './self-correction/recovery-feedback.js'
export type {
  RecoveryLesson,
  RecoveryFeedbackConfig,
} from './self-correction/recovery-feedback.js'

export { AgentPerformanceOptimizer } from './self-correction/performance-optimizer.js'
export type {
  OptimizationDecision,
  PerformanceHistory,
  PerformanceOptimizerConfig,
} from './self-correction/performance-optimizer.js'

export { LangGraphLearningMiddleware } from './self-correction/langgraph-middleware.js'
export type {
  LangGraphLearningConfig,
  LearningRunMetrics,
  WrapNodeOptions,
} from './self-correction/langgraph-middleware.js'

export { FeedbackCollector } from './self-correction/feedback-collector.js'
export type {
  FeedbackType,
  FeedbackOutcome,
  FeedbackRecord,
  FeedbackStats,
  FeedbackCollectorConfig,
} from './self-correction/feedback-collector.js'

export { LearningDashboardService } from './self-correction/learning-dashboard.js'
export type {
  LearningOverview,
  QualityTrend,
  CostTrend,
  NodePerformanceSummary,
  LearningDashboard,
  DashboardServiceConfig,
} from './self-correction/learning-dashboard.js'
