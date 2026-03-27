/**
 * Self-correction module — iterative code fix loop with reflection and lesson extraction.
 */

export { SelfCorrectionLoop } from './self-correction-loop.js'
export type { CorrectionEventListeners, SelfCorrectionDeps } from './self-correction-loop.js'
export { ReflectionNode, ReflectionSchema } from './reflection-node.js'
export type { ReflectionNodeConfig, ReflectionResult } from './reflection-node.js'
export { LessonExtractor } from './lesson-extractor.js'
export type { LessonExtractorConfig, LessonExtractionResult } from './lesson-extractor.js'
export type {
  ErrorCategory,
  EvaluationResult,
  Reflection,
  CorrectionIteration,
  CorrectionResult,
  CorrectionContext,
  Lesson,
  SelfCorrectionConfig,
  CodeEvaluator,
  CodeFixer,
  CorrectionIterationEvent,
  CorrectionFixedEvent,
  CorrectionExhaustedEvent,
} from './correction-types.js'
export { DEFAULT_CORRECTION_CONFIG } from './correction-types.js'
