import type { ToolNode } from "@dzupagent/core/pipeline";
import type {
  NodeExecutionContext,
  NodeExecutor,
  NodeResult,
  ProviderSessionRef,
  RuntimeToolHandler,
  RuntimeToolHandlerFailureResult,
  RuntimeToolHandlers,
  RuntimeToolHandlerSuccessResult,
  RuntimeToolStructuredError,
  RuntimeToolHandlerInput,
} from "./pipeline-runtime-types.js";

export const RUNTIME_TOOL_PREFIX = "dzup.runtime.";
export const RUNTIME_TOOL_RESULT_MARKER = "__dzupRuntimeToolResult";

export const RUNTIME_TOOL_NAMES = {
  validate: "dzup.runtime.validate",
  prompt: "dzup.runtime.prompt",
  workerDispatch: "dzup.runtime.worker.dispatch",
  adapterRun: "dzup.runtime.adapter.run",
  adapterRace: "dzup.runtime.adapter.race",
  adapterParallel: "dzup.runtime.adapter.parallel",
  adapterSupervisor: "dzup.runtime.adapter.supervisor",
} as const;

export function createRuntimeToolNodeExecutor(
  fallbackExecutor: NodeExecutor,
  handlers: RuntimeToolHandlers | undefined,
): NodeExecutor {
  if (handlers === undefined) return fallbackExecutor;

  return async (nodeId, node, context) => {
    if (!isRuntimeToolNode(node)) {
      return fallbackExecutor(nodeId, node, context);
    }

    const startTime = Date.now();
    const handler = handlers[node.toolName];
    if (handler === undefined) {
      return runtimeToolError(
        nodeId,
        startTime,
        `No runtime tool handler registered for "${node.toolName}"`,
      );
    }

    try {
      const handlerResult = await handler({
        nodeId,
        node,
        arguments: node.arguments ?? {},
        context,
      });
      return nodeResultFromRuntimeToolResult(
        nodeId,
        startTime,
        handlerResult,
      );
    } catch (error) {
      return runtimeToolError(nodeId, startTime, errorMessage(error));
    }
  };
}

export interface RuntimeToolSuccessOptions {
  output: unknown;
  providerSessionRefs?: ProviderSessionRef[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface RuntimeToolFailureOptions {
  output?: unknown | undefined;
  providerSessionRefs?: ProviderSessionRef[] | undefined;
}

export function runtimeToolSuccess(
  options: RuntimeToolSuccessOptions,
): RuntimeToolHandlerSuccessResult {
  return compactRuntimeToolResult({
    __dzupRuntimeToolResult: true,
    ok: true,
    output: options.output,
    providerSessionRefs: options.providerSessionRefs,
    metadata: options.metadata,
  }) as RuntimeToolHandlerSuccessResult;
}

export function runtimeToolFailure(
  error: string | RuntimeToolStructuredError,
  options: RuntimeToolFailureOptions = {},
): RuntimeToolHandlerFailureResult {
  return compactRuntimeToolResult({
    __dzupRuntimeToolResult: true,
    ok: false,
    error: normalizeRuntimeToolError(error),
    output: options.output,
    providerSessionRefs: options.providerSessionRefs,
  }) as RuntimeToolHandlerFailureResult;
}

export interface RuntimeToolPortRequest {
  nodeId: string;
  arguments: Record<string, unknown>;
  context: NodeExecutionContext;
}

export interface RuntimeValidateRequest extends RuntimeToolPortRequest {
  ref?: string;
  commands?: unknown;
  repair?: unknown;
}

export interface RuntimePromptRequest extends RuntimeToolPortRequest {
  userPrompt: string;
  systemPrompt?: string;
  outputKey?: string;
  provider?: string;
  model?: string;
  tools?: boolean;
}

export interface RuntimeWorkerDispatchRequest extends RuntimeToolPortRequest {
  dispatchId: string;
  provider: string;
  model?: string;
  systemPrompt?: string;
  instructions: string;
  input?: Record<string, unknown>;
  commandSurface?: string;
  commandAllowlist?: string[];
  validationCommand?: string;
  outputKey: string;
  resultFormat?: string;
  resultSchema?: string;
}

export interface RuntimeAdapterRunRequest extends RuntimeToolPortRequest {
  provider?: string;
  tags?: string[];
  model?: string;
  instructions: string;
  systemPrompt?: string;
  input?: Record<string, unknown>;
  persona?: string;
  reasoning?: string;
  outputSchema?: string | Record<string, unknown>;
  promptPrep?: string;
  idempotency?: string;
  policy?: Record<string, unknown>;
  output: string;
}

export interface RuntimeAdapterRaceRequest extends RuntimeToolPortRequest {
  providers: string[];
  model?: string;
  instructions: string;
  systemPrompt?: string;
  input?: Record<string, unknown>;
  persona?: string;
  reasoning?: string;
  outputSchema?: string | Record<string, unknown>;
  promptPrep?: string;
  idempotency?: string;
  policy?: Record<string, unknown>;
  output: string;
}

export interface RuntimeAdapterParallelRequest
  extends RuntimeAdapterRaceRequest {
  merge?: string;
}

export interface RuntimeAdapterSupervisorRequest
  extends RuntimeToolPortRequest {
  goal: string;
  specialists?: string[];
  model?: string;
  systemPrompt?: string;
  input?: Record<string, unknown>;
  persona?: string;
  reasoning?: string;
  outputSchema?: string | Record<string, unknown>;
  promptPrep?: string;
  idempotency?: string;
  policy?: Record<string, unknown>;
  output: string;
}

export interface RuntimeToolPortSuccess {
  output: unknown;
  providerSessionRefs?: ProviderSessionRef[];
  metadata?: Record<string, unknown>;
}

export interface RuntimeToolPortFailure {
  error: string | RuntimeToolStructuredError;
  output?: unknown;
  providerSessionRefs?: ProviderSessionRef[];
}

export type RuntimeToolPortResult =
  | RuntimeToolPortSuccess
  | RuntimeToolPortFailure;

export type RuntimeToolPort<TRequest extends RuntimeToolPortRequest> = (
  request: TRequest,
) => Promise<RuntimeToolPortResult>;

export interface RuntimeToolExecutionPorts {
  validate?: RuntimeToolPort<RuntimeValidateRequest>;
  prompt?: RuntimeToolPort<RuntimePromptRequest>;
  workerDispatch?: RuntimeToolPort<RuntimeWorkerDispatchRequest>;
  adapterRun?: RuntimeToolPort<RuntimeAdapterRunRequest>;
  adapterRace?: RuntimeToolPort<RuntimeAdapterRaceRequest>;
  adapterParallel?: RuntimeToolPort<RuntimeAdapterParallelRequest>;
  adapterSupervisor?: RuntimeToolPort<RuntimeAdapterSupervisorRequest>;
}

export function createRuntimeToolHandlers(
  ports: RuntimeToolExecutionPorts,
): RuntimeToolHandlers {
  return {
    [RUNTIME_TOOL_NAMES.validate]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.validate,
      ports.validate,
      buildValidateRequest,
    ),
    [RUNTIME_TOOL_NAMES.prompt]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.prompt,
      ports.prompt,
      buildPromptRequest,
      ({ args, nodeId }) => stateKey(args, "outputKey", nodeId),
    ),
    [RUNTIME_TOOL_NAMES.workerDispatch]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.workerDispatch,
      ports.workerDispatch,
      buildWorkerDispatchRequest,
      ({ args }) => requiredString(args, "outputKey", RUNTIME_TOOL_NAMES.workerDispatch),
    ),
    [RUNTIME_TOOL_NAMES.adapterRun]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.adapterRun,
      ports.adapterRun,
      buildAdapterRunRequest,
      ({ args }) => requiredString(args, "output", RUNTIME_TOOL_NAMES.adapterRun),
    ),
    [RUNTIME_TOOL_NAMES.adapterRace]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.adapterRace,
      ports.adapterRace,
      buildAdapterRaceRequest,
      ({ args }) => requiredString(args, "output", RUNTIME_TOOL_NAMES.adapterRace),
    ),
    [RUNTIME_TOOL_NAMES.adapterParallel]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.adapterParallel,
      ports.adapterParallel,
      buildAdapterParallelRequest,
      ({ args }) => requiredString(args, "output", RUNTIME_TOOL_NAMES.adapterParallel),
    ),
    [RUNTIME_TOOL_NAMES.adapterSupervisor]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.adapterSupervisor,
      ports.adapterSupervisor,
      buildAdapterSupervisorRequest,
      ({ args }) => requiredString(args, "output", RUNTIME_TOOL_NAMES.adapterSupervisor),
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
  }) => string | undefined,
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
        getStateKey?.({ args: input.arguments, nodeId: input.nodeId }),
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

function buildValidateRequest(input: RuntimeToolHandlerInput): RuntimeValidateRequest {
  const args = input.arguments;
  return compactRuntimeToolResult({
    nodeId: input.nodeId,
    arguments: args,
    context: input.context,
    ref: optionalString(args, "ref"),
    commands: args["commands"],
    repair: args["repair"],
  }) as RuntimeValidateRequest;
}

function buildPromptRequest(input: RuntimeToolHandlerInput): RuntimePromptRequest {
  const args = input.arguments;
  return compactRuntimeToolResult({
    nodeId: input.nodeId,
    arguments: args,
    context: input.context,
    userPrompt: requiredString(args, "userPrompt", RUNTIME_TOOL_NAMES.prompt),
    systemPrompt: optionalString(args, "systemPrompt"),
    outputKey: optionalString(args, "outputKey"),
    provider: optionalString(args, "provider"),
    model: optionalString(args, "model"),
    tools: optionalBoolean(args, "tools"),
  }) as RuntimePromptRequest;
}

function buildWorkerDispatchRequest(
  input: RuntimeToolHandlerInput,
): RuntimeWorkerDispatchRequest {
  const args = input.arguments;
  return compactRuntimeToolResult({
    nodeId: input.nodeId,
    arguments: args,
    context: input.context,
    dispatchId: requiredString(
      args,
      "dispatchId",
      RUNTIME_TOOL_NAMES.workerDispatch,
    ),
    provider: requiredString(args, "provider", RUNTIME_TOOL_NAMES.workerDispatch),
    model: optionalString(args, "model"),
    systemPrompt: optionalString(args, "systemPrompt"),
    instructions: requiredString(
      args,
      "instructions",
      RUNTIME_TOOL_NAMES.workerDispatch,
    ),
    input: optionalRecord(args, "input"),
    commandSurface: optionalString(args, "commandSurface"),
    commandAllowlist: optionalStringArray(args, "commandAllowlist"),
    validationCommand: optionalString(args, "validationCommand"),
    outputKey: requiredString(
      args,
      "outputKey",
      RUNTIME_TOOL_NAMES.workerDispatch,
    ),
    resultFormat: optionalString(args, "resultFormat"),
    resultSchema: optionalString(args, "resultSchema"),
  }) as RuntimeWorkerDispatchRequest;
}

function buildAdapterRunRequest(
  input: RuntimeToolHandlerInput,
): RuntimeAdapterRunRequest {
  const args = input.arguments;
  return compactRuntimeToolResult({
    ...commonAdapterRequest(input, RUNTIME_TOOL_NAMES.adapterRun),
    provider: optionalString(args, "provider"),
    tags: optionalStringArray(args, "tags"),
    instructions: requiredString(args, "instructions", RUNTIME_TOOL_NAMES.adapterRun),
    output: requiredString(args, "output", RUNTIME_TOOL_NAMES.adapterRun),
  }) as RuntimeAdapterRunRequest;
}

function buildAdapterRaceRequest(
  input: RuntimeToolHandlerInput,
): RuntimeAdapterRaceRequest {
  const args = input.arguments;
  return compactRuntimeToolResult({
    ...commonAdapterRequest(input, RUNTIME_TOOL_NAMES.adapterRace),
    providers: requiredStringArray(
      args,
      "providers",
      RUNTIME_TOOL_NAMES.adapterRace,
    ),
    instructions: requiredString(args, "instructions", RUNTIME_TOOL_NAMES.adapterRace),
    output: requiredString(args, "output", RUNTIME_TOOL_NAMES.adapterRace),
  }) as RuntimeAdapterRaceRequest;
}

function buildAdapterParallelRequest(
  input: RuntimeToolHandlerInput,
): RuntimeAdapterParallelRequest {
  const args = input.arguments;
  return compactRuntimeToolResult({
    ...commonAdapterRequest(input, RUNTIME_TOOL_NAMES.adapterParallel),
    providers: requiredStringArray(
      args,
      "providers",
      RUNTIME_TOOL_NAMES.adapterParallel,
    ),
    merge: optionalString(args, "merge"),
    instructions: requiredString(
      args,
      "instructions",
      RUNTIME_TOOL_NAMES.adapterParallel,
    ),
    output: requiredString(args, "output", RUNTIME_TOOL_NAMES.adapterParallel),
  }) as RuntimeAdapterParallelRequest;
}

function buildAdapterSupervisorRequest(
  input: RuntimeToolHandlerInput,
): RuntimeAdapterSupervisorRequest {
  const args = input.arguments;
  return compactRuntimeToolResult({
    ...commonAdapterRequest(input, RUNTIME_TOOL_NAMES.adapterSupervisor),
    goal: requiredString(args, "goal", RUNTIME_TOOL_NAMES.adapterSupervisor),
    specialists: optionalStringArray(args, "specialists"),
    output: requiredString(args, "output", RUNTIME_TOOL_NAMES.adapterSupervisor),
  }) as RuntimeAdapterSupervisorRequest;
}

function commonAdapterRequest(
  input: RuntimeToolHandlerInput,
  _toolName: string,
): RuntimeToolPortRequest &
  Pick<
    RuntimeAdapterRunRequest,
    | "model"
    | "systemPrompt"
    | "input"
    | "persona"
    | "reasoning"
    | "outputSchema"
    | "promptPrep"
    | "idempotency"
    | "policy"
  > {
  const args = input.arguments;
  return compactRuntimeToolResult({
    nodeId: input.nodeId,
    arguments: args,
    context: input.context,
    model: optionalString(args, "model"),
    systemPrompt: optionalString(args, "systemPrompt"),
    input: optionalRecord(args, "input"),
    persona: optionalString(args, "persona"),
    reasoning: optionalString(args, "reasoning"),
    outputSchema: optionalSchema(args, "outputSchema"),
    promptPrep: optionalString(args, "promptPrep"),
    idempotency: optionalString(args, "idempotency"),
    policy: optionalRecord(args, "policy"),
  }) as RuntimeToolPortRequest &
    Pick<
      RuntimeAdapterRunRequest,
      | "model"
      | "systemPrompt"
      | "input"
      | "persona"
      | "reasoning"
      | "outputSchema"
      | "promptPrep"
      | "idempotency"
      | "policy"
    >;
}

function runtimeToolResultFromPortResult(
  result: RuntimeToolPortResult,
  context: NodeExecutionContext,
  stateKeyValue: string | undefined,
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

function nodeResultFromRuntimeToolResult(
  nodeId: string,
  startTime: number,
  handlerResult: unknown,
): NodeResult {
  if (!isRuntimeToolHandlerResult(handlerResult)) {
    return {
      nodeId,
      output: handlerResult,
      durationMs: Date.now() - startTime,
    };
  }

  if (handlerResult.ok) {
    return compactRuntimeToolResult({
      nodeId,
      output: handlerResult.output,
      durationMs: Date.now() - startTime,
      providerSessionRefs: handlerResult.providerSessionRefs,
    }) as NodeResult;
  }

  return runtimeToolError(
    nodeId,
    startTime,
    handlerResult.error.message,
    runtimeToolErrorMetadata(handlerResult.error),
    handlerResult.providerSessionRefs,
    handlerResult.output,
  );
}

function isRuntimeToolHandlerResult(
  value: unknown,
): value is RuntimeToolHandlerSuccessResult | RuntimeToolHandlerFailureResult {
  return (
    typeof value === "object" &&
    value !== null &&
    RUNTIME_TOOL_RESULT_MARKER in value &&
    (value as Record<string, unknown>)[RUNTIME_TOOL_RESULT_MARKER] === true &&
    "ok" in value &&
    typeof (value as Record<string, unknown>)["ok"] === "boolean"
  );
}

function runtimeToolErrorMetadata(
  error: RuntimeToolStructuredError,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {
    ...(error.code !== undefined ? { code: error.code } : {}),
    ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
    ...(error.metadata ?? {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function normalizeRuntimeToolError(
  error: string | RuntimeToolStructuredError,
): RuntimeToolStructuredError {
  return typeof error === "string" ? { message: error } : error;
}

function stateKey(
  args: Record<string, unknown>,
  key: string,
  fallback: string,
): string | undefined {
  return optionalString(args, key) ?? fallback;
}

function requiredString(
  args: Record<string, unknown>,
  key: string,
  toolName: string,
): string {
  const value = args[key];
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${toolName}.${key} must be a non-empty string`);
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalRecord(
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = args[key];
  return isRecord(value) ? value : undefined;
}

function optionalSchema(
  args: Record<string, unknown>,
  key: string,
): string | Record<string, unknown> | undefined {
  const value = args[key];
  if (typeof value === "string") return value;
  return isRecord(value) ? value : undefined;
}

function optionalStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  return value.every((item): item is string => typeof item === "string")
    ? value
    : undefined;
}

function requiredStringArray(
  args: Record<string, unknown>,
  key: string,
  toolName: string,
): string[] {
  const value = optionalStringArray(args, key);
  if (value !== undefined && value.length > 0) return value;
  throw new Error(`${toolName}.${key} must be a non-empty string array`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactRuntimeToolResult<T extends Record<string, unknown>>(
  value: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

export function isRuntimeToolNode(node: unknown): node is ToolNode {
  return (
    typeof node === "object" &&
    node !== null &&
    "type" in node &&
    node.type === "tool" &&
    "toolName" in node &&
    typeof node.toolName === "string" &&
    node.toolName.startsWith(RUNTIME_TOOL_PREFIX)
  );
}

function runtimeToolError(
  nodeId: string,
  startTime: number,
  error: string,
  errorMetadata?: Record<string, unknown>,
  providerSessionRefs?: ProviderSessionRef[],
  output?: unknown,
): NodeResult {
  return compactRuntimeToolResult({
    nodeId,
    output,
    durationMs: Date.now() - startTime,
    error,
    errorMetadata,
    providerSessionRefs,
  }) as NodeResult;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type {
  RuntimeToolHandler,
  RuntimeToolHandlers,
  RuntimeToolHandlerInput,
  RuntimeToolStructuredError,
  RuntimeToolHandlerSuccessResult,
  RuntimeToolHandlerFailureResult,
};
