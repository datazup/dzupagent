import type { RuntimeValidateRequest } from "./requests.js";
import type { RuntimeZodLikeSchema } from "./schema-shapes.js";

export type { RuntimeZodLikeSchema };

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
  request: RuntimeValidateRequest
) => Promise<RuntimeValidationSuite | RuntimeValidationCommand[] | undefined>;

export type RuntimeValidationCommandRunner = (
  command: RuntimeValidationCommand,
  request: RuntimeValidateRequest
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
    request: RuntimeValidateRequest
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
  input: RuntimeJsonSchemaValidationInput
) =>
  | boolean
  | RuntimeJsonSchemaValidationResult
  | Promise<boolean | RuntimeJsonSchemaValidationResult>;

export interface RuntimeJsonSchemaValidationRunnerOptions {
  schemas: Record<string, unknown>;
  validate: RuntimeJsonSchemaValidator;
  selectData?: (
    request: RuntimeValidateRequest,
    command: RuntimeValidationCommand
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

export interface RuntimeZodValidationRunnerOptions {
  schemas: Record<string, RuntimeZodLikeSchema>;
  selectData?: (
    request: RuntimeValidateRequest,
    command: RuntimeValidationCommand
  ) => unknown;
}
