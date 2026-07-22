import {
  compactRuntimeToolResult,
  errorMessage,
  isZodLikeSchema,
} from "./arg-helpers.js";
import type {
  RuntimeAjvValidationRunnerOptions,
  RuntimeJsonSchemaValidationInput,
  RuntimeJsonSchemaValidationRunnerOptions,
  RuntimeJsonSchemaValidationSuiteResolverOptions,
  RuntimeValidationCommandResult,
  RuntimeValidationCommandRunner,
  RuntimeValidationSuiteRegistry,
  RuntimeValidationSuiteRegistryOptions,
  RuntimeValidationSuiteResolver,
  RuntimeZodValidationRunnerOptions,
} from "./validation-types.js";

export function createRuntimeJsonSchemaValidationSuiteResolver(
  options: RuntimeJsonSchemaValidationSuiteResolverOptions
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
  options: RuntimeJsonSchemaValidationRunnerOptions
): RuntimeValidationCommandRunner {
  return async (command, request) => {
    const schemaRef =
      command.schemaRef ?? schemaRefFromCommand(command.command);
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
    const data =
      command.data ??
      options.selectData?.(request, command) ??
      request.context.state;

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
  options: RuntimeValidationSuiteRegistryOptions
): RuntimeValidationSuiteRegistry {
  return {
    resolveSuite: async (ref) => options.suites[ref],
  };
}

export function createRuntimeAjvValidationRunner(
  options: RuntimeAjvValidationRunnerOptions
): RuntimeValidationCommandRunner {
  return createRuntimeJsonSchemaValidationRunner(
    compactRuntimeToolResult({
      schemas: options.schemas,
      selectData: options.selectData,
      validate: async ({ schema, data }: RuntimeJsonSchemaValidationInput) => {
        const ok = await options.ajv.validate(schema, data);
        return {
          ok,
          errors: ok ? undefined : options.ajv.errors,
        };
      },
    }) as RuntimeJsonSchemaValidationRunnerOptions
  );
}

export function createRuntimeZodValidationRunner(
  options: RuntimeZodValidationRunnerOptions
): RuntimeValidationCommandRunner {
  return createRuntimeJsonSchemaValidationRunner(
    compactRuntimeToolResult({
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
    }) as RuntimeJsonSchemaValidationRunnerOptions
  );
}

function schemaRefFromCommand(command: string): string | undefined {
  if (!command.startsWith("schema:")) return undefined;
  const schemaRef = command.slice("schema:".length);
  return schemaRef.length > 0 ? schemaRef : undefined;
}
