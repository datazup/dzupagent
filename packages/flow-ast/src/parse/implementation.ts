import type {
  EffectClass,
  EvidenceWriteNode,
  NodeIdempotencyMode,
  ShellRunNode,
  ValidateSchemaNode,
} from "../types.js";
import {
  EFFECT_CLASSES,
  NODE_IDEMPOTENCY_MODES,
} from "../types.js";
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from "./shared.js";

function requiredString(
  obj: Record<string, unknown>,
  key: string,
  kind: string,
  pointer: string,
  ctx: ParseContext
): string | undefined {
  const value = obj[key];
  if (typeof value === "string" && value.length > 0) return value;
  ctx.errors.push({
    code: "WRONG_FIELD_TYPE",
    message: `${kind}.${key} must be a non-empty string, received ${describeJsType(
      value
    )}`,
    pointer: joinPointer(pointer, key),
  });
  return undefined;
}

function optionalEffectFields(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): Pick<ShellRunNode, "effectClass" | "idempotency"> {
  const fields: Pick<ShellRunNode, "effectClass" | "idempotency"> = {};
  if (obj.effectClass !== undefined) {
    if (
      typeof obj.effectClass === "string" &&
      (EFFECT_CLASSES as readonly string[]).includes(obj.effectClass)
    ) {
      fields.effectClass = obj.effectClass as EffectClass;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: `effectClass must be one of ${EFFECT_CLASSES.join("|")}`,
        pointer: joinPointer(pointer, "effectClass"),
      });
    }
  }
  if (obj.idempotency !== undefined) {
    if (
      typeof obj.idempotency === "string" &&
      (NODE_IDEMPOTENCY_MODES as readonly string[]).includes(obj.idempotency)
    ) {
      fields.idempotency = obj.idempotency as NodeIdempotencyMode;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: `idempotency must be one of ${NODE_IDEMPOTENCY_MODES.join("|")}`,
        pointer: joinPointer(pointer, "idempotency"),
      });
    }
  }
  return fields;
}

export function parseShellRun(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): ShellRunNode | null {
  const command = requiredString(obj, "command", "shell.run", pointer, ctx);
  const output = requiredString(obj, "output", "shell.run", pointer, ctx);
  if (!command || !output) return null;

  const node: ShellRunNode = {
    type: "shell.run",
    ...parseCommonNodeFields(obj, pointer, ctx),
    ...optionalEffectFields(obj, pointer, ctx),
    command,
    output,
  };
  if (typeof obj.cwd === "string") node.cwd = obj.cwd;
  if (typeof obj.timeoutMs === "number" && Number.isInteger(obj.timeoutMs) && obj.timeoutMs > 0) {
    node.timeoutMs = obj.timeoutMs;
  } else if (obj.timeoutMs !== undefined) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `shell.run.timeoutMs must be a positive integer when present, received ${describeJsType(
        obj.timeoutMs
      )}`,
      pointer: joinPointer(pointer, "timeoutMs"),
    });
  }
  if (typeof obj.required === "boolean") node.required = obj.required;
  else if (obj.required !== undefined) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `shell.run.required must be a boolean when present, received ${describeJsType(
        obj.required
      )}`,
      pointer: joinPointer(pointer, "required"),
    });
  }
  if (typeof obj.allowFailure === "boolean") node.allowFailure = obj.allowFailure;
  else if (obj.allowFailure !== undefined) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `shell.run.allowFailure must be a boolean when present, received ${describeJsType(
        obj.allowFailure
      )}`,
      pointer: joinPointer(pointer, "allowFailure"),
    });
  }
  return node;
}

export function parseEvidenceWrite(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): EvidenceWriteNode | null {
  const source = requiredString(obj, "source", "evidence.write", pointer, ctx);
  const output = requiredString(obj, "output", "evidence.write", pointer, ctx);
  if (!source || !output) return null;

  const node: EvidenceWriteNode = {
    type: "evidence.write",
    ...parseCommonNodeFields(obj, pointer, ctx),
    ...optionalEffectFields(obj, pointer, ctx),
    source,
    output,
  };
  if (typeof obj.redact === "boolean") node.redact = obj.redact;
  else if (obj.redact !== undefined) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `evidence.write.redact must be a boolean when present, received ${describeJsType(
        obj.redact
      )}`,
      pointer: joinPointer(pointer, "redact"),
    });
  }
  return node;
}

export function parseValidateSchema(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): ValidateSchemaNode | null {
  const source = requiredString(obj, "source", "validate.schema", pointer, ctx);
  const output = requiredString(obj, "output", "validate.schema", pointer, ctx);
  const schema = obj.schema;
  if (!source || !output) return null;
  if (
    typeof schema !== "string" &&
    !(typeof schema === "object" && schema !== null && !Array.isArray(schema))
  ) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `validate.schema.schema must be a schema ref string or object, received ${describeJsType(
        schema
      )}`,
      pointer: joinPointer(pointer, "schema"),
    });
    return null;
  }

  return {
    type: "validate.schema",
    ...parseCommonNodeFields(obj, pointer, ctx),
    ...optionalEffectFields(obj, pointer, ctx),
    source,
    schema: schema as string | Record<string, unknown>,
    output,
  };
}
