import { createHash } from "node:crypto";

import {
  CANONICAL_JSON_VERSION,
  canonicalInputDigest,
  canonicalJson,
} from "./idempotency.js";

export const FLOW_RUNTIME_INPUT_CONTRACT =
  "dzupagent.flowRuntimeInput/v1" as const;
export const FLOW_CREDENTIAL_HANDLE_REF_SCHEMA =
  "dzupagent.flowCredentialHandle/v1" as const;

export type FlowRuntimeInputType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "credential"
  | "any";

export type FlowRuntimeInputClassification =
  | "public"
  | "internal"
  | "sensitive"
  | "secret";

export type FlowRuntimeJsonValue =
  | string
  | number
  | boolean
  | null
  | FlowRuntimeJsonValue[]
  | { [key: string]: FlowRuntimeJsonValue };

/**
 * Structural runtime view of a DzupFlow input declaration. `FlowInputSpec`
 * from `@dzupagent/flow-ast` is assignable to this type without creating a
 * reverse package dependency from runtime-contracts to flow-ast.
 */
export interface FlowRuntimeInputSpec {
  type: FlowRuntimeInputType;
  required?: boolean;
  default?: FlowRuntimeJsonValue;
  classification?: FlowRuntimeInputClassification;
}

/**
 * Secret-free, persistable reference to a host-owned credential. The worker
 * must re-resolve this reference and create the nominal FlowCredentialHandle;
 * this record never carries credential material.
 */
export interface FlowRuntimeCredentialHandleRef {
  schema: typeof FLOW_CREDENTIAL_HANDLE_REF_SCHEMA;
  handleId: string;
  bindingRef: string;
  capabilityRef: string;
  provider?: string;
  scopes: string[];
  expiresAt?: string;
}

export interface FlowRuntimeInputLimits {
  maxCanonicalBytes: number;
  maxDepth: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  maxTotalValues: number;
  maxStringBytes: number;
}

export const DEFAULT_FLOW_RUNTIME_INPUT_LIMITS: Readonly<FlowRuntimeInputLimits> =
  Object.freeze({
    maxCanonicalBytes: 64 * 1024,
    maxDepth: 12,
    maxArrayItems: 512,
    maxObjectKeys: 256,
    maxTotalValues: 4_096,
    maxStringBytes: 16 * 1024,
  });

export type FlowRuntimeInputIssueCode =
  | "FLOW_INPUT_NOT_OBJECT"
  | "FLOW_INPUT_CONTRACT_INVALID"
  | "FLOW_INPUT_KEY_INVALID"
  | "FLOW_INPUT_UNKNOWN_KEY"
  | "FLOW_INPUT_REQUIRED"
  | "FLOW_INPUT_TYPE_MISMATCH"
  | "FLOW_INPUT_VALUE_INVALID"
  | "FLOW_INPUT_CREDENTIAL_INLINE_DENIED"
  | "FLOW_INPUT_CREDENTIAL_HANDLE_REQUIRED"
  | "FLOW_INPUT_CREDENTIAL_HANDLE_UNKNOWN"
  | "FLOW_INPUT_CREDENTIAL_HANDLE_INVALID"
  | "FLOW_INPUT_MAX_CANONICAL_BYTES"
  | "FLOW_INPUT_MAX_DEPTH"
  | "FLOW_INPUT_MAX_ARRAY_ITEMS"
  | "FLOW_INPUT_MAX_OBJECT_KEYS"
  | "FLOW_INPUT_MAX_TOTAL_VALUES"
  | "FLOW_INPUT_MAX_STRING_BYTES";

export interface FlowRuntimeInputIssue {
  code: FlowRuntimeInputIssueCode;
  path: string;
  message: string;
}

export interface FlowRuntimeInputValidationRequest {
  inputContract?: Record<string, FlowRuntimeInputSpec>;
  input?: unknown;
  credentialHandleRefs?: unknown;
  limits?: Partial<FlowRuntimeInputLimits>;
}

export interface ValidatedFlowRuntimeInput {
  contract: typeof FLOW_RUNTIME_INPUT_CONTRACT;
  canonicalization: typeof CANONICAL_JSON_VERSION;
  inputs: Record<string, FlowRuntimeJsonValue>;
  credentialHandleRefs: Record<string, FlowRuntimeCredentialHandleRef>;
  classifications: Record<string, FlowRuntimeInputClassification>;
  canonicalPayloadJson: string;
  canonicalBytes: number;
  payloadDigest: `sha256:${string}`;
  classificationMapDigest: `sha256:${string}`;
  credentialHandleDigests: Record<string, `sha256:${string}`>;
  /** Exact initial-state namespace expected by DzupFlow references. */
  runtimeState: {
    inputs: Record<
      string,
      FlowRuntimeJsonValue | FlowRuntimeCredentialHandleRef
    >;
  };
}

export type FlowRuntimeInputValidationResult =
  | { valid: true; value: ValidatedFlowRuntimeInput; issues: [] }
  | { valid: false; issues: FlowRuntimeInputIssue[] };

const INPUT_TYPES = new Set<FlowRuntimeInputType>([
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "credential",
  "any",
]);

const CLASSIFICATIONS = new Set<FlowRuntimeInputClassification>([
  "public",
  "internal",
  "sensitive",
  "secret",
]);

const CREDENTIAL_KEYS = new Set([
  "schema",
  "handleId",
  "bindingRef",
  "capabilityRef",
  "provider",
  "scopes",
  "expiresAt",
]);

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const TOP_LEVEL_INPUT_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export function validateFlowRuntimeInput(
  request: FlowRuntimeInputValidationRequest,
): FlowRuntimeInputValidationResult {
  const limits = resolveLimits(request.limits);
  const issues: FlowRuntimeInputIssue[] = [];
  const contract = request.inputContract ?? {};
  const suppliedInput = request.input === undefined ? {} : request.input;
  const suppliedHandles =
    request.credentialHandleRefs === undefined
      ? {}
      : request.credentialHandleRefs;
  const rawInput = plainRecord(suppliedInput)
    ? suppliedInput
    : undefined;
  const rawHandles = plainRecord(suppliedHandles)
    ? suppliedHandles
    : undefined;

  if (rawInput === undefined) {
    issues.push(issue("FLOW_INPUT_NOT_OBJECT", "$.inputs", "Run input must be an object."));
  }
  if (rawHandles === undefined) {
    issues.push(
      issue(
        "FLOW_INPUT_CREDENTIAL_HANDLE_INVALID",
        "$.credentialHandleRefs",
        "Credential handle references must be an object.",
      ),
    );
  }

  const inputRecord = (rawInput ?? {}) as Record<string, unknown>;
  const handleRecord = (rawHandles ?? {}) as Record<string, unknown>;
  const normalizedInputs = nullRecord<FlowRuntimeJsonValue>();
  const normalizedHandles = nullRecord<FlowRuntimeCredentialHandleRef>();
  const classifications = nullRecord<FlowRuntimeInputClassification>();
  const valueCounter = { total: 0 };

  for (const key of Object.keys(inputRecord).sort()) {
    if (!validTopLevelKey(key)) {
      issues.push(invalidKeyIssue(inputPath(key), key));
      continue;
    }
    const spec = Object.hasOwn(contract, key) ? contract[key] : undefined;
    if (spec === undefined) {
      issues.push(
        issue(
          "FLOW_INPUT_UNKNOWN_KEY",
          inputPath(key),
          `Input key '${key}' is not declared by the flow.`,
        ),
      );
    } else if (spec.type === "credential") {
      issues.push(
        issue(
          "FLOW_INPUT_CREDENTIAL_INLINE_DENIED",
          inputPath(key),
          `Credential input '${key}' must be supplied as a separate opaque handle reference.`,
        ),
      );
    }
  }

  for (const key of Object.keys(handleRecord).sort()) {
    if (!validTopLevelKey(key)) {
      issues.push(invalidKeyIssue(handlePath(key), key));
      continue;
    }
    if (!Object.hasOwn(contract, key) || contract[key]?.type !== "credential") {
      issues.push(
        issue(
          "FLOW_INPUT_CREDENTIAL_HANDLE_UNKNOWN",
          handlePath(key),
          `Credential handle '${key}' does not match a declared credential input.`,
        ),
      );
    }
  }

  for (const key of Object.keys(contract).sort()) {
    if (!validTopLevelKey(key)) {
      issues.push(invalidKeyIssue(`$.contract.${key}`, key));
      continue;
    }
    const spec = contract[key];
    if (!validSpec(spec)) {
      issues.push(
        issue(
          "FLOW_INPUT_CONTRACT_INVALID",
          `$.contract.${key}`,
          `Input declaration '${key}' is not a valid runtime input contract.`,
        ),
      );
      continue;
    }

    const classification =
      spec.type === "credential"
        ? "secret"
        : (spec.classification ?? "internal");
    classifications[key] = classification;

    if (spec.type === "credential") {
      const rawHandle = handleRecord[key];
      if (rawHandle === undefined) {
        if (spec.required === true) {
          issues.push(
            issue(
              "FLOW_INPUT_CREDENTIAL_HANDLE_REQUIRED",
              handlePath(key),
              `Required credential input '${key}' has no opaque handle reference.`,
            ),
          );
        }
        continue;
      }
      const handle = validateCredentialHandle(rawHandle, handlePath(key), issues);
      if (handle !== undefined) normalizedHandles[key] = handle;
      continue;
    }

    let value = inputRecord[key];
    if (value === undefined && spec.default !== undefined) {
      value = spec.default;
    }
    if (value === undefined) {
      if (spec.required === true) {
        issues.push(
          issue(
            "FLOW_INPUT_REQUIRED",
            inputPath(key),
            `Required input '${key}' is missing.`,
          ),
        );
      }
      continue;
    }
    if (!matchesType(value, spec.type)) {
      issues.push(
        issue(
          "FLOW_INPUT_TYPE_MISMATCH",
          inputPath(key),
          `Input '${key}' must be ${spec.type}; received ${describeType(value)}.`,
        ),
      );
      continue;
    }
    if (
      validateJsonValue(
        value,
        inputPath(key),
        limits,
        issues,
        valueCounter,
      )
    ) {
      normalizedInputs[key] = cloneJson(value as FlowRuntimeJsonValue);
    }
  }

  if (issues.length > 0) return { valid: false, issues };

  const canonicalPayloadJson = canonicalJson({
    contract: FLOW_RUNTIME_INPUT_CONTRACT,
    canonicalization: CANONICAL_JSON_VERSION,
    inputs: normalizedInputs,
    credentialHandleRefs: normalizedHandles,
  });
  const canonicalBytes = utf8Bytes(canonicalPayloadJson);
  if (canonicalBytes > limits.maxCanonicalBytes) {
    return {
      valid: false,
      issues: [
        issue(
          "FLOW_INPUT_MAX_CANONICAL_BYTES",
          "$",
          `Canonical run input is ${canonicalBytes} bytes; the limit is ${limits.maxCanonicalBytes}.`,
        ),
      ],
    };
  }

  const credentialHandleDigests = Object.fromEntries(
    Object.entries(normalizedHandles).map(([key, handle]) => [
      key,
      digest(handle),
    ]),
  );

  return {
    valid: true,
    issues: [],
    value: {
      contract: FLOW_RUNTIME_INPUT_CONTRACT,
      canonicalization: CANONICAL_JSON_VERSION,
      inputs: normalizedInputs,
      credentialHandleRefs: normalizedHandles,
      classifications,
      canonicalPayloadJson,
      canonicalBytes,
      payloadDigest: digest(JSON.parse(canonicalPayloadJson)),
      classificationMapDigest: digest(classifications),
      credentialHandleDigests,
      runtimeState: {
        inputs: Object.assign(
          nullRecord<FlowRuntimeJsonValue | FlowRuntimeCredentialHandleRef>(),
          normalizedInputs,
          normalizedHandles,
        ),
      },
    },
  };
}

function resolveLimits(
  overrides: Partial<FlowRuntimeInputLimits> | undefined,
): FlowRuntimeInputLimits {
  const resolved = { ...DEFAULT_FLOW_RUNTIME_INPUT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${key} must be a positive safe integer.`);
    }
  }
  return resolved;
}

function validSpec(value: unknown): value is FlowRuntimeInputSpec {
  if (!plainRecord(value) || !INPUT_TYPES.has(value.type as FlowRuntimeInputType)) {
    return false;
  }
  if (value.required !== undefined && typeof value.required !== "boolean") {
    return false;
  }
  if (
    value.classification !== undefined &&
    !CLASSIFICATIONS.has(value.classification as FlowRuntimeInputClassification)
  ) {
    return false;
  }
  if (value.type === "credential") {
    return value.default === undefined &&
      (value.classification === undefined || value.classification === "secret");
  }
  return value.default === undefined || matchesType(value.default, value.type as FlowRuntimeInputType);
}

function validateCredentialHandle(
  value: unknown,
  path: string,
  issues: FlowRuntimeInputIssue[],
): FlowRuntimeCredentialHandleRef | undefined {
  const local: string[] = [];
  if (!plainRecord(value)) {
    local.push("must be an object");
  } else {
    const extras = Object.keys(value).filter((key) => !CREDENTIAL_KEYS.has(key));
    if (extras.length > 0) local.push(`contains unsupported fields: ${extras.sort().join(", ")}`);
    if (value.schema !== FLOW_CREDENTIAL_HANDLE_REF_SCHEMA) {
      local.push(`schema must be ${FLOW_CREDENTIAL_HANDLE_REF_SCHEMA}`);
    }
    boundedString(value.handleId, "handleId", 200, local);
    boundedString(value.bindingRef, "bindingRef", 500, local);
    if (typeof value.bindingRef === "string" && !value.bindingRef.startsWith("binding://")) {
      local.push("bindingRef must be a binding URI");
    }
    boundedString(value.capabilityRef, "capabilityRef", 200, local);
    if (value.provider !== undefined) boundedString(value.provider, "provider", 120, local);
    if (!Array.isArray(value.scopes) || value.scopes.length > 64) {
      local.push("scopes must be an array with at most 64 entries");
    } else {
      const scopeValues = value.scopes;
      for (const scope of scopeValues) boundedString(scope, "scope", 160, local);
      if (new Set(scopeValues).size !== scopeValues.length) local.push("scopes cannot contain duplicates");
    }
    if (value.expiresAt !== undefined) {
      boundedString(value.expiresAt, "expiresAt", 40, local);
      if (
        typeof value.expiresAt === "string" &&
        !isRfc3339DateTime(value.expiresAt)
      ) {
        local.push("expiresAt must be an RFC 3339 date-time when present");
      }
    }
  }

  if (local.length > 0) {
    issues.push(
      issue(
        "FLOW_INPUT_CREDENTIAL_HANDLE_INVALID",
        path,
        `Credential handle reference is invalid: ${local.join("; ")}.`,
      ),
    );
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    schema: FLOW_CREDENTIAL_HANDLE_REF_SCHEMA,
    handleId: record.handleId as string,
    bindingRef: record.bindingRef as string,
    capabilityRef: record.capabilityRef as string,
    ...(record.provider === undefined
      ? {}
      : { provider: record.provider as string }),
    scopes: [...(record.scopes as string[])].sort(),
    ...(record.expiresAt === undefined
      ? {}
      : { expiresAt: record.expiresAt as string }),
  };
}

function validateJsonValue(
  value: unknown,
  path: string,
  limits: FlowRuntimeInputLimits,
  issues: FlowRuntimeInputIssue[],
  valueCounter: { total: number },
): value is FlowRuntimeJsonValue {
  const ancestors = new WeakSet<object>();

  const visit = (current: unknown, currentPath: string, depth: number): boolean => {
    valueCounter.total += 1;
    if (valueCounter.total > limits.maxTotalValues) {
      issues.push(
        issue(
          "FLOW_INPUT_MAX_TOTAL_VALUES",
          currentPath,
          `Input exceeds the ${limits.maxTotalValues} value limit.`,
        ),
      );
      return false;
    }
    if (depth > limits.maxDepth) {
      issues.push(
        issue(
          "FLOW_INPUT_MAX_DEPTH",
          currentPath,
          `Input exceeds the maximum depth of ${limits.maxDepth}.`,
        ),
      );
      return false;
    }
    if (current === null || typeof current === "boolean") return true;
    if (typeof current === "number") {
      if (Number.isFinite(current)) return true;
      issues.push(issue("FLOW_INPUT_VALUE_INVALID", currentPath, "Numbers must be finite."));
      return false;
    }
    if (typeof current === "string") {
      const bytes = utf8Bytes(current);
      if (bytes <= limits.maxStringBytes) return true;
      issues.push(
        issue(
          "FLOW_INPUT_MAX_STRING_BYTES",
          currentPath,
          `String is ${bytes} bytes; the per-string limit is ${limits.maxStringBytes}.`,
        ),
      );
      return false;
    }
    if (typeof current !== "object") {
      issues.push(
        issue(
          "FLOW_INPUT_VALUE_INVALID",
          currentPath,
          `Input values must be JSON; received ${describeType(current)}.`,
        ),
      );
      return false;
    }
    if (ancestors.has(current)) {
      issues.push(issue("FLOW_INPUT_VALUE_INVALID", currentPath, "Input values cannot be cyclic."));
      return false;
    }
    ancestors.add(current);
    let valid = true;
    if (Array.isArray(current)) {
      if (current.length > limits.maxArrayItems) {
        issues.push(
          issue(
            "FLOW_INPUT_MAX_ARRAY_ITEMS",
            currentPath,
            `Array has ${current.length} items; the limit is ${limits.maxArrayItems}.`,
          ),
        );
        valid = false;
      } else {
        for (let index = 0; index < current.length; index += 1) {
          valid = visit(current[index], `${currentPath}[${index}]`, depth + 1) && valid;
        }
      }
    } else if (!plainRecord(current)) {
      issues.push(issue("FLOW_INPUT_VALUE_INVALID", currentPath, "Objects must be plain JSON objects."));
      valid = false;
    } else {
      const keys = Object.keys(current);
      if (keys.length > limits.maxObjectKeys) {
        issues.push(
          issue(
            "FLOW_INPUT_MAX_OBJECT_KEYS",
            currentPath,
            `Object has ${keys.length} keys; the limit is ${limits.maxObjectKeys}.`,
          ),
        );
        valid = false;
      } else {
        for (const key of keys.sort()) {
          if (!validJsonObjectKey(key)) {
            issues.push(invalidKeyIssue(`${currentPath}.${key}`, key));
            valid = false;
            continue;
          }
          valid = visit(current[key], `${currentPath}.${key}`, depth + 1) && valid;
        }
      }
    }
    ancestors.delete(current);
    return valid;
  };

  return visit(value, path, 0);
}

function matchesType(value: unknown, type: FlowRuntimeInputType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return plainRecord(value);
    case "array":
      return Array.isArray(value);
    case "credential":
      return false;
    case "any":
      return isPotentialJsonValue(value);
  }
}

function isPotentialJsonValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    Array.isArray(value) ||
    plainRecord(value)
  );
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nullRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function validTopLevelKey(key: string): boolean {
  return TOP_LEVEL_INPUT_KEY.test(key) && !UNSAFE_OBJECT_KEYS.has(key);
}

function validJsonObjectKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 256 &&
    !UNSAFE_OBJECT_KEYS.has(key) &&
    !/[\u0000-\u001f\u007f]/.test(key)
  );
}

function invalidKeyIssue(path: string, key: string): FlowRuntimeInputIssue {
  return issue(
    "FLOW_INPUT_KEY_INVALID",
    path,
    `Input key '${key}' is not safe for durable runtime state.`,
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${canonicalInputDigest(value)}`;
}

export function sha256Text(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else {
      bytes += 4;
      index += 1;
    }
  }
  return bytes;
}

function boundedString(
  value: unknown,
  field: string,
  max: number,
  issues: string[],
): void {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    issues.push(`${field} must be a non-empty string no longer than ${max} characters`);
  }
}

function isRfc3339DateTime(value: string): boolean {
  if (value.length < 20 || value.length > 35) return false;
  if (
    value[4] !== "-" ||
    value[7] !== "-" ||
    value[10] !== "T" ||
    value[13] !== ":" ||
    value[16] !== ":" ||
    !asciiDigits(value.slice(0, 4)) ||
    !asciiDigits(value.slice(5, 7)) ||
    !asciiDigits(value.slice(8, 10)) ||
    !asciiDigits(value.slice(11, 13)) ||
    !asciiDigits(value.slice(14, 16)) ||
    !asciiDigits(value.slice(17, 19))
  ) {
    return false;
  }

  let zoneStart = 19;
  if (value[zoneStart] === ".") {
    zoneStart += 1;
    const fractionStart = zoneStart;
    while (zoneStart < value.length && asciiDigit(value[zoneStart])) {
      zoneStart += 1;
    }
    const fractionLength = zoneStart - fractionStart;
    if (fractionLength < 1 || fractionLength > 9) return false;
  }

  const zone = value.slice(zoneStart);
  const validZone =
    zone === "Z" ||
    (zone.length === 6 &&
      (zone[0] === "+" || zone[0] === "-") &&
      zone[3] === ":" &&
      asciiDigits(zone.slice(1, 3)) &&
      asciiDigits(zone.slice(4, 6)));
  if (!validZone || Number.isNaN(Date.parse(value))) return false;

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) return false;
  }
  return true;
}

function asciiDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (const character of value) {
    if (!asciiDigit(character)) return false;
  }
  return true;
}

function asciiDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function inputPath(key: string): string {
  return `$.inputs.${key}`;
}

function handlePath(key: string): string {
  return `$.credentialHandleRefs.${key}`;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function issue(
  code: FlowRuntimeInputIssueCode,
  path: string,
  message: string,
): FlowRuntimeInputIssue {
  return { code, path, message };
}
