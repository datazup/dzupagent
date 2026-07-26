import type {
  PrimitiveDefinitionV2,
  PrimitiveSchema,
} from "../primitives/types.js";

export const FLOW_PRIMITIVE_MULTI_PORT_SAVE_CAPABILITY =
  "flow.save.primitive-multi-port@1" as const;

export const MAX_PRIMITIVE_MULTI_PORT_SAVE_BINDINGS = 32;

export interface PrimitiveMultiPortSaveBinding {
  readonly port: string;
  readonly target: `state.${string}`;
  readonly source: {
    readonly schema: PrimitiveSchema;
    readonly cardinality: "one" | "optional" | "many";
    readonly classification: "public" | "internal" | "sensitive" | "secret";
    readonly persistence: "state" | "artifact" | "ephemeral";
  };
  readonly destination: {
    readonly kind: "state";
    readonly key: string;
    readonly requiredSchema: PrimitiveSchema;
  };
  readonly availability: {
    readonly producedOn: "primitive-success";
    readonly guarded: boolean;
    readonly unavailableOnTerminalCatchContinue: boolean;
  };
}

export interface PrimitiveMultiPortSaveContract {
  readonly bindings: readonly PrimitiveMultiPortSaveBinding[];
}

export type PrimitiveMultiPortSaveErrorCode =
  | "V2_MULTI_SAVE_OBJECT_REQUIRED"
  | "V2_MULTI_SAVE_BINDING_COUNT_INVALID"
  | "V2_MULTI_SAVE_UNKNOWN_PORT"
  | "V2_MULTI_SAVE_PERSISTENCE_MISMATCH"
  | "V2_MULTI_SAVE_TARGET_INVALID"
  | "V2_MULTI_SAVE_TARGET_DUPLICATE";

export interface PrimitiveMultiPortSaveError {
  readonly code: PrimitiveMultiPortSaveErrorCode;
  readonly field?: string;
  readonly message: string;
}

export type PrimitiveMultiPortSaveResult =
  | {
      readonly ok: true;
      readonly contract: PrimitiveMultiPortSaveContract;
    }
  | {
      readonly ok: false;
      readonly errors: readonly PrimitiveMultiPortSaveError[];
    };

export interface PrimitiveMultiPortSaveOptions {
  readonly guarded?: boolean;
  readonly terminalCatchContinues?: boolean;
}

const STATE_TARGET_PATTERN = /^state\.([A-Za-z][A-Za-z0-9_]*)$/;

/**
 * Validate two or more exact primitive output-port saves.
 *
 * The contract records success-path availability and the output schema that a
 * target must enforce at the destination. It does not synthesize V1 state
 * writes or grant a generic target execution authority.
 */
export function evaluatePrimitiveMultiPortSave(
  definition: PrimitiveDefinitionV2,
  raw: unknown,
  options: PrimitiveMultiPortSaveOptions = {},
): PrimitiveMultiPortSaveResult {
  if (!isPlainRecord(raw)) {
    return failure(
      "V2_MULTI_SAVE_OBJECT_REQUIRED",
      "v2 multi-port save must be a plain object",
    );
  }
  const entries = Object.entries(raw).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (
    entries.length < 2 ||
    entries.length > MAX_PRIMITIVE_MULTI_PORT_SAVE_BINDINGS
  ) {
    return failure(
      "V2_MULTI_SAVE_BINDING_COUNT_INVALID",
      `v2 multi-port save must contain 2 to ${MAX_PRIMITIVE_MULTI_PORT_SAVE_BINDINGS} bindings`,
    );
  }

  const errors: PrimitiveMultiPortSaveError[] = [];
  const stateKeys = new Set<string>();
  const bindings: PrimitiveMultiPortSaveBinding[] = [];
  for (const [port, target] of entries) {
    const output = definition.outputPorts[port];
    if (output === undefined) {
      errors.push({
        code: "V2_MULTI_SAVE_UNKNOWN_PORT",
        field: port,
        message:
          `primitive ${definition.ref} does not declare output port "${port}"`,
      });
      continue;
    }
    if (output.persistence !== "state") {
      errors.push({
        code: "V2_MULTI_SAVE_PERSISTENCE_MISMATCH",
        field: port,
        message:
          `save.${port} targets state but ${definition.ref} declares ` +
          `${output.persistence} persistence`,
      });
      continue;
    }
    if (typeof target !== "string") {
      errors.push({
        code: "V2_MULTI_SAVE_TARGET_INVALID",
        field: port,
        message: `save.${port} target must be state.<key>`,
      });
      continue;
    }
    const targetMatch = STATE_TARGET_PATTERN.exec(target);
    if (targetMatch === null) {
      errors.push({
        code: "V2_MULTI_SAVE_TARGET_INVALID",
        field: port,
        message:
          `save.${port} target must be state.<key>; received "${target}"`,
      });
      continue;
    }
    const stateKey = targetMatch[1]!;
    if (stateKeys.has(stateKey)) {
      errors.push({
        code: "V2_MULTI_SAVE_TARGET_DUPLICATE",
        field: port,
        message:
          `multi-port save targets state.${stateKey} more than once`,
      });
      continue;
    }
    stateKeys.add(stateKey);
    const sourceSchema = freezeSchema(output.schema);
    bindings.push(
      Object.freeze({
        port,
        target: target as `state.${string}`,
        source: Object.freeze({
          schema: sourceSchema,
          cardinality: output.cardinality,
          classification: output.classification,
          persistence: output.persistence,
        }),
        destination: Object.freeze({
          kind: "state" as const,
          key: stateKey,
          requiredSchema: sourceSchema,
        }),
        availability: Object.freeze({
          producedOn: "primitive-success" as const,
          guarded: options.guarded === true,
          unavailableOnTerminalCatchContinue:
            options.terminalCatchContinues === true,
        }),
      }),
    );
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors: Object.freeze(
        errors.map((error) => Object.freeze({ ...error })),
      ),
    };
  }
  return {
    ok: true,
    contract: Object.freeze({
      bindings: Object.freeze(bindings),
    }),
  };
}

function failure(
  code: PrimitiveMultiPortSaveErrorCode,
  message: string,
): PrimitiveMultiPortSaveResult {
  return {
    ok: false,
    errors: Object.freeze([Object.freeze({ code, message })]),
  };
}

function freezeSchema(schema: PrimitiveSchema): PrimitiveSchema {
  if (typeof schema === "string") return schema;
  return freezeJson(schema) as PrimitiveSchema;
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeJson(item)));
  }
  if (!isPlainRecord(value)) return value;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        freezeJson(nested),
      ]),
    ),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
