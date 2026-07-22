import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";

import {
  compactRuntimeToolResult,
  errorMessage,
  isRecord,
} from "./arg-helpers.js";
import type {
  RuntimeToolPort,
  RuntimeToolPortFailure,
  RuntimeValidateRequest,
} from "./requests.js";
import type {
  RuntimeShellValidationCommandRunnerOptions,
  RuntimeValidatePortOptions,
  RuntimeValidationCommand,
  RuntimeValidationCommandResult,
  RuntimeValidationCommandRunner,
  RuntimeValidationSuite,
} from "./validation-types.js";

// Re-export the runtime validation type surface plus the schema-validation
// runners so `./validation.js` stays the single import point for consumers.
export type {
  RuntimeAjvLike,
  RuntimeAjvValidationRunnerOptions,
  RuntimeJsonSchemaValidationInput,
  RuntimeJsonSchemaValidationResult,
  RuntimeJsonSchemaValidationRunnerOptions,
  RuntimeJsonSchemaValidationSuiteResolverOptions,
  RuntimeJsonSchemaValidator,
  RuntimeShellValidationCommandRunnerOptions,
  RuntimeValidatePortOptions,
  RuntimeValidationCommand,
  RuntimeValidationCommandResult,
  RuntimeValidationCommandRunner,
  RuntimeValidationSuite,
  RuntimeValidationSuiteRegistry,
  RuntimeValidationSuiteRegistryOptions,
  RuntimeValidationSuiteResolver,
  RuntimeZodLikeSchema,
  RuntimeZodValidationRunnerOptions,
} from "./validation-types.js";

export {
  createRuntimeAjvValidationRunner,
  createRuntimeJsonSchemaValidationRunner,
  createRuntimeJsonSchemaValidationSuiteResolver,
  createRuntimeValidationSuiteRegistry,
  createRuntimeZodValidationRunner,
} from "./schema-validation.js";

export function createRuntimeValidatePort(
  options: RuntimeValidatePortOptions = {}
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
      commandResults.push(
        await runValidationCommand(command, request, options)
      );
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
  options: RuntimeShellValidationCommandRunnerOptions = {}
): RuntimeValidationCommandRunner {
  return async (command, request) => {
    const allowed = await isShellValidationCommandAllowed(
      command,
      request,
      options
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

export const runtimeShellAllowlistPresets = {
  yarnChecks(
    allowCommands: readonly string[] = [
      "yarn typecheck",
      "yarn lint",
      "yarn test",
      "yarn build",
    ]
  ): RuntimeShellValidationCommandRunnerOptions {
    return { allowCommands };
  },
  npmChecks(
    allowCommands: readonly string[] = [
      "npm run typecheck",
      "npm run lint",
      "npm test",
      "npm run build",
    ]
  ): RuntimeShellValidationCommandRunnerOptions {
    return { allowCommands };
  },
  pnpmChecks(
    allowCommands: readonly string[] = [
      "pnpm typecheck",
      "pnpm lint",
      "pnpm test",
      "pnpm build",
    ]
  ): RuntimeShellValidationCommandRunnerOptions {
    return { allowCommands };
  },
} as const;

async function resolveValidationCommands(
  request: RuntimeValidateRequest,
  options: RuntimeValidatePortOptions
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
  suite: RuntimeValidationSuite | RuntimeValidationCommand[]
): RuntimeValidationCommand[] {
  return Array.isArray(suite) ? suite : suite.commands;
}

async function runValidationCommand(
  command: RuntimeValidationCommand,
  request: RuntimeValidateRequest,
  options: RuntimeValidatePortOptions
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
  options: RuntimeShellValidationCommandRunnerOptions
): Promise<boolean> {
  if (options.allowCommands?.includes(command.command)) return true;
  if (options.allowCommand !== undefined) {
    return await options.allowCommand(command, request);
  }
  return false;
}

function executeShellValidationCommand(
  command: RuntimeValidationCommand,
  options: RuntimeShellValidationCommandRunnerOptions
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
      }) as RuntimeValidationCommandResult
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
        stderr: string
      ): void => {
        if (error !== null) {
          resolve(
            compactRuntimeToolResult({
              ...command,
              ok: false,
              exitCode: typeof error.code === "number" ? error.code : undefined,
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
            }) as RuntimeValidationCommandResult
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
          }) as RuntimeValidationCommandResult
        );
      }
    );
  });
}

type ParsedRuntimeValidationCommand =
  | { ok: true; file: string; args: string[] }
  | { ok: false; reason: string };

function parseRuntimeValidationCommand(
  command: string
): ParsedRuntimeValidationCommand {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: "'" | '"' | undefined;
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

    if (char === "'" || char === '"') {
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
      return {
        ok: false,
        reason: `unsupported shell control character "${char}"`,
      };
    }

    current += char;
    hasToken = true;
  }

  if (escaped) return { ok: false, reason: "unterminated escape sequence" };
  if (quote !== undefined)
    return { ok: false, reason: "unterminated quoted string" };
  if (hasToken) tokens.push(current);
  if (tokens.length === 0) return { ok: false, reason: "empty command" };

  const [file, ...args] = tokens;
  return { ok: true, file: file!, args };
}

function isShellControlCharacter(char: string): boolean {
  return (
    char === "&" ||
    char === "|" ||
    char === ";" ||
    char === "<" ||
    char === ">" ||
    char === "`"
  );
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
        kind: kind === "shell" || kind === "schema" ? kind : undefined,
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
      }) as RuntimeValidationCommand
    );
  }
  return commands;
}
