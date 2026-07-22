import { ForgeError } from "@dzupagent/core/events";

import type {
  NodeExecutionContext,
  ProviderSessionRef,
  RuntimeToolHandlerInput,
  RuntimeToolStructuredError,
} from "../pipeline-runtime-types.js";
import {
  compactRuntimeToolResult,
  optionalBoolean,
  optionalRecord,
  optionalSchema,
  optionalString,
  optionalStringArray,
  requiredString,
  requiredStringArray,
} from "./arg-helpers.js";
import { RUNTIME_TOOL_NAMES } from "./constants.js";

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

export interface RuntimeShellRunRequest extends RuntimeToolPortRequest {
  command: string;
  output: string;
}

export interface RuntimeValidateSchemaRequest extends RuntimeToolPortRequest {
  source: string;
  schema: string | Record<string, unknown>;
  output: string;
}

export interface RuntimeAdapterRunRequest extends RuntimeToolPortRequest {
  provider?: string;
  tags?: string[];
  model?: string;
  tools?: boolean;
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
  tools?: boolean;
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
  tools?: boolean;
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
  request: TRequest
) => Promise<RuntimeToolPortResult>;

export function buildValidateRequest(
  input: RuntimeToolHandlerInput
): RuntimeValidateRequest {
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

export function buildPromptRequest(
  input: RuntimeToolHandlerInput
): RuntimePromptRequest {
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

export function buildWorkerDispatchRequest(
  input: RuntimeToolHandlerInput
): RuntimeWorkerDispatchRequest {
  const args = input.arguments;
  return compactRuntimeToolResult({
    nodeId: input.nodeId,
    arguments: args,
    context: input.context,
    dispatchId: requiredString(
      args,
      "dispatchId",
      RUNTIME_TOOL_NAMES.workerDispatch
    ),
    provider: requiredString(
      args,
      "provider",
      RUNTIME_TOOL_NAMES.workerDispatch
    ),
    model: optionalString(args, "model"),
    systemPrompt: optionalString(args, "systemPrompt"),
    instructions: requiredString(
      args,
      "instructions",
      RUNTIME_TOOL_NAMES.workerDispatch
    ),
    input: optionalRecord(args, "input"),
    commandSurface: optionalString(args, "commandSurface"),
    commandAllowlist: optionalStringArray(args, "commandAllowlist"),
    validationCommand: optionalString(args, "validationCommand"),
    outputKey: requiredString(
      args,
      "outputKey",
      RUNTIME_TOOL_NAMES.workerDispatch
    ),
    resultFormat: optionalString(args, "resultFormat"),
    resultSchema: optionalString(args, "resultSchema"),
  }) as RuntimeWorkerDispatchRequest;
}

export function buildShellRunRequest(
  input: RuntimeToolHandlerInput
): RuntimeShellRunRequest {
  const args = input.arguments;
  return compactRuntimeToolResult({
    nodeId: input.nodeId,
    arguments: args,
    context: input.context,
    command: requiredString(args, "command", RUNTIME_TOOL_NAMES.shellRun),
    output: requiredString(args, "output", RUNTIME_TOOL_NAMES.shellRun),
  }) as RuntimeShellRunRequest;
}

export function buildValidateSchemaRequest(
  input: RuntimeToolHandlerInput
): RuntimeValidateSchemaRequest {
  const args = input.arguments;
  const schema = optionalSchema(args, "schema");
  if (schema === undefined) {
    throw new ForgeError({
      code: "VALIDATION_FAILED",
      message: `${RUNTIME_TOOL_NAMES.validateSchema}.schema must be a schema ref string or object`,
      context: { tool: RUNTIME_TOOL_NAMES.validateSchema, argument: "schema" },
    });
  }
  return compactRuntimeToolResult({
    nodeId: input.nodeId,
    arguments: args,
    context: input.context,
    source: requiredString(args, "source", RUNTIME_TOOL_NAMES.validateSchema),
    schema,
    output: requiredString(args, "output", RUNTIME_TOOL_NAMES.validateSchema),
  }) as RuntimeValidateSchemaRequest;
}

export function buildAdapterRunRequest(
  input: RuntimeToolHandlerInput
): RuntimeAdapterRunRequest {
  const args = input.arguments;
  return compactRuntimeToolResult({
    ...commonAdapterRequest(input, RUNTIME_TOOL_NAMES.adapterRun),
    provider: optionalString(args, "provider"),
    tags: optionalStringArray(args, "tags"),
    instructions: requiredString(
      args,
      "instructions",
      RUNTIME_TOOL_NAMES.adapterRun
    ),
    output: requiredString(args, "output", RUNTIME_TOOL_NAMES.adapterRun),
  }) as RuntimeAdapterRunRequest;
}

export function buildAdapterRaceRequest(
  input: RuntimeToolHandlerInput
): RuntimeAdapterRaceRequest {
  const args = input.arguments;
  return compactRuntimeToolResult({
    ...commonAdapterRequest(input, RUNTIME_TOOL_NAMES.adapterRace),
    providers: requiredStringArray(
      args,
      "providers",
      RUNTIME_TOOL_NAMES.adapterRace
    ),
    instructions: requiredString(
      args,
      "instructions",
      RUNTIME_TOOL_NAMES.adapterRace
    ),
    output: requiredString(args, "output", RUNTIME_TOOL_NAMES.adapterRace),
  }) as RuntimeAdapterRaceRequest;
}

export function buildAdapterParallelRequest(
  input: RuntimeToolHandlerInput
): RuntimeAdapterParallelRequest {
  const args = input.arguments;
  return compactRuntimeToolResult({
    ...commonAdapterRequest(input, RUNTIME_TOOL_NAMES.adapterParallel),
    providers: requiredStringArray(
      args,
      "providers",
      RUNTIME_TOOL_NAMES.adapterParallel
    ),
    merge: optionalString(args, "merge"),
    instructions: requiredString(
      args,
      "instructions",
      RUNTIME_TOOL_NAMES.adapterParallel
    ),
    output: requiredString(args, "output", RUNTIME_TOOL_NAMES.adapterParallel),
  }) as RuntimeAdapterParallelRequest;
}

export function buildAdapterSupervisorRequest(
  input: RuntimeToolHandlerInput
): RuntimeAdapterSupervisorRequest {
  const args = input.arguments;
  return compactRuntimeToolResult({
    ...commonAdapterRequest(input, RUNTIME_TOOL_NAMES.adapterSupervisor),
    goal: requiredString(args, "goal", RUNTIME_TOOL_NAMES.adapterSupervisor),
    specialists: optionalStringArray(args, "specialists"),
    output: requiredString(
      args,
      "output",
      RUNTIME_TOOL_NAMES.adapterSupervisor
    ),
  }) as RuntimeAdapterSupervisorRequest;
}

function commonAdapterRequest(
  input: RuntimeToolHandlerInput,
  _toolName: string
): RuntimeToolPortRequest &
  Pick<
    RuntimeAdapterRunRequest,
    | "model"
    | "tools"
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
    tools: optionalBoolean(args, "tools"),
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
      | "tools"
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
