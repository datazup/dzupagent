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
  RUNTIME_TOOL_NAMES,
  RUNTIME_TOOL_RESULT_MARKER,
  createRuntimeToolHandlers,
  createRuntimeToolNodeExecutor,
  createRuntimeJsonSchemaValidationRunner,
  createRuntimeJsonSchemaValidationSuiteResolver,
  createRuntimeShellValidationCommandRunner,
  createRuntimeValidatePort,
  formatRuntimeToolReadinessError,
  getRuntimeToolReadiness,
  isRuntimeToolNode,
  runtimeToolFailure,
  runtimeToolSuccess,
} from './runtime-tool-handlers.js'
export type {
  RuntimeAdapterParallelRequest,
  RuntimeAdapterRaceRequest,
  RuntimeAdapterRunRequest,
  RuntimeAdapterSupervisorRequest,
  RuntimePromptRequest,
  RuntimeToolExecutionPorts,
  RuntimeToolHandler,
  RuntimeToolHandlerFailureResult,
  RuntimeToolHandlers,
  RuntimeToolHandlerInput,
  RuntimeToolHandlerSuccessResult,
  RuntimeToolPort,
  RuntimeToolPortFailure,
  RuntimeToolPortRequest,
  RuntimeToolPortResult,
  RuntimeToolPortSuccess,
  RuntimeToolStructuredError,
  RuntimeToolReadinessNode,
  RuntimeToolReadinessResult,
  RuntimeJsonSchemaValidationInput,
  RuntimeJsonSchemaValidationResult,
  RuntimeJsonSchemaValidationRunnerOptions,
  RuntimeJsonSchemaValidationSuiteResolverOptions,
  RuntimeJsonSchemaValidator,
  RuntimeShellValidationCommandRunnerOptions,
  RuntimeValidatePortOptions,
  RuntimeValidateRequest,
  RuntimeValidationCommand,
  RuntimeValidationCommandResult,
  RuntimeValidationCommandRunner,
  RuntimeValidationSuite,
  RuntimeValidationSuiteResolver,
  RuntimeWorkerDispatchRequest,
} from './runtime-tool-handlers.js'
export { executeLoop, stateFieldTruthy, qualityBelow, hasErrors } from './loop-executor.js'
export type {
  PipelineState,
  NodeResult,
  PipelineRunResult,
  NodeExecutor,
  NodeExecutionContext,
  ProviderSessionRef,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
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
