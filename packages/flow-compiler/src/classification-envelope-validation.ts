import {
  FLOW_COMPILED_CLASSIFICATION_ENVELOPE_SCHEMA,
  type FlowCompiledClassificationEnvelopeValidation,
} from "./classification-envelope-types.js";
import { hashFlowCompiledClassificationEnvelopePayload } from "./classification-envelope.js";

const CLASSIFICATIONS = new Set([
  "public",
  "internal",
  "sensitive",
  "secret",
]);
const VALUE_TYPES = new Set([
  "unknown",
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "null",
  "any",
  "credential",
]);

/** Validate the closed public envelope shape and deterministic content hash. */
export function validateFlowCompiledClassificationEnvelope(
  value: unknown,
): FlowCompiledClassificationEnvelopeValidation {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, issues: Object.freeze(["envelope must be an object"]) };
  }
  allowedKeys(
    value,
    [
      "schema",
      "compileId",
      "semanticHash",
      "classificationHash",
      "classificationComplete",
      "unclassifiedReferences",
      "values",
      "ports",
      "primitives",
    ],
    "envelope",
    issues,
  );
  if (value.schema !== FLOW_COMPILED_CLASSIFICATION_ENVELOPE_SCHEMA) {
    issues.push(
      `schema must be ${FLOW_COMPILED_CLASSIFICATION_ENVELOPE_SCHEMA}`,
    );
  }
  requireNonEmptyString(value.compileId, "compileId", issues);
  requireNonEmptyString(value.semanticHash, "semanticHash", issues);
  if (
    typeof value.classificationHash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.classificationHash)
  ) {
    issues.push("classificationHash must be a lowercase SHA-256 digest");
  }
  if (typeof value.classificationComplete !== "boolean") {
    issues.push("classificationComplete must be a boolean");
  }
  const unclassified = stringArray(
    value.unclassifiedReferences,
    "unclassifiedReferences",
    issues,
  );
  if (
    unclassified !== undefined &&
    value.classificationComplete !== (unclassified.length === 0)
  ) {
    issues.push(
      "classificationComplete must match unclassifiedReferences emptiness",
    );
  }
  validateArray(value.values, "values", issues, validateValue);
  validateArray(value.ports, "ports", issues, validatePort);
  validateArray(value.primitives, "primitives", issues, validatePrimitive);
  if (
    Array.isArray(value.values) &&
    Array.isArray(value.ports) &&
    Array.isArray(value.primitives) &&
    unclassified !== undefined
  ) {
    try {
      const expected = hashFlowCompiledClassificationEnvelopePayload({
        schema: value.schema,
        semanticHash: value.semanticHash,
        classificationComplete: value.classificationComplete,
        unclassifiedReferences: value.unclassifiedReferences,
        values: value.values,
        ports: value.ports,
        primitives: value.primitives,
      });
      if (value.classificationHash !== expected) {
        issues.push("classificationHash does not match envelope contents");
      }
    } catch {
      issues.push("envelope contents must be acyclic and hashable");
    }
  }
  return { valid: issues.length === 0, issues: Object.freeze(issues) };
}

function validateValue(value: unknown, path: string, issues: string[]): void {
  if (!recordWithKeys(
    value,
    ["reference", "root", "name", "classification", "valueType", "credential"],
    path,
    issues,
  )) return;
  requireNonEmptyString(value.reference, `${path}.reference`, issues);
  requireNonEmptyString(value.root, `${path}.root`, issues);
  requireNonEmptyString(value.name, `${path}.name`, issues);
  enumValue(value.classification, CLASSIFICATIONS, `${path}.classification`, issues);
  enumValue(value.valueType, VALUE_TYPES, `${path}.valueType`, issues);
  if (value.credential !== undefined) {
    if (recordWithKeys(value.credential, ["form", "resolution"], `${path}.credential`, issues)) {
      if (value.credential.form !== "opaque-handle") {
        issues.push(`${path}.credential.form must be opaque-handle`);
      }
      if (value.credential.resolution !== "lease-only") {
        issues.push(`${path}.credential.resolution must be lease-only`);
      }
    }
    if (value.valueType !== "credential") {
      issues.push(`${path}.credential requires credential valueType`);
    }
  } else if (value.valueType === "credential") {
    issues.push(`${path}.credential is required for credential valueType`);
  }
}

function validatePort(value: unknown, path: string, issues: string[]): void {
  if (!recordWithKeys(
    value,
    ["reference", "stepId", "port", "classification", "valueType"],
    path,
    issues,
  )) return;
  for (const key of ["reference", "stepId", "port"] as const) {
    requireNonEmptyString(value[key], `${path}.${key}`, issues);
  }
  enumValue(value.classification, CLASSIFICATIONS, `${path}.classification`, issues);
  enumValue(value.valueType, VALUE_TYPES, `${path}.valueType`, issues);
}

function validatePrimitive(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!recordWithKeys(
    value,
    [
      "nodePath",
      "nodeId",
      "primitiveRef",
      "requiredCapabilities",
      "acceptedInputClassifications",
      "credential",
      "redaction",
      "outputs",
    ],
    path,
    issues,
  )) return;
  requireNonEmptyString(value.nodePath, `${path}.nodePath`, issues);
  if (value.nodeId !== undefined) {
    requireNonEmptyString(value.nodeId, `${path}.nodeId`, issues);
  }
  if (
    typeof value.primitiveRef !== "string" ||
    !/^primitive:\/\/[^@\s]+@[^@\s]+$/.test(value.primitiveRef)
  ) {
    issues.push(`${path}.primitiveRef must be a versioned primitive reference`);
  }
  stringArray(
    value.requiredCapabilities,
    `${path}.requiredCapabilities`,
    issues,
  );
  enumArray(
    value.acceptedInputClassifications,
    CLASSIFICATIONS,
    `${path}.acceptedInputClassifications`,
    issues,
  );
  if (value.credential !== undefined) {
    validateCredential(value.credential, `${path}.credential`, issues);
  }
  if (value.redaction !== undefined) {
    validateRedaction(value.redaction, `${path}.redaction`, issues);
  }
  validateArray(value.outputs, `${path}.outputs`, issues, validateOutput);
}

function validateCredential(value: unknown, path: string, issues: string[]): void {
  if (!recordWithKeys(
    value,
    ["mode", "inputPaths", "resolverCapabilityRef"],
    path,
    issues,
  )) return;
  enumValue(value.mode, new Set(["handle-only", "raw-by-policy"]), `${path}.mode`, issues);
  stringArray(value.inputPaths, `${path}.inputPaths`, issues);
  if (value.resolverCapabilityRef !== undefined) {
    requireNonEmptyString(
      value.resolverCapabilityRef,
      `${path}.resolverCapabilityRef`,
      issues,
    );
  }
}

function validateRedaction(value: unknown, path: string, issues: string[]): void {
  if (!recordWithKeys(
    value,
    ["requiredAbove", "policyRef", "receiptRequired", "receiptSchema"],
    path,
    issues,
  )) return;
  if (value.requiredAbove !== undefined) {
    enumValue(value.requiredAbove, CLASSIFICATIONS, `${path}.requiredAbove`, issues);
  }
  if (value.policyRef !== undefined) {
    requireNonEmptyString(value.policyRef, `${path}.policyRef`, issues);
  }
  if (typeof value.receiptRequired !== "boolean") {
    issues.push(`${path}.receiptRequired must be a boolean`);
  }
  if (
    value.receiptSchema !== undefined &&
    value.receiptSchema !== "dzupagent.flowRedactionReceipt/v1"
  ) {
    issues.push(`${path}.receiptSchema must be dzupagent.flowRedactionReceipt/v1`);
  }
}

function validateOutput(value: unknown, path: string, issues: string[]): void {
  if (!recordWithKeys(
    value,
    [
      "port",
      "expectedClassification",
      "effectiveClassification",
      "cardinality",
      "persistence",
    ],
    path,
    issues,
  )) return;
  requireNonEmptyString(value.port, `${path}.port`, issues);
  enumValue(
    value.expectedClassification,
    CLASSIFICATIONS,
    `${path}.expectedClassification`,
    issues,
  );
  enumValue(
    value.effectiveClassification,
    CLASSIFICATIONS,
    `${path}.effectiveClassification`,
    issues,
  );
  enumValue(
    value.cardinality,
    new Set(["one", "optional", "many"]),
    `${path}.cardinality`,
    issues,
  );
  enumValue(
    value.persistence,
    new Set(["state", "artifact", "ephemeral"]),
    `${path}.persistence`,
    issues,
  );
}

function validateArray(
  value: unknown,
  path: string,
  issues: string[],
  validate: (entry: unknown, path: string, issues: string[]) => void,
): void {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return;
  }
  value.forEach((entry, index) => validate(entry, `${path}[${index}]`, issues));
}

function enumArray(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
  issues: string[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${path} must be a non-empty array`);
    return;
  }
  value.forEach((entry, index) =>
    enumValue(entry, allowed, `${path}[${index}]`, issues),
  );
}

function enumValue(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
  issues: string[],
): void {
  if (typeof value !== "string" || !allowed.has(value)) {
    issues.push(`${path} has an unsupported value`);
  }
}

function stringArray(
  value: unknown,
  path: string,
  issues: string[],
): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    issues.push(`${path} must contain only non-empty strings`);
    return undefined;
  }
  const sorted = [...value].sort((left, right) => left.localeCompare(right));
  if (
    new Set(value).size !== value.length ||
    sorted.some((entry, index) => entry !== value[index])
  ) {
    issues.push(`${path} must be sorted and unique`);
  }
  return value;
}

function recordWithKeys(
  value: unknown,
  keys: readonly string[],
  path: string,
  issues: string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return false;
  }
  allowedKeys(value, keys, path, issues);
  return true;
}

function allowedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  issues: string[],
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${path}.${key} is not allowed`);
  }
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`${path} must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
