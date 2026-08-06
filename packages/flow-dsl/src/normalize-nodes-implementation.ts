import type {
  EvidenceWriteNode,
  ShellRunNode,
  ValidateSchemaNode,
} from "@dzupagent/flow-ast";

import { DSL_ERROR } from "./errors.js";
import {
  COMMON_NODE_KEYS,
  normalizeCommonNodeFields,
  normalizeObject,
  reportUnsupportedFields,
} from "./normalize-value-helpers.js";
import type { DslDiagnostic } from "./types.js";

const SHELL_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "command",
  "cwd",
  "timeoutMs",
  "required",
  "allowFailure",
  "output",
]);

const EVIDENCE_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "source",
  "output",
  "redact",
]);

const SCHEMA_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "source",
  "schema",
  "output",
]);

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

export function normalizeShellRun(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): ShellRunNode {
  reportUnsupportedFields(raw, SHELL_KEYS, path, diagnostics);
  const node: ShellRunNode = {
    type: "shell.run",
    ...normalizeCommonNodeFields(raw, path, diagnostics),
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
    ...normalizeCommonNodeFields(raw, path, diagnostics),
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
    ...normalizeCommonNodeFields(raw, path, diagnostics),
    source: requiredString(raw, "source", path, diagnostics),
    schema,
    output: requiredString(raw, "output", path, diagnostics),
  };
}
