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
import { describeJsType, joinPath } from "../validation-helpers.js";
import { validateCommonNodeFields } from "./shared.js";
import type { SchemaIssue } from "./shared.js";

function requiredString(
  obj: Record<string, unknown>,
  path: string,
  key: string,
  kind: string,
  issues: SchemaIssue[]
): string | undefined {
  const value = obj[key];
  if (typeof value === "string" && value.length > 0) return value;
  issues.push({
    path: joinPath(path, key),
    code: "MISSING_REQUIRED_FIELD",
    message: `${kind}.${key} is required (non-empty string), received ${describeJsType(
      value
    )}`,
  });
  return undefined;
}

function optionalEffectFields(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): Pick<ShellRunNode, "effectClass" | "idempotency"> {
  const fields: Pick<ShellRunNode, "effectClass" | "idempotency"> = {};
  if (obj["effectClass"] !== undefined) {
    const value = obj["effectClass"];
    if (
      typeof value === "string" &&
      (EFFECT_CLASSES as readonly string[]).includes(value)
    ) {
      fields.effectClass = value as EffectClass;
    } else {
      issues.push({
        path: joinPath(path, "effectClass"),
        code: "MISSING_REQUIRED_FIELD",
        message: `effectClass must be one of ${EFFECT_CLASSES.join("|")}`,
      });
    }
  }
  if (obj["idempotency"] !== undefined) {
    const value = obj["idempotency"];
    if (
      typeof value === "string" &&
      (NODE_IDEMPOTENCY_MODES as readonly string[]).includes(value)
    ) {
      fields.idempotency = value as NodeIdempotencyMode;
    } else {
      issues.push({
        path: joinPath(path, "idempotency"),
        code: "MISSING_REQUIRED_FIELD",
        message: `idempotency must be one of ${NODE_IDEMPOTENCY_MODES.join("|")}`,
      });
    }
  }
  return fields;
}

export function validateShellRun(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): ShellRunNode | null {
  const command = requiredString(obj, path, "command", "shell.run", issues);
  const output = requiredString(obj, path, "output", "shell.run", issues);
  if (!command || !output) return null;

  const node: ShellRunNode = {
    type: "shell.run",
    ...validateCommonNodeFields(obj, path, issues),
    ...optionalEffectFields(obj, path, issues),
    command,
    output,
  };
  if (typeof obj["cwd"] === "string") node.cwd = obj["cwd"];
  if (obj["timeoutMs"] !== undefined) {
    const value = obj["timeoutMs"];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      node.timeoutMs = value;
    } else {
      issues.push({
        path: joinPath(path, "timeoutMs"),
        code: "MISSING_REQUIRED_FIELD",
        message: `shell.run.timeoutMs must be a positive integer when present, received ${describeJsType(
          value
        )}`,
      });
    }
  }
  if (typeof obj["required"] === "boolean") node.required = obj["required"];
  else if (obj["required"] !== undefined) {
    issues.push({
      path: joinPath(path, "required"),
      code: "MISSING_REQUIRED_FIELD",
      message: `shell.run.required must be a boolean when present, received ${describeJsType(
        obj["required"]
      )}`,
    });
  }
  if (typeof obj["allowFailure"] === "boolean") {
    node.allowFailure = obj["allowFailure"];
  } else if (obj["allowFailure"] !== undefined) {
    issues.push({
      path: joinPath(path, "allowFailure"),
      code: "MISSING_REQUIRED_FIELD",
      message: `shell.run.allowFailure must be a boolean when present, received ${describeJsType(
        obj["allowFailure"]
      )}`,
    });
  }
  return node;
}

export function validateEvidenceWrite(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): EvidenceWriteNode | null {
  const source = requiredString(obj, path, "source", "evidence.write", issues);
  const output = requiredString(obj, path, "output", "evidence.write", issues);
  if (!source || !output) return null;

  const node: EvidenceWriteNode = {
    type: "evidence.write",
    ...validateCommonNodeFields(obj, path, issues),
    ...optionalEffectFields(obj, path, issues),
    source,
    output,
  };
  if (typeof obj["redact"] === "boolean") node.redact = obj["redact"];
  else if (obj["redact"] !== undefined) {
    issues.push({
      path: joinPath(path, "redact"),
      code: "MISSING_REQUIRED_FIELD",
      message: `evidence.write.redact must be a boolean when present, received ${describeJsType(
        obj["redact"]
      )}`,
    });
  }
  return node;
}

export function validateValidateSchema(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): ValidateSchemaNode | null {
  const source = requiredString(obj, path, "source", "validate.schema", issues);
  const output = requiredString(obj, path, "output", "validate.schema", issues);
  const schema = obj["schema"];
  if (!source || !output) return null;
  if (
    typeof schema !== "string" &&
    !(typeof schema === "object" && schema !== null && !Array.isArray(schema))
  ) {
    issues.push({
      path: joinPath(path, "schema"),
      code: "MISSING_REQUIRED_FIELD",
      message: `validate.schema.schema must be a schema ref string or object, received ${describeJsType(
        schema
      )}`,
    });
    return null;
  }

  return {
    type: "validate.schema",
    ...validateCommonNodeFields(obj, path, issues),
    ...optionalEffectFields(obj, path, issues),
    source,
    schema: schema as string | Record<string, unknown>,
    output,
  };
}
