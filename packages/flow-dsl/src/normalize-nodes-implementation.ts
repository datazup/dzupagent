import type {
  EffectClass,
  EvidenceWriteNode,
  NodeIdempotencyMode,
  ShellRunNode,
  ValidateSchemaNode,
} from "@dzupagent/flow-ast";
import {
  EFFECT_CLASSES,
  NODE_IDEMPOTENCY_MODES,
} from "@dzupagent/flow-ast";

import { DSL_ERROR } from "./errors.js";
import {
  COMMON_NODE_KEYS,
  normalizeCommonNodeFields,
  normalizeObject,
  reportUnsupportedFields,
} from "./normalize-value-helpers.js";
import type { DslDiagnostic } from "./types.js";

const EFFECT_KEYS = ["effectClass", "idempotency"] as const;

const SHELL_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  ...EFFECT_KEYS,
  "command",
  "cwd",
  "timeoutMs",
  "required",
  "allowFailure",
  "output",
]);

const EVIDENCE_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  ...EFFECT_KEYS,
  "source",
  "output",
  "redact",
]);

const SCHEMA_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  ...EFFECT_KEYS,
  "source",
  "schema",
  "output",
]);

function commonWithoutEffectMetadata(raw: Record<string, unknown>) {
  const {
    effectClass: _effectClass,
    idempotency: _idempotency,
    ...rawForCommon
  } = raw;
  return rawForCommon;
}

function requiredString(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  diagnostics: DslDiagnostic[]
): string {
  const value = raw[key];
  if (typeof value === "string" && value.length > 0) return value;
  diagnostics.push({
    phase: "normalize",
    code: DSL_ERROR.MISSING_REQUIRED_FIELD,
    message: `${key} is required`,
    path: `${path}.${key}`,
  });
  return "";
}

function normalizeEffectFields(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): Pick<ShellRunNode, "effectClass" | "idempotency"> {
  const fields: Pick<ShellRunNode, "effectClass" | "idempotency"> = {};
  if (raw.effectClass !== undefined) {
    if (
      typeof raw.effectClass === "string" &&
      (EFFECT_CLASSES as readonly string[]).includes(raw.effectClass)
    ) {
      fields.effectClass = raw.effectClass as EffectClass;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message: `effectClass must be one of ${EFFECT_CLASSES.join("|")}`,
        path: `${path}.effectClass`,
      });
    }
  }
  if (raw.idempotency !== undefined) {
    if (
      typeof raw.idempotency === "string" &&
      (NODE_IDEMPOTENCY_MODES as readonly string[]).includes(raw.idempotency)
    ) {
      fields.idempotency = raw.idempotency as NodeIdempotencyMode;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message: `idempotency must be one of ${NODE_IDEMPOTENCY_MODES.join("|")}`,
        path: `${path}.idempotency`,
      });
    }
  }
  return fields;
}

export function normalizeShellRun(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): ShellRunNode {
  reportUnsupportedFields(raw, SHELL_KEYS, path, diagnostics);
  const node: ShellRunNode = {
    type: "shell.run",
    ...normalizeCommonNodeFields(
      commonWithoutEffectMetadata(raw),
      path,
      diagnostics
    ),
    ...normalizeEffectFields(raw, path, diagnostics),
    command: requiredString(raw, "command", path, diagnostics),
    output: requiredString(raw, "output", path, diagnostics),
  };
  if (typeof raw.cwd === "string") node.cwd = raw.cwd;
  if (typeof raw.timeoutMs === "number") node.timeoutMs = raw.timeoutMs;
  if (typeof raw.required === "boolean") node.required = raw.required;
  if (typeof raw.allowFailure === "boolean")
    node.allowFailure = raw.allowFailure;
  return node;
}

export function normalizeEvidenceWrite(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): EvidenceWriteNode {
  reportUnsupportedFields(raw, EVIDENCE_KEYS, path, diagnostics);
  const node: EvidenceWriteNode = {
    type: "evidence.write",
    ...normalizeCommonNodeFields(
      commonWithoutEffectMetadata(raw),
      path,
      diagnostics
    ),
    ...normalizeEffectFields(raw, path, diagnostics),
    source: requiredString(raw, "source", path, diagnostics),
    output: requiredString(raw, "output", path, diagnostics),
  };
  if (typeof raw.redact === "boolean") node.redact = raw.redact;
  return node;
}

export function normalizeValidateSchema(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): ValidateSchemaNode {
  reportUnsupportedFields(raw, SCHEMA_KEYS, path, diagnostics);
  let schema: string | Record<string, unknown> = {};
  if (typeof raw.schema === "string") {
    schema = raw.schema;
  } else {
    schema = normalizeObject(raw.schema, `${path}.schema`, diagnostics) ?? {};
  }
  return {
    type: "validate.schema",
    ...normalizeCommonNodeFields(
      commonWithoutEffectMetadata(raw),
      path,
      diagnostics
    ),
    ...normalizeEffectFields(raw, path, diagnostics),
    source: requiredString(raw, "source", path, diagnostics),
    schema,
    output: requiredString(raw, "output", path, diagnostics),
  };
}
