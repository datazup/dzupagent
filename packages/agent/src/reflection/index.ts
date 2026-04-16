/**
 * Reflection module — post-run analysis and pattern detection.
 *
 * @module reflection
 */

export { RunReflector } from './run-reflector.js'
export type {
  ReflectionScore,
  ReflectionDimensions,
  ReflectionInput,
  ReflectorConfig,
} from './run-reflector.js'

export { ReflectionAnalyzer } from './reflection-analyzer.js'
export type { ReflectionAnalyzerConfig } from './reflection-analyzer.js'

export { InMemoryReflectionStore } from './in-memory-reflection-store.js'

export type {
  ReflectionPattern,
  ReflectionSummary,
  RunReflectionStore,
} from './reflection-types.js'

export { createReflectionLearningBridge, buildWorkflowEventsFromToolStats } from './learning-bridge.js'
export type { ReflectionLearningBridgeConfig } from './learning-bridge.js'
