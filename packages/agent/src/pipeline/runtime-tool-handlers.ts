// Thin dispatcher barrel for the runtime tool-handler family.
//
// The implementation was decomposed (MJ-01 track, DZUPAGENT-ARCH-M-06) into
// leaf modules under ./tool-handlers/*. This file preserves the original
// public import surface — external packages and sibling modules continue to
// import from "./pipeline/runtime-tool-handlers.js" unchanged.

export {
  RUNTIME_TOOL_NAMES,
  RUNTIME_TOOL_PREFIX,
  RUNTIME_TOOL_RESULT_MARKER,
} from "./tool-handlers/constants.js";

export { createRuntimeToolNodeExecutor } from "./tool-handlers/dispatcher.js";

export { isRuntimeToolNode } from "./tool-handlers/node-predicates.js";

export {
  runtimeToolFailure,
  runtimeToolSuccess,
} from "./tool-handlers/results.js";

export {
  createRuntimeToolHandlers,
  type RuntimeToolExecutionPorts,
} from "./tool-handlers/ports.js";

export {
  formatRuntimeToolReadinessError,
  formatRuntimeToolReadinessReport,
  getRuntimeToolReadiness,
  type RuntimeToolReadinessNode,
  type RuntimeToolReadinessResult,
} from "./tool-handlers/readiness.js";

export type {
  RuntimeAdapterParallelRequest,
  RuntimeAdapterRaceRequest,
  RuntimeAdapterRunRequest,
  RuntimeAdapterSupervisorRequest,
  RuntimePromptRequest,
  RuntimeShellRunRequest,
  RuntimeToolPort,
  RuntimeToolPortFailure,
  RuntimeToolPortRequest,
  RuntimeToolPortResult,
  RuntimeToolPortSuccess,
  RuntimeValidateRequest,
  RuntimeValidateSchemaRequest,
  RuntimeWorkerDispatchRequest,
} from "./tool-handlers/requests.js";

export {
  createRuntimeAjvValidationRunner,
  createRuntimeJsonSchemaValidationRunner,
  createRuntimeJsonSchemaValidationSuiteResolver,
  createRuntimeShellValidationCommandRunner,
  createRuntimeValidatePort,
  createRuntimeValidationSuiteRegistry,
  createRuntimeZodValidationRunner,
  runtimeShellAllowlistPresets,
  type RuntimeAjvLike,
  type RuntimeAjvValidationRunnerOptions,
  type RuntimeJsonSchemaValidationInput,
  type RuntimeJsonSchemaValidationResult,
  type RuntimeJsonSchemaValidationRunnerOptions,
  type RuntimeJsonSchemaValidationSuiteResolverOptions,
  type RuntimeJsonSchemaValidator,
  type RuntimeShellValidationCommandRunnerOptions,
  type RuntimeValidatePortOptions,
  type RuntimeValidationCommand,
  type RuntimeValidationCommandResult,
  type RuntimeValidationCommandRunner,
  type RuntimeValidationSuite,
  type RuntimeValidationSuiteRegistry,
  type RuntimeValidationSuiteRegistryOptions,
  type RuntimeValidationSuiteResolver,
  type RuntimeZodLikeSchema,
  type RuntimeZodValidationRunnerOptions,
} from "./tool-handlers/validation.js";

export type {
  RuntimeToolHandler,
  RuntimeToolHandlers,
  RuntimeToolHandlerInput,
  RuntimeToolStructuredError,
  RuntimeToolHandlerSuccessResult,
  RuntimeToolHandlerFailureResult,
} from "./pipeline-runtime-types.js";
