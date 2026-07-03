/**
 * @dzupagent/agent/pipeline — pipeline runtime, validation, checkpoint stores,
 * loop execution, retry policy, analytics, and pre-built templates.
 *
 * Use this subpath when embedding or extending the pipeline runtime without
 * pulling the full agent root barrel.
 */

export { validatePipeline } from './pipeline/pipeline-validator.js'
export { InMemoryPipelineCheckpointStore } from './pipeline/in-memory-checkpoint-store.js'
export { PostgresPipelineCheckpointStore } from './pipeline/postgres-checkpoint-store.js'
export type {
  PostgresClientLike,
  PostgresPipelineCheckpointStoreOptions,
} from './pipeline/postgres-checkpoint-store.js'
export { RedisPipelineCheckpointStore } from './pipeline/redis-checkpoint-store.js'
export type {
  RedisClientLike,
  RedisPipelineCheckpointStoreOptions,
} from './pipeline/redis-checkpoint-store.js'
export { PipelineRuntime } from './pipeline/pipeline-runtime.js'
export {
  RUNTIME_TOOL_PREFIX,
  RUNTIME_TOOL_NAMES,
  RUNTIME_TOOL_RESULT_MARKER,
  createRuntimeToolHandlers,
  createRuntimeToolNodeExecutor,
  createRuntimeValidatePort,
  formatRuntimeToolReadinessError,
  getRuntimeToolReadiness,
  isRuntimeToolNode,
  runtimeToolFailure,
  runtimeToolSuccess,
} from './pipeline/runtime-tool-handlers.js'
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
  RuntimeValidatePortOptions,
  RuntimeValidateRequest,
  RuntimeValidationCommand,
  RuntimeValidationCommandResult,
  RuntimeValidationCommandRunner,
  RuntimeValidationSuite,
  RuntimeValidationSuiteResolver,
  RuntimeWorkerDispatchRequest,
} from './pipeline/runtime-tool-handlers.js'
export { executeLoop, stateFieldTruthy, qualityBelow, hasErrors } from './pipeline/loop-executor.js'
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
  RetryPolicy,
  OTelSpanLike,
  PipelineTracer,
} from './pipeline/pipeline-runtime-types.js'

// --- Step type registry ---
export { StepTypeRegistry, defaultStepTypeRegistry } from './pipeline/step-type-registry.js'
export type { StepContext, StepTypeDescriptor } from './pipeline/step-type-registry.js'

// --- Retry policy ---
export {
  DEFAULT_RETRY_POLICY,
  calculateBackoff,
  isRetryable,
  resolveRetryPolicy,
} from './pipeline/retry-policy.js'

// --- Templates ---
export {
  createCodeReviewPipeline,
  createFeatureGenerationPipeline,
  createTestGenerationPipeline,
  createRefactoringPipeline,
} from './pipeline/pipeline-templates.js'
export type {
  CodeReviewPipelineOptions,
  FeatureGenerationPipelineOptions,
  TestGenerationPipelineOptions,
  RefactoringPipelineOptions,
} from './pipeline/pipeline-templates.js'

// --- Analytics ---
export { PipelineAnalytics } from './pipeline/pipeline-analytics.js'
export type {
  NodeMetrics,
  BottleneckEntry,
  PipelineAnalyticsReport,
  AnalyticsNodeResult,
  AnalyticsRunInput,
} from './pipeline/pipeline-analytics.js'
