import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import type {
  PipelineDefinition,
  PipelineNode,
  ToolNode,
} from "@dzupagent/core/pipeline";
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
  shellRun: "dzup.runtime.shell.run",
  validateSchema: "dzup.runtime.validate.schema",
  set: "dzup.runtime.set",
  adapterRun: "dzup.runtime.adapter.run",
  adapterRace: "dzup.runtime.adapter.race",
  adapterParallel: "dzup.runtime.adapter.parallel",
  adapterSupervisor: "dzup.runtime.adapter.supervisor",
} as const;

export function createRuntimeToolNodeExecutor(
  fallbackExecutor: NodeExecutor,
  handlers: RuntimeToolHandlers | undefined,
): NodeExecutor {
  return async (nodeId, node, context) => {
    if (isRuntimeSetNode(node)) {
      return executeRuntimeSetNode(nodeId, node as ToolNode, context);
    }

    if (handlers === undefined) return fallbackExecutor(nodeId, node, context);

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

function isRuntimeSetNode(node: PipelineNode): boolean {
  return node.type === "tool" && node.toolName === RUNTIME_TOOL_NAMES.set;
}

function executeRuntimeSetNode(
  nodeId: string,
  node: ToolNode,
  context: NodeExecutionContext,
): NodeResult {
  const startTime = Date.now();
  const assign = node.arguments?.["assign"];
  if (!isRecord(assign)) {
    return runtimeToolError(
      nodeId,
      startTime,
      `${RUNTIME_TOOL_NAMES.set}.assign must be an object`,
    );
  }

  const assigned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(assign)) {
    const resolved = resolveRuntimeSetValue(value, context);
    context.state[key] = resolved;
    assigned[key] = resolved;
  }

  return {
    nodeId,
    output: assigned,
    durationMs: Date.now() - startTime,
  };
}

function resolveRuntimeSetValue(
  value: unknown,
  context: NodeExecutionContext,
): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (exact) return resolveRuntimeSetExpression(exact[1]!, context);
    return value.replace(
      /\{\{\s*([^}]+?)\s*\}\}/g,
      (_match, expression: string) =>
        String(resolveRuntimeSetExpression(expression, context) ?? ""),
    );
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveRuntimeSetValue(item, context));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        resolveRuntimeSetValue(nested, context),
      ]),
    );
  }

  return value;
}

function resolveRuntimeSetExpression(
  expression: string,
  context: NodeExecutionContext,
): unknown {
  const trimmed = expression.trim();
  if (trimmed.startsWith("state.")) {
    return readRuntimePath(context.state, trimmed.slice("state.".length));
  }
  return context.state[trimmed];
}

function readRuntimePath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!isRecord(current)) return undefined;
    return current[segment];
  }, source);
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
  request: TRequest,
) => Promise<RuntimeToolPortResult>;

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

export interface RuntimeToolReadinessNode {
  nodeId: string;
  toolName: string;
  ready: boolean;
  builtIn: boolean;
  stateWriteKeys: string[];
}

export interface RuntimeToolReadinessResult {
  ready: boolean;
  requiredToolNames: string[];
  missingToolNames: string[];
  builtInToolNames: string[];
  expectedStateWriteKeys: string[];
  nodes: RuntimeToolReadinessNode[];
}

export interface RuntimeValidationCommand {
  id?: string;
  command: string;
  kind?: "shell" | "schema";
  schemaRef?: string;
  dataPath?: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
}

export interface RuntimeValidationCommandResult {
  id?: string;
  command: string;
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeValidationSuite {
  ref?: string;
  commands: RuntimeValidationCommand[];
}

export type RuntimeValidationSuiteResolver = (
  ref: string,
  request: RuntimeValidateRequest,
) => Promise<RuntimeValidationSuite | RuntimeValidationCommand[] | undefined>;

export type RuntimeValidationCommandRunner = (
  command: RuntimeValidationCommand,
  request: RuntimeValidateRequest,
) => Promise<boolean | RuntimeValidationCommandResult>;

export interface RuntimeValidatePortOptions {
  suites?: Record<string, RuntimeValidationSuite | RuntimeValidationCommand[]>;
  resolveSuite?: RuntimeValidationSuiteResolver;
  runCommand?: RuntimeValidationCommandRunner;
}

export interface RuntimeShellValidationCommandRunnerOptions {
  /**
   * Exact command strings allowed to execute. Empty/omitted means deny all
   * unless `allowCommand` returns true.
   */
  allowCommands?: readonly string[];
  allowCommand?: (
    command: RuntimeValidationCommand,
    request: RuntimeValidateRequest,
  ) => boolean | Promise<boolean>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface RuntimeJsonSchemaValidationSuiteResolverOptions {
  schemas: Record<string, unknown>;
}

export interface RuntimeJsonSchemaValidationInput {
  schemaRef: string;
  schema: unknown;
  data: unknown;
  command: RuntimeValidationCommand;
  request: RuntimeValidateRequest;
}

export interface RuntimeJsonSchemaValidationResult {
  ok: boolean;
  errors?: unknown;
  metadata?: Record<string, unknown>;
}

export type RuntimeJsonSchemaValidator = (
  input: RuntimeJsonSchemaValidationInput,
) =>
  | boolean
  | RuntimeJsonSchemaValidationResult
  | Promise<boolean | RuntimeJsonSchemaValidationResult>;

export interface RuntimeJsonSchemaValidationRunnerOptions {
  schemas: Record<string, unknown>;
  validate: RuntimeJsonSchemaValidator;
  selectData?: (
    request: RuntimeValidateRequest,
    command: RuntimeValidationCommand,
  ) => unknown;
}

export interface RuntimeValidationSuiteRegistryOptions {
  suites: Record<string, RuntimeValidationSuite | RuntimeValidationCommand[]>;
}

export interface RuntimeValidationSuiteRegistry {
  resolveSuite: RuntimeValidationSuiteResolver;
}

export interface RuntimeAjvLike {
  validate(schema: unknown, data: unknown): boolean | Promise<boolean>;
  errors?: unknown;
}

export interface RuntimeAjvValidationRunnerOptions
  extends Omit<RuntimeJsonSchemaValidationRunnerOptions, "validate"> {
  ajv: RuntimeAjvLike;
}

export interface RuntimeZodLikeSchema {
  safeParse(data: unknown): {
    success: boolean;
    error?: unknown;
  };
}

export interface RuntimeZodValidationRunnerOptions {
  schemas: Record<string, RuntimeZodLikeSchema>;
  selectData?: (
    request: RuntimeValidateRequest,
    command: RuntimeValidationCommand,
  ) => unknown;
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
    [RUNTIME_TOOL_NAMES.shellRun]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.shellRun,
      ports.shellRun,
      buildShellRunRequest,
      ({ args }) => requiredString(args, "output", RUNTIME_TOOL_NAMES.shellRun),
    ),
    [RUNTIME_TOOL_NAMES.validateSchema]: createPortRuntimeToolHandler(
      RUNTIME_TOOL_NAMES.validateSchema,
      ports.validateSchema,
      buildValidateSchemaRequest,
      ({ args }) => requiredString(args, "output", RUNTIME_TOOL_NAMES.validateSchema),
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

export function getRuntimeToolReadiness(
  definition: PipelineDefinition,
  handlers: RuntimeToolHandlers | undefined,
): RuntimeToolReadinessResult {
  const nodes: RuntimeToolReadinessNode[] = [];
  const requiredToolNames: string[] = [];
  const missingToolNames: string[] = [];
  const builtInToolNames: string[] = [];
  const expectedStateWriteKeys: string[] = [];
  const seenRequired = new Set<string>();
  const seenMissing = new Set<string>();
  const seenBuiltIn = new Set<string>();
  const seenStateWrite = new Set<string>();

  for (const node of definition.nodes) {
    if (!isRuntimeToolNode(node)) continue;
    const builtInReady = isRuntimeSetNode(node);
    const stateWriteKeys = runtimeToolStateWriteKeys(node);

    if (!seenRequired.has(node.toolName)) {
      seenRequired.add(node.toolName);
      requiredToolNames.push(node.toolName);
    }
    if (builtInReady && !seenBuiltIn.has(node.toolName)) {
      seenBuiltIn.add(node.toolName);
      builtInToolNames.push(node.toolName);
    }
    for (const key of stateWriteKeys) {
      if (seenStateWrite.has(key)) continue;
      seenStateWrite.add(key);
      expectedStateWriteKeys.push(key);
    }

    const ready = builtInReady || handlers?.[node.toolName] !== undefined;
    nodes.push({
      nodeId: node.id,
      toolName: node.toolName,
      ready,
      builtIn: builtInReady,
      stateWriteKeys,
    });

    if (!ready && !seenMissing.has(node.toolName)) {
      seenMissing.add(node.toolName);
      missingToolNames.push(node.toolName);
    }
  }

  return {
    ready: missingToolNames.length === 0,
    requiredToolNames,
    missingToolNames,
    builtInToolNames,
    expectedStateWriteKeys,
    nodes,
  };
}

function runtimeToolStateWriteKeys(node: ToolNode): string[] {
  const args = node.arguments ?? {};
  if (node.toolName === RUNTIME_TOOL_NAMES.set) {
    const assign = args["assign"];
    return isRecord(assign) ? Object.keys(assign) : [];
  }

  const keyName = runtimeToolStateKeyArgumentName(node.toolName);
  if (keyName === undefined) return [];
  const key = optionalString(args, keyName);
  if (key !== undefined) return [key];

  if (node.toolName === RUNTIME_TOOL_NAMES.prompt) {
    return [node.id];
  }
  return [];
}

function runtimeToolStateKeyArgumentName(toolName: string): string | undefined {
  switch (toolName) {
    case RUNTIME_TOOL_NAMES.prompt:
      return "outputKey";
    case RUNTIME_TOOL_NAMES.workerDispatch:
      return "outputKey";
    case RUNTIME_TOOL_NAMES.shellRun:
    case RUNTIME_TOOL_NAMES.validateSchema:
    case RUNTIME_TOOL_NAMES.adapterRun:
    case RUNTIME_TOOL_NAMES.adapterRace:
    case RUNTIME_TOOL_NAMES.adapterParallel:
    case RUNTIME_TOOL_NAMES.adapterSupervisor:
      return "output";
    default:
      return undefined;
  }
}

export function formatRuntimeToolReadinessError(
  readiness: RuntimeToolReadinessResult,
): string {
  const missingNodes = readiness.nodes.filter((node) => !node.ready);
  if (missingNodes.length === 0) return "Runtime tool handlers are ready.";

  const details = missingNodes
    .map(
      (node) =>
        `missing handler for "${node.toolName}" used by node "${node.nodeId}"`,
    )
    .join("; ");
  return `Runtime tool handlers are not ready: ${details}`;
}

export function createRuntimeValidatePort(
  options: RuntimeValidatePortOptions = {},
): RuntimeToolPort<RuntimeValidateRequest> {
  return async (request) => {
    const commands = await resolveValidationCommands(request, options);
    if ("error" in commands) return commands;

    if (commands.length === 0) {
      return {
        output: {
          valid: true,
          ref: request.ref,
          commandResults: [],
        },
      };
    }

    if (options.runCommand === undefined) {
      return {
        error: {
          message: "No runtime validation command runner configured",
          code: "RUNTIME_VALIDATE_RUNNER_MISSING",
          retryable: false,
          metadata: {
            ref: request.ref,
            commandCount: commands.length,
          },
        },
      };
    }

    const commandResults: RuntimeValidationCommandResult[] = [];
    for (const command of commands) {
      commandResults.push(await runValidationCommand(command, request, options));
    }

    const failed = commandResults.filter((result) => !result.ok);
    const output = {
      valid: failed.length === 0,
      ref: request.ref,
      commandResults,
    };

    if (failed.length === 0) return { output };

    return {
      error: {
        message: "Runtime validation failed",
        code: "RUNTIME_VALIDATE_FAILED",
        retryable: false,
        metadata: compactRuntimeToolResult({
          ref: request.ref,
          failedCommandIds: failed
            .map((result) => result.id)
            .filter((id): id is string => id !== undefined),
          failedCommands: failed.map((result) => result.command),
        }),
      },
      output,
    };
  };
}

export function createRuntimeShellValidationCommandRunner(
  options: RuntimeShellValidationCommandRunnerOptions = {},
): RuntimeValidationCommandRunner {
  return async (command, request) => {
    const allowed = await isShellValidationCommandAllowed(
      command,
      request,
      options,
    );
    if (!allowed) {
      return {
        ...command,
        ok: false,
        error: "Runtime validation command denied by policy",
        metadata: {
          ...(command.metadata ?? {}),
          code: "RUNTIME_VALIDATE_COMMAND_DENIED",
        },
      };
    }

    return executeShellValidationCommand(command, options);
  };
}

export function createRuntimeJsonSchemaValidationSuiteResolver(
  options: RuntimeJsonSchemaValidationSuiteResolverOptions,
): RuntimeValidationSuiteResolver {
  return async (ref) => {
    if (!Object.hasOwn(options.schemas, ref)) return undefined;
    return [
      {
        id: ref,
        command: `schema:${ref}`,
        kind: "schema",
        schemaRef: ref,
      },
    ];
  };
}

export function createRuntimeJsonSchemaValidationRunner(
  options: RuntimeJsonSchemaValidationRunnerOptions,
): RuntimeValidationCommandRunner {
  return async (command, request) => {
    const schemaRef = command.schemaRef ?? schemaRefFromCommand(command.command);
    if (schemaRef === undefined) {
      return {
        ...command,
        ok: false,
        error: "Runtime validation command is not a schema validation command",
        metadata: {
          ...(command.metadata ?? {}),
          code: "RUNTIME_VALIDATE_SCHEMA_COMMAND_INVALID",
        },
      };
    }

    if (!Object.hasOwn(options.schemas, schemaRef)) {
      return {
        ...command,
        id: command.id ?? schemaRef,
        ok: false,
        error: `JSON schema "${schemaRef}" was not found`,
        metadata: {
          ...(command.metadata ?? {}),
          code: "RUNTIME_VALIDATE_SCHEMA_NOT_FOUND",
          schemaRef,
        },
      };
    }

    const schema = options.schemas[schemaRef];
    const data = command.data ?? options.selectData?.(request, command) ?? request.context.state;

    try {
      const validation = await options.validate({
        schemaRef,
        schema,
        data,
        command,
        request,
      });
      const normalized =
        typeof validation === "boolean" ? { ok: validation } : validation;

      return compactRuntimeToolResult({
        ...command,
        id: command.id ?? schemaRef,
        command: command.command,
        ok: normalized.ok,
        error: normalized.ok ? undefined : "JSON schema validation failed",
        metadata: normalized.ok
          ? {
              ...(command.metadata ?? {}),
              ...(normalized.metadata ?? {}),
              schemaRef,
            }
          : {
              ...(command.metadata ?? {}),
              ...(normalized.metadata ?? {}),
              code: "RUNTIME_VALIDATE_SCHEMA_FAILED",
              schemaRef,
              errors: normalized.errors,
            },
      }) as RuntimeValidationCommandResult;
    } catch (error) {
      return {
        ...command,
        id: command.id ?? schemaRef,
        ok: false,
        error: errorMessage(error),
        metadata: {
          ...(command.metadata ?? {}),
          code: "RUNTIME_VALIDATE_SCHEMA_VALIDATOR_FAILED",
          schemaRef,
        },
      };
    }
  };
}

export function createRuntimeValidationSuiteRegistry(
  options: RuntimeValidationSuiteRegistryOptions,
): RuntimeValidationSuiteRegistry {
  return {
    resolveSuite: async (ref) => options.suites[ref],
  };
}

export function createRuntimeAjvValidationRunner(
  options: RuntimeAjvValidationRunnerOptions,
): RuntimeValidationCommandRunner {
  return createRuntimeJsonSchemaValidationRunner(compactRuntimeToolResult({
    schemas: options.schemas,
    selectData: options.selectData,
    validate: async ({ schema, data }: RuntimeJsonSchemaValidationInput) => {
      const ok = await options.ajv.validate(schema, data);
      return {
        ok,
        errors: ok ? undefined : options.ajv.errors,
      };
    },
  }) as RuntimeJsonSchemaValidationRunnerOptions);
}

export function createRuntimeZodValidationRunner(
  options: RuntimeZodValidationRunnerOptions,
): RuntimeValidationCommandRunner {
  return createRuntimeJsonSchemaValidationRunner(compactRuntimeToolResult({
    schemas: options.schemas,
    selectData: options.selectData,
    validate: ({ schema, data }: RuntimeJsonSchemaValidationInput) => {
      if (!isZodLikeSchema(schema)) {
        return {
          ok: false,
          errors: "Configured schema does not expose safeParse(data)",
        };
      }
      const result = schema.safeParse(data);
      return {
        ok: result.success,
        errors: result.success ? undefined : result.error,
      };
    },
  }) as RuntimeJsonSchemaValidationRunnerOptions);
}

export const runtimeShellAllowlistPresets = {
  yarnChecks(
    allowCommands: readonly string[] = [
      "yarn typecheck",
      "yarn lint",
      "yarn test",
      "yarn build",
    ],
  ): RuntimeShellValidationCommandRunnerOptions {
    return { allowCommands };
  },
  npmChecks(
    allowCommands: readonly string[] = [
      "npm run typecheck",
      "npm run lint",
      "npm test",
      "npm run build",
    ],
  ): RuntimeShellValidationCommandRunnerOptions {
    return { allowCommands };
  },
  pnpmChecks(
    allowCommands: readonly string[] = [
      "pnpm typecheck",
      "pnpm lint",
      "pnpm test",
      "pnpm build",
    ],
  ): RuntimeShellValidationCommandRunnerOptions {
    return { allowCommands };
  },
} as const;

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

async function resolveValidationCommands(
  request: RuntimeValidateRequest,
  options: RuntimeValidatePortOptions,
): Promise<RuntimeValidationCommand[] | RuntimeToolPortFailure> {
  const inlineCommands = parseValidationCommands(request.commands);
  if (inlineCommands.length > 0) return inlineCommands;

  if (request.ref === undefined) return [];

  const configuredSuite = options.suites?.[request.ref];
  if (configuredSuite !== undefined) return commandsFromSuite(configuredSuite);

  const resolvedSuite = await options.resolveSuite?.(request.ref, request);
  if (resolvedSuite !== undefined) return commandsFromSuite(resolvedSuite);

  return {
    error: {
      message: `Runtime validation suite "${request.ref}" was not found`,
      code: "RUNTIME_VALIDATE_SUITE_NOT_FOUND",
      retryable: false,
      metadata: { ref: request.ref },
    },
  };
}

function commandsFromSuite(
  suite: RuntimeValidationSuite | RuntimeValidationCommand[],
): RuntimeValidationCommand[] {
  return Array.isArray(suite) ? suite : suite.commands;
}

async function runValidationCommand(
  command: RuntimeValidationCommand,
  request: RuntimeValidateRequest,
  options: RuntimeValidatePortOptions,
): Promise<RuntimeValidationCommandResult> {
  const startTime = Date.now();
  try {
    const result = await options.runCommand!(command, request);
    if (typeof result === "boolean") {
      return {
        ...command,
        ok: result,
        durationMs: Date.now() - startTime,
      };
    }
    return compactRuntimeToolResult({
      ...result,
      id: result.id ?? command.id,
      command: result.command,
      durationMs: result.durationMs ?? Date.now() - startTime,
    }) as RuntimeValidationCommandResult;
  } catch (error) {
    return compactRuntimeToolResult({
      ...command,
      ok: false,
      durationMs: Date.now() - startTime,
      error: errorMessage(error),
    }) as RuntimeValidationCommandResult;
  }
}

async function isShellValidationCommandAllowed(
  command: RuntimeValidationCommand,
  request: RuntimeValidateRequest,
  options: RuntimeShellValidationCommandRunnerOptions,
): Promise<boolean> {
  if (options.allowCommands?.includes(command.command)) return true;
  if (options.allowCommand !== undefined) {
    return await options.allowCommand(command, request);
  }
  return false;
}

function executeShellValidationCommand(
  command: RuntimeValidationCommand,
  options: RuntimeShellValidationCommandRunnerOptions,
): Promise<RuntimeValidationCommandResult> {
  const parsed = parseRuntimeValidationCommand(command.command);
  if (!parsed.ok) {
    return Promise.resolve(
      compactRuntimeToolResult({
        ...command,
        ok: false,
        error: "Runtime validation command could not be parsed safely",
        metadata: {
          ...(command.metadata ?? {}),
          code: "RUNTIME_VALIDATE_COMMAND_UNSAFE",
          reason: parsed.reason,
        },
      }) as RuntimeValidationCommandResult,
    );
  }

  return new Promise((resolve) => {
    execFile(
      parsed.file,
      parsed.args,
      compactRuntimeToolResult({
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
      }),
      (
        error: ExecFileException | null,
        stdout: string,
        stderr: string,
      ): void => {
        if (error !== null) {
          resolve(
            compactRuntimeToolResult({
              ...command,
              ok: false,
              exitCode:
                typeof error.code === "number" ? error.code : undefined,
              stdout,
              stderr,
              error: error.message,
              metadata: {
                ...(command.metadata ?? {}),
                code:
                  error.killed === true
                    ? "RUNTIME_VALIDATE_COMMAND_TIMEOUT"
                    : "RUNTIME_VALIDATE_COMMAND_FAILED",
              },
            }) as RuntimeValidationCommandResult,
          );
          return;
        }

        resolve(
          compactRuntimeToolResult({
            ...command,
            ok: true,
            exitCode: 0,
            stdout,
            stderr,
            metadata: command.metadata,
          }) as RuntimeValidationCommandResult,
        );
      },
    );
  });
}

type ParsedRuntimeValidationCommand =
  | { ok: true; file: string; args: string[] }
  | { ok: false; reason: string };

function parseRuntimeValidationCommand(command: string): ParsedRuntimeValidationCommand {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (escaped) {
      current += char;
      hasToken = true;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
        hasToken = true;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      hasToken = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }

    if (isShellControlCharacter(char)) {
      return { ok: false, reason: `unsupported shell control character "${char}"` };
    }

    current += char;
    hasToken = true;
  }

  if (escaped) return { ok: false, reason: "unterminated escape sequence" };
  if (quote !== undefined) return { ok: false, reason: "unterminated quoted string" };
  if (hasToken) tokens.push(current);
  if (tokens.length === 0) return { ok: false, reason: "empty command" };

  const [file, ...args] = tokens;
  return { ok: true, file: file!, args };
}

function isShellControlCharacter(char: string): boolean {
  return char === "&" || char === "|" || char === ";" || char === "<" || char === ">" || char === "`";
}

function schemaRefFromCommand(command: string): string | undefined {
  if (!command.startsWith("schema:")) return undefined;
  const schemaRef = command.slice("schema:".length);
  return schemaRef.length > 0 ? schemaRef : undefined;
}

function parseValidationCommands(value: unknown): RuntimeValidationCommand[] {
  if (!Array.isArray(value)) return [];
  const commands: RuntimeValidationCommand[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const command = item["command"];
    if (typeof command !== "string" || command.length === 0) continue;
    const id = item["id"];
    const kind = item["kind"];
    const schemaRef = item["schemaRef"];
    const dataPath = item["dataPath"];
    const metadata = item["metadata"];
    commands.push(
      compactRuntimeToolResult({
        id: typeof id === "string" && id.length > 0 ? id : undefined,
        command,
        kind:
          kind === "shell" || kind === "schema"
            ? kind
            : undefined,
        schemaRef:
          typeof schemaRef === "string" && schemaRef.length > 0
            ? schemaRef
            : undefined,
        dataPath:
          typeof dataPath === "string" && dataPath.length > 0
            ? dataPath
            : undefined,
        data: "data" in item ? item["data"] : undefined,
        metadata: isRecord(metadata) ? metadata : undefined,
      }) as RuntimeValidationCommand,
    );
  }
  return commands;
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

function buildShellRunRequest(input: RuntimeToolHandlerInput): RuntimeShellRunRequest {
  const args = input.arguments;
  return compactRuntimeToolResult({
    nodeId: input.nodeId,
    arguments: args,
    context: input.context,
    command: requiredString(args, "command", RUNTIME_TOOL_NAMES.shellRun),
    output: requiredString(args, "output", RUNTIME_TOOL_NAMES.shellRun),
  }) as RuntimeShellRunRequest;
}

function buildValidateSchemaRequest(
  input: RuntimeToolHandlerInput,
): RuntimeValidateSchemaRequest {
  const args = input.arguments;
  const schema = optionalSchema(args, "schema");
  if (schema === undefined) {
    throw new Error(`${RUNTIME_TOOL_NAMES.validateSchema}.schema must be a schema ref string or object`);
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

function isZodLikeSchema(value: unknown): value is RuntimeZodLikeSchema {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
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
