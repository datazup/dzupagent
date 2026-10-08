import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  definePrimitiveV2,
  extendPrimitiveRegistryV2,
  primitiveKind,
  type PrimitiveDefinitionV2,
  type PrimitiveDefinitionV2Input,
  type PrimitiveRegistryV2,
} from "@dzupagent/flow-dsl";
import type { PrimitivePolicyLimits } from "@dzupagent/flow-dsl/v2-policy-narrowing";

import type { CompilerOptions } from "./types.js";
import {
  createFileV2InactiveLocalHostStore,
  runV2InactiveLocalHost,
  V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
  type V2InactiveLocalHandlerBinding,
  type V2InactiveLocalHostError,
} from "./v2-inactive-local-target.js";

/**
 * `dzupagent-run <flow.yaml> --config <run.json> [--max-steps <n>]`
 *
 * Runs one `dzupflow/v2` document through the inactive provider-free local
 * host with a file-based checkpoint store. The run is configured only by the
 * closed `run.json` contract below; handler code identity is computed from the
 * module bytes and never read from config. The CLI adds no authority.
 */

export const DZUPAGENT_RUN_CONFIG_KEYS = Object.freeze([
  "runId",
  "ownerId",
  "checkpointDirectory",
  "initialState",
  "inheritedPolicy",
  "conditionBindings",
  "compilerOptions",
  "hostCapabilities",
  "primitives",
  "handlers",
  "config",
] as const);

const POLICY_KEYS = new Set(["timeoutMs", "budgetCents", "requireApproval"]);
const COMPILER_OPTION_KEYS = new Set([
  "referencePortBindings",
  "referenceTypeBindings",
]);
const HANDLER_KEYS = new Set(["ref", "module"]);
/** Every config input the host binds into a run's plan and checkpoint chain. */
const CHECKPOINT_BOUND_KEYS = Object.freeze([
  "handlers",
  "primitives",
  "initialState",
  "inheritedPolicy",
  "conditionBindings",
  "compilerOptions",
  "config",
]);

const EMPTY_TOOL_RESOLVER = {
  resolve: () => null,
  listAvailable: () => [],
};

export type DzupagentRunErrorCode =
  | "DZUPAGENT_RUN_ARGS_INVALID"
  | "DZUPAGENT_RUN_READ_FAILED"
  | "DZUPAGENT_RUN_CONFIG_INVALID"
  | "DZUPAGENT_RUN_PRIMITIVE_INVALID"
  | "DZUPAGENT_RUN_HANDLER_INVALID";

export interface DzupagentRunDiagnostic {
  readonly code: DzupagentRunErrorCode | V2InactiveLocalHostError["code"];
  readonly message: string;
  /** The `run.json` key or CLI argument the diagnostic is about. */
  readonly key?: string;
  /** Config keys that may have drifted when no single key is attributable. */
  readonly keys?: readonly string[];
  readonly path?: string;
  readonly causes?: readonly string[];
}

export interface DzupagentRunCliResult {
  readonly exitCode: 0 | 1;
  /** The host receipt as JSON on success; empty on failure. */
  readonly stdout: string;
  /** `{ ok: false, errors }` as JSON on failure; empty on success. */
  readonly stderr: string;
}

export interface DzupagentRunCliOptions {
  /** Module loader seam; defaults to native dynamic `import()`. */
  readonly importModule?: (url: string) => Promise<unknown>;
}

interface DzupagentRunConfig {
  readonly runId: string;
  readonly ownerId: string;
  readonly checkpointDirectory: string;
  readonly initialState?: Readonly<Record<string, unknown>>;
  readonly inheritedPolicy?: PrimitivePolicyLimits;
  readonly conditionBindings: Readonly<Record<string, unknown>>;
  readonly compilerOptions: Pick<
    CompilerOptions,
    "referencePortBindings" | "referenceTypeBindings"
  >;
  readonly hostCapabilities: readonly string[];
  readonly primitives: readonly string[];
  readonly handlers: readonly { readonly ref: string; readonly module: string }[];
  /** Values for the document's `config:` references; the host validates them. */
  readonly config?: Readonly<Record<string, string>>;
}

class RunFailure extends Error {
  constructor(readonly diagnostic: DzupagentRunDiagnostic) {
    super(diagnostic.message);
  }
}

export async function runDzupagentRunCli(
  argv: readonly string[],
  options: DzupagentRunCliOptions = {}
): Promise<DzupagentRunCliResult> {
  try {
    const args = parseArgs(argv);
    const source = await readText(args.flow, "flow");
    const configText = await readText(args.config, "--config");
    const config = parseConfig(configText);
    const configDirectory = dirname(resolve(args.config));
    const primitives = await loadPrimitives(config.primitives, configDirectory);
    const registry = buildRegistry(primitives);
    const handlers = await loadHandlers(
      config.handlers,
      configDirectory,
      registry,
      options.importModule ?? ((url) => import(url))
    );

    const result = await runV2InactiveLocalHost({
      runId: config.runId,
      ownerId: config.ownerId,
      source,
      compilerOptions: {
        ...config.compilerOptions,
        toolResolver: EMPTY_TOOL_RESOLVER,
        referencePolicy: "strict",
        primitiveRegistry: registry,
        primitiveBindings: Object.fromEntries(
          primitives.map((definition) => [
            primitiveKind(definition),
            {
              ref: definition.ref,
              semanticHash: definition.compatibility.semanticHash,
            },
          ])
        ),
      },
      hostCapabilities: config.hostCapabilities,
      conditionBindings: config.conditionBindings,
      ...(config.initialState === undefined
        ? {}
        : { initialState: config.initialState }),
      ...(config.inheritedPolicy === undefined
        ? {}
        : { inheritedPolicy: config.inheritedPolicy }),
      ...(config.config === undefined ? {} : { configBindings: config.config }),
      handlers,
      checkpointStore: createFileV2InactiveLocalHostStore({
        rootDirectory: resolve(configDirectory, config.checkpointDirectory),
      }),
      ...(args.maxSteps === undefined
        ? {}
        : { maxStepsThisRun: args.maxSteps }),
    });
    if (!result.ok) {
      return failed(result.errors.map(attributeHostError));
    }
    const status = result.receipt.status;
    return {
      exitCode: status === "completed" || status === "suspended" ? 0 : 1,
      stdout: `${JSON.stringify(result.receipt, null, 2)}\n`,
      stderr: "",
    };
  } catch (error) {
    if (error instanceof RunFailure) return failed([error.diagnostic]);
    throw error;
  }
}

function parseArgs(argv: readonly string[]): {
  readonly flow: string;
  readonly config: string;
  readonly maxSteps?: number;
} {
  let flow: string | undefined;
  let config: string | undefined;
  let maxSteps: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--config" || arg === "--max-steps") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw argsError(arg, `${arg} requires a value`);
      }
      index += 1;
      if (arg === "--config") {
        config = value;
      } else {
        maxSteps = Number(value);
        if (!Number.isInteger(maxSteps) || maxSteps < 1) {
          throw argsError(arg, "--max-steps must be a positive integer");
        }
      }
    } else if (arg.startsWith("-") || flow !== undefined) {
      throw argsError(arg, `unexpected argument ${arg}`);
    } else {
      flow = arg;
    }
  }
  if (flow === undefined) throw argsError("flow", "a flow file is required");
  if (config === undefined) {
    throw argsError("--config", "--config <run.json> is required");
  }
  return { flow, config, ...(maxSteps === undefined ? {} : { maxSteps }) };
}

function parseConfig(text: string): DzupagentRunConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw configError("root", `run.json is not valid JSON: ${message(error)}`);
  }
  if (!isPlainRecord(raw)) throw configError("root", "run.json must be an object");
  const allowed = new Set<string>(DZUPAGENT_RUN_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw configError(key, `unknown config key "${key}"`);
  }
  for (const key of ["runId", "ownerId", "checkpointDirectory"] as const) {
    if (typeof raw[key] !== "string" || raw[key].length === 0) {
      throw configError(key, `${key} must be a non-empty string`);
    }
  }
  for (const key of ["initialState", "conditionBindings", "config"] as const) {
    if (raw[key] !== undefined && !isPlainRecord(raw[key])) {
      throw configError(key, `${key} must be an object`);
    }
  }
  return {
    runId: raw.runId as string,
    ownerId: raw.ownerId as string,
    checkpointDirectory: raw.checkpointDirectory as string,
    ...(raw.initialState === undefined
      ? {}
      : { initialState: raw.initialState as Record<string, unknown> }),
    ...(raw.inheritedPolicy === undefined
      ? {}
      : { inheritedPolicy: parsePolicy(raw.inheritedPolicy) }),
    conditionBindings: (raw.conditionBindings ?? {}) as Record<string, unknown>,
    compilerOptions: parseCompilerOptions(raw.compilerOptions),
    hostCapabilities: parseCapabilities(raw.hostCapabilities),
    primitives: parsePaths(raw.primitives ?? [], "primitives"),
    handlers: parseHandlers(raw.handlers),
    ...(raw.config === undefined
      ? {}
      : { config: raw.config as Record<string, string> }),
  };
}

function parsePolicy(raw: unknown): PrimitivePolicyLimits {
  if (!isPlainRecord(raw)) {
    throw configError("inheritedPolicy", "inheritedPolicy must be an object");
  }
  for (const [key, value] of Object.entries(raw)) {
    const valid =
      POLICY_KEYS.has(key) &&
      (key === "requireApproval"
        ? typeof value === "boolean"
        : typeof value === "number" && Number.isFinite(value));
    if (!valid) {
      throw configError(
        `inheritedPolicy.${key}`,
        `inheritedPolicy accepts only numeric timeoutMs/budgetCents and boolean requireApproval`
      );
    }
  }
  return raw as PrimitivePolicyLimits;
}

function parseCompilerOptions(
  raw: unknown
): DzupagentRunConfig["compilerOptions"] {
  if (raw === undefined) return {};
  if (!isPlainRecord(raw)) {
    throw configError("compilerOptions", "compilerOptions must be an object");
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!COMPILER_OPTION_KEYS.has(key)) {
      throw configError(
        `compilerOptions.${key}`,
        `compilerOptions accepts only referencePortBindings and referenceTypeBindings`
      );
    }
    if (!isPlainRecord(value)) {
      throw configError(`compilerOptions.${key}`, `${key} must be an object`);
    }
  }
  return raw as DzupagentRunConfig["compilerOptions"];
}

function parseCapabilities(raw: unknown): readonly string[] {
  const expected = [...V2_INACTIVE_LOCAL_TARGET_CAPABILITIES].sort();
  const actual = Array.isArray(raw) ? [...raw].sort() : [];
  if (
    !Array.isArray(raw) ||
    actual.length !== expected.length ||
    actual.some((capability, index) => capability !== expected[index])
  ) {
    throw configError(
      "hostCapabilities",
      `hostCapabilities must be exactly ${expected.join(", ")}`
    );
  }
  return raw as string[];
}

function parsePaths(raw: unknown, key: string): readonly string[] {
  if (!Array.isArray(raw)) throw configError(key, `${key} must be an array`);
  raw.forEach((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      throw configError(`${key}[${index}]`, `${key} entries must be file paths`);
    }
  });
  return raw as string[];
}

function parseHandlers(raw: unknown): DzupagentRunConfig["handlers"] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw configError("handlers", "handlers must be a non-empty array");
  }
  const refs = new Set<string>();
  return raw.map((item: unknown, index) => {
    const key = `handlers[${index}]`;
    if (!isPlainRecord(item)) throw configError(key, `${key} must be an object`);
    for (const field of Object.keys(item)) {
      if (!HANDLER_KEYS.has(field)) {
        throw configError(
          `${key}.${field}`,
          `handlers accept only ref and module; identity and mode are fixed by the CLI`
        );
      }
    }
    if (typeof item.ref !== "string" || !item.ref.startsWith("primitive://")) {
      throw configError(`${key}.ref`, `${key}.ref must be a primitive:// ref`);
    }
    if (refs.has(item.ref)) {
      throw configError(`${key}.ref`, `duplicate handler for ${item.ref}`);
    }
    refs.add(item.ref);
    if (typeof item.module !== "string" || item.module.length === 0) {
      throw configError(`${key}.module`, `${key}.module must be a file path`);
    }
    return { ref: item.ref, module: item.module };
  });
}

async function loadPrimitives(
  paths: readonly string[],
  directory: string
): Promise<readonly PrimitiveDefinitionV2[]> {
  const definitions: PrimitiveDefinitionV2[] = [];
  for (const [index, path] of paths.entries()) {
    const key = `primitives[${index}]`;
    const text = await readText(resolve(directory, path), key);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw primitiveError(key, `primitive definition is not JSON: ${message(error)}`);
    }
    if (!isPlainRecord(raw) || !isPlainRecord(raw.compatibility)) {
      throw primitiveError(key, "primitive definition must be an object with compatibility");
    }
    if ("semanticHash" in raw.compatibility) {
      throw primitiveError(
        key,
        "compatibility.semanticHash is computed by definePrimitiveV2 and must not be supplied"
      );
    }
    try {
      definitions.push(
        definePrimitiveV2(raw as unknown as PrimitiveDefinitionV2Input)
      );
    } catch (error) {
      throw primitiveError(key, message(error));
    }
  }
  return definitions;
}

function buildRegistry(
  definitions: readonly PrimitiveDefinitionV2[]
): PrimitiveRegistryV2 {
  try {
    return extendPrimitiveRegistryV2(BUILT_IN_PRIMITIVE_REGISTRY_V2, definitions);
  } catch (error) {
    throw primitiveError("primitives", message(error));
  }
}

async function loadHandlers(
  entries: DzupagentRunConfig["handlers"],
  directory: string,
  registry: PrimitiveRegistryV2,
  importModule: (url: string) => Promise<unknown>
): Promise<readonly V2InactiveLocalHandlerBinding[]> {
  const handlers: V2InactiveLocalHandlerBinding[] = [];
  for (const [index, entry] of entries.entries()) {
    const ref = entry.ref as V2InactiveLocalHandlerBinding["ref"];
    const definition = registry.get(ref);
    if (definition === undefined) {
      throw configError(
        `handlers[${index}].ref`,
        `no primitive definition is registered for ${entry.ref}`
      );
    }
    const key = `handlers[${index}].module`;
    const path = resolve(directory, entry.module);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      throw handlerError(key, `cannot read handler module: ${message(error)}`);
    }
    const hex = createHash("sha256").update(bytes).digest("hex");
    let loaded: unknown;
    try {
      loaded = await importModule(`${pathToFileURL(path).href}?sha256=${hex}`);
    } catch (error) {
      throw handlerError(key, `cannot import handler module: ${message(error)}`);
    }
    const invoke = (loaded as { readonly default?: unknown } | null)?.default;
    if (typeof invoke !== "function") {
      throw handlerError(key, "handler module must default-export one function");
    }
    handlers.push({
      ref,
      semanticHash: definition.compatibility.semanticHash,
      handlerId: basename(path),
      handlerSha256: `sha256:${hex}`,
      mode: "provider-free-local",
      declaredEffects: "none",
      replay: "safe",
      invoke: invoke as V2InactiveLocalHandlerBinding["invoke"],
    });
  }
  return handlers;
}

function attributeHostError(
  error: V2InactiveLocalHostError
): DzupagentRunDiagnostic {
  if (
    error.code === "V2_LOCAL_HOST_PLAN_INVALID" &&
    error.path.endsWith(".policy")
  ) {
    return { ...error, key: "inheritedPolicy" };
  }
  if (
    error.code === "V2_LOCAL_HOST_REQUEST_INVALID" &&
    (error.path === "configBindings" || error.path.startsWith("configBindings."))
  ) {
    return {
      code: "DZUPAGENT_RUN_CONFIG_INVALID",
      message: error.message,
      key: `config${error.path.slice("configBindings".length)}`,
    };
  }
  if (error.code === "V2_LOCAL_HOST_CHECKPOINT_DRIFT") {
    return {
      ...error,
      message: `${error.message}; the flow or a checkpoint-bound run.json input changed since this runId was first checkpointed (use a new runId or restore the inputs)`,
      keys: CHECKPOINT_BOUND_KEYS,
    };
  }
  return error;
}

async function readText(path: string, key: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new RunFailure({
      code: "DZUPAGENT_RUN_READ_FAILED",
      key,
      message: `cannot read ${path}: ${message(error)}`,
    });
  }
}

function failed(errors: readonly DzupagentRunDiagnostic[]): DzupagentRunCliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${JSON.stringify({ ok: false, errors }, null, 2)}\n`,
  };
}

function argsError(key: string, text: string): RunFailure {
  return new RunFailure({ code: "DZUPAGENT_RUN_ARGS_INVALID", key, message: text });
}

function configError(key: string, text: string): RunFailure {
  return new RunFailure({ code: "DZUPAGENT_RUN_CONFIG_INVALID", key, message: text });
}

function primitiveError(key: string, text: string): RunFailure {
  return new RunFailure({ code: "DZUPAGENT_RUN_PRIMITIVE_INVALID", key, message: text });
}

function handlerError(key: string, text: string): RunFailure {
  return new RunFailure({ code: "DZUPAGENT_RUN_HANDLER_INVALID", key, message: text });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
