import type {
  NodeExecutionContext,
  RuntimeToolHandler,
  RuntimeToolHandlerFailureResult,
  RuntimeToolHandlers,
  RuntimeToolHandlerInput,
  RuntimeToolHandlerSuccessResult,
} from "../pipeline-runtime-types.js";
import { errorMessage, requiredString, stateKey } from "./arg-helpers.js";
import { RUNTIME_TOOL_NAMES } from "./constants.js";
import {
  buildAdapterParallelRequest,
  buildAdapterRaceRequest,
  buildAdapterRunRequest,
  buildAdapterSupervisorRequest,
  buildPromptRequest,
  buildShellRunRequest,
  buildValidateRequest,
  buildValidateSchemaRequest,
  buildWorkerDispatchRequest,
  type RuntimeAdapterParallelRequest,
  type RuntimeAdapterRaceRequest,
  type RuntimeAdapterRunRequest,
  type RuntimeAdapterSupervisorRequest,
  type RuntimePromptRequest,
  type RuntimeShellRunRequest,
  type RuntimeToolPort,
  type RuntimeToolPortRequest,
  type RuntimeToolPortResult,
  type RuntimeValidateRequest,
  type RuntimeValidateSchemaRequest,
  type RuntimeWorkerDispatchRequest,
} from "./requests.js";
import { runtimeToolFailure, runtimeToolSuccess } from "./results.js";

export interface RuntimeToolExecutionPorts {
  /** Execute a compiled `validate` runtime leaf, usually by resolving an app-owned validation suite. */
  validate?: RuntimeToolPort<RuntimeValidateRequest>;
  /** Execute a compiled `prompt` runtime leaf against the host's model/provider layer. */
  prompt?: RuntimeToolPort<RuntimePromptRequest>;
  /** Execute a compiled `worker.dispatch` runtime leaf against the host's worker/fleet layer. */
  workerDispatch?: RuntimeToolPort<RuntimeWorkerDispatchRequest>;
  /** Execute a compiled `shell.run` runtime leaf through an app-owned command policy. */
  shellRun?: RuntimeToolPort<RuntimeShellRunRequest>;
  /** Execute a compiled `validate.schema` runtime leaf against an app-owned schema registry. */
  validateSchema?: RuntimeToolPort<RuntimeValidateSchemaRequest>;
  /** Execute a compiled `adapter.run` runtime leaf through an adapter bridge. */
  adapterRun?: RuntimeToolPort<RuntimeAdapterRunRequest>;
  /** Execute a compiled `adapter.race` runtime leaf through an adapter bridge. */
  adapterRace?: RuntimeToolPort<RuntimeAdapterRaceRequest>;
  /** Execute a compiled `adapter.parallel` runtime leaf through an adapter bridge. */
  adapterParallel?: RuntimeToolPort<RuntimeAdapterParallelRequest>;
  /** Execute a compiled `adapter.supervisor` runtime leaf through an adapter bridge. */
  adapterSupervisor?: RuntimeToolPort<RuntimeAdapterSupervisorRequest>;
}

export function createRuntimeToolHandlers(
  ports: RuntimeToolExecutionPorts
): RuntimeToolHandlers {
  return {
    [RUNTIME_TOOL_NAMES.validate]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.validate,
      ports.validate,
      buildValidateRequest
    ),
    [RUNTIME_TOOL_NAMES.prompt]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.prompt,
      ports.prompt,
      buildPromptRequest,
      ({ args, nodeId }) => stateKey(args, "outputKey", nodeId)
    ),
    [RUNTIME_TOOL_NAMES.workerDispatch]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.workerDispatch,
      ports.workerDispatch,
      buildWorkerDispatchRequest,
      ({ args }) =>
        requiredString(args, "outputKey", RUNTIME_TOOL_NAMES.workerDispatch)
    ),
    [RUNTIME_TOOL_NAMES.shellRun]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.shellRun,
      ports.shellRun,
      buildShellRunRequest,
      ({ args }) => requiredString(args, "output", RUNTIME_TOOL_NAMES.shellRun)
    ),
    [RUNTIME_TOOL_NAMES.validateSchema]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.validateSchema,
      ports.validateSchema,
      buildValidateSchemaRequest,
      ({ args }) =>
        requiredString(args, "output", RUNTIME_TOOL_NAMES.validateSchema)
    ),
    [RUNTIME_TOOL_NAMES.adapterRun]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.adapterRun,
      ports.adapterRun,
      buildAdapterRunRequest,
      ({ args }) =>
        requiredString(args, "output", RUNTIME_TOOL_NAMES.adapterRun)
    ),
    [RUNTIME_TOOL_NAMES.adapterRace]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.adapterRace,
      ports.adapterRace,
      buildAdapterRaceRequest,
      ({ args }) =>
        requiredString(args, "output", RUNTIME_TOOL_NAMES.adapterRace)
    ),
    [RUNTIME_TOOL_NAMES.adapterParallel]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.adapterParallel,
      ports.adapterParallel,
      buildAdapterParallelRequest,
      ({ args }) =>
        requiredString(args, "output", RUNTIME_TOOL_NAMES.adapterParallel)
    ),
    [RUNTIME_TOOL_NAMES.adapterSupervisor]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.adapterSupervisor,
      ports.adapterSupervisor,
      buildAdapterSupervisorRequest,
      ({ args }) =>
        requiredString(args, "output", RUNTIME_TOOL_NAMES.adapterSupervisor)
    ),
  };
}

function createPortRuntimeToolHandler<TRequest extends RuntimeToolPortRequest>(
  toolName: string,
  port: RuntimeToolPort<TRequest> | undefined,
  buildRequest: (input: RuntimeToolHandlerInput) => TRequest,
  getStateKey?: (input: {
    args: Record<string, unknown>;
    nodeId: string;
  }) => string | undefined
): RuntimeToolHandler {
  return async (input) => {
    if (port === undefined) {
      return runtimeToolFailure({
        message: `No runtime execution port configured for "${toolName}"`,
        code: "RUNTIME_PORT_MISSING",
        retryable: false,
        metadata: { toolName },
      });
    }

    try {
      const result = await port(buildRequest(input));
      return runtimeToolResultFromPortResult(
        result,
        input.context,
        getStateKey?.({ args: input.arguments, nodeId: input.nodeId })
      );
    } catch (error) {
      return runtimeToolFailure({
        message: errorMessage(error),
        code: "RUNTIME_PORT_FAILED",
        metadata: { toolName },
      });
    }
  };
}

function runtimeToolResultFromPortResult(
  result: RuntimeToolPortResult,
  context: NodeExecutionContext,
  stateKeyValue: string | undefined
): RuntimeToolHandlerSuccessResult | RuntimeToolHandlerFailureResult {
  if ("error" in result) {
    return runtimeToolFailure(result.error, {
      output: result.output,
      providerSessionRefs: result.providerSessionRefs,
    });
  }

  if (stateKeyValue !== undefined) {
    context.state[stateKeyValue] = result.output;
  }

  return runtimeToolSuccess({
    output: result.output,
    providerSessionRefs: result.providerSessionRefs,
    metadata: result.metadata,
  });
}
