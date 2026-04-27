/**
 * @dzupagent/agent-adapters/learning
 *
 * Learning plane: learning loop, A/B testing, learning router, interaction policy,
 * and enrichment pipeline.
 */

// --- Learning Loop ---
export { AdapterLearningLoop, ExecutionAnalyzer } from './learning/adapter-learning-loop.js'
export type {
  ExecutionRecord,
  ProviderProfile,
  FailurePattern,
  RecoverySuggestion,
  LearningConfig,
  PerformanceReport,
  ProviderComparison,
} from './learning/adapter-learning-loop.js'
export { InMemoryLearningStore } from './learning/in-memory-learning-store.js'
export { FileLearningStore } from './learning/file-learning-store.js'
export type { LearningStore, LearningSnapshot } from './learning/learning-store.js'

// --- Learning Router ---
export { LearningRouter } from './registry/learning-router.js'
export type { LearningRouterConfig } from './registry/learning-router.js'

// --- A/B Testing ---
export {
  ABTestRunner,
  LengthScorer,
  ExactMatchScorer,
  ContainsKeywordsScorer,
} from './testing/ab-test-runner.js'
export type {
  ABTestConfig,
  ABTestCase,
  ABTestVariant,
  ABTestScorer,
  ABTestPlan,
  VariantResult,
  ABTestReport,
  ABVariantSummary,
  ABComparison,
} from './testing/ab-test-runner.js'

// --- Interaction Policy ---
export { InteractionResolver } from './interaction/interaction-resolver.js'
export { classifyInteractionText, detectCliInteraction } from './interaction/interaction-detector.js'
export type { InteractionKind } from './interaction/interaction-detector.js'
export type { InteractionRequest, InteractionResult } from './interaction/interaction-resolver.js'

// --- Enrichment Pipeline ---
export { EnrichmentPipeline } from './enrichment/enrichment-pipeline.js'
export type {
  EnrichmentContext,
  EnrichmentResult,
} from './enrichment/enrichment-pipeline.js'
