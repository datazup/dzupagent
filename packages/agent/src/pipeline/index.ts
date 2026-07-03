/**
 * Pipeline module — validation, checkpoint storage, runtime execution,
 * loop execution, and pre-built pipeline templates.
 *
 * @module pipeline
 */

export { validatePipeline } from './pipeline-validator.js'
export { InMemoryPipelineCheckpointStore } from './in-memory-checkpoint-store.js'
export { PostgresPipelineCheckpointStore } from './postgres-checkpoint-store.js'
export type {
  PostgresClientLike,
  PostgresPipelineCheckpointStoreOptions,
} from './postgres-checkpoint-store.js'
export { RedisPipelineCheckpointStore } from './redis-checkpoint-store.js'
export type {
  RedisClientLike,
  RedisPipelineCheckpointStoreOptions,
} from './redis-checkpoint-store.js'
export { PipelineRuntime } from './pipeline-runtime.js'
export {
  RUNTIME_TOOL_PREFIX,
  createRuntimeToolNodeExecutor,
  isRuntimeToolNode,
} from './runtime-tool-handlers.js'
export type {
  RuntimeToolHandler,
  RuntimeToolHandlers,
} from './runtime-tool-handlers.js'
export { executeLoop, stateFieldTruthy, qualityBelow, hasErrors } from './loop-executor.js'
export type {
  PipelineState,
  NodeResult,
  PipelineRunResult,
  NodeExecutor,
  NodeExecutionContext,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
  RuntimeToolHandlerInput,
  PipelineExecutionLogEntry,
  PipelineExecutionLogStore,
  LoopMetrics,
  OTelSpanLike,
  PipelineTracer,
} from './pipeline-runtime-types.js'

// --- Pipeline Templates ---
export {
  createCodeReviewPipeline,
  createFeatureGenerationPipeline,
  createTestGenerationPipeline,
  createRefactoringPipeline,
} from './pipeline-templates.js'
export type {
  CodeReviewPipelineOptions,
  FeatureGenerationPipelineOptions,
  TestGenerationPipelineOptions,
  RefactoringPipelineOptions,
} from './pipeline-templates.js'

// --- Step Type Registry ---
export { StepTypeRegistry, defaultStepTypeRegistry } from './step-type-registry.js'
export type { StepContext, StepTypeDescriptor } from './step-type-registry.js'
