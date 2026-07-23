import type { FlowDataClassification } from "./primitives.js";

export const FLOW_REDACTION_RECEIPT_SCHEMA =
  "dzupagent.flowRedactionReceipt/v1" as const;
export const FLOW_REDACTION_RESULT_SCHEMA =
  "dzupagent.flowRedactionResult/v1" as const;

export type FlowRedactionReceiptSchema =
  typeof FLOW_REDACTION_RECEIPT_SCHEMA;
export type FlowSha256Digest = `sha256:${string}`;
export type FlowRedactionFailureCode =
  | "POLICY_DENIED"
  | "TRANSFORM_UNAVAILABLE"
  | "TRANSFORM_FAILED"
  | "OUTPUT_CLASSIFICATION_INVALID"
  | "RECEIPT_ATTESTATION_FAILED";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const CLASSIFICATION_ORDER: Record<FlowDataClassification, number> = {
  public: 0,
  internal: 1,
  sensitive: 2,
  secret: 3,
};

export interface FlowRedactionTransformIdentity {
  readonly ref: `transform://${string}@${string}`;
  readonly version: string;
  readonly semanticHash: FlowSha256Digest;
}

export interface FlowRedactionPolicyIdentity {
  readonly ref: `policy://${string}@${string}`;
  readonly authority: string;
}

export interface FlowRedactionOperation {
  readonly operationId: string;
  readonly transform: FlowRedactionTransformIdentity;
  readonly policy: FlowRedactionPolicyIdentity;
  readonly hostCapabilityRef: string;
  readonly input: {
    readonly classification: FlowDataClassification;
    readonly digest: FlowSha256Digest;
  };
  readonly requestedOutputClassification: FlowDataClassification;
}

export interface FlowRedactionReceiptAttestation {
  readonly algorithm: "ed25519";
  readonly keyRef: string;
  /** SHA-256 of the JCS-canonical receipt payload without `attestation`. */
  readonly payloadDigest: FlowSha256Digest;
  /** Base64-encoded Ed25519 signature over `payloadDigest`. */
  readonly signature: string;
}

interface FlowRedactionReceiptBase extends FlowRedactionOperation {
  readonly schema: typeof FLOW_REDACTION_RECEIPT_SCHEMA;
  readonly receiptId: string;
  readonly issuedAt: string;
  readonly attestation: FlowRedactionReceiptAttestation;
}

export interface FlowAppliedRedactionReceipt
  extends FlowRedactionReceiptBase {
  readonly status: "applied";
  readonly output: {
    readonly classification: FlowDataClassification;
    readonly digest: FlowSha256Digest;
  };
}

export interface FlowFailedRedactionReceipt extends FlowRedactionReceiptBase {
  readonly status: "rejected" | "failed";
  readonly failure: {
    readonly code: FlowRedactionFailureCode;
    readonly retryable: boolean;
  };
}

export type FlowRedactionReceipt =
  | FlowAppliedRedactionReceipt
  | FlowFailedRedactionReceipt;

export type FlowRedactionResult<T = unknown> =
  | {
      readonly schema: typeof FLOW_REDACTION_RESULT_SCHEMA;
      readonly status: "applied";
      readonly output: {
        readonly value: T;
        readonly classification: FlowDataClassification;
        readonly digest: FlowSha256Digest;
      };
      readonly receipt: FlowAppliedRedactionReceipt;
    }
  | {
      readonly schema: typeof FLOW_REDACTION_RESULT_SCHEMA;
      readonly status: "rejected" | "failed";
      readonly receipt: FlowFailedRedactionReceipt;
    };

export interface FlowRedactionExecutor {
  redact<T = unknown>(
    value: unknown,
    operation: FlowRedactionOperation,
  ): Promise<FlowRedactionResult<T>>;
}

export interface FlowSecurityContractValidation {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

/**
 * Validate structural and classification invariants. Signature verification
 * remains the responsibility of the host identified by `keyRef`.
 */
export function validateFlowRedactionReceipt(
  value: unknown,
): FlowSecurityContractValidation {
  const issues: string[] = [];
  if (!isRecord(value)) return invalid("receipt must be an object");
  rejectUnexpectedKeys(
    value,
    [
      "schema",
      "receiptId",
      "operationId",
      "status",
      "transform",
      "policy",
      "hostCapabilityRef",
      "input",
      "requestedOutputClassification",
      "output",
      "failure",
      "issuedAt",
      "attestation",
    ],
    "receipt",
    issues,
  );
  if (value.schema !== FLOW_REDACTION_RECEIPT_SCHEMA) {
    issues.push(`schema must be ${FLOW_REDACTION_RECEIPT_SCHEMA}`);
  }
  requireString(value, "receiptId", issues);
  requireString(value, "operationId", issues);
  requireString(value, "hostCapabilityRef", issues);
  requireDate(value, "issuedAt", issues);
  validateTransform(value.transform, issues);
  validatePolicy(value.policy, issues);
  validateClassifiedDigest(value.input, "input", issues);
  const requested = classification(
    value.requestedOutputClassification,
    "requestedOutputClassification",
    issues,
  );
  const input = isRecord(value.input)
    ? classification(value.input.classification, "input.classification", issues)
    : undefined;
  if (
    requested !== undefined &&
    input !== undefined &&
    CLASSIFICATION_ORDER[requested] > CLASSIFICATION_ORDER[input]
  ) {
    issues.push(
      "requested output classification cannot exceed input classification",
    );
  }
  validateAttestation(value.attestation, issues);

  if (value.status === "applied") {
    validateClassifiedDigest(value.output, "output", issues);
    const output = isRecord(value.output)
      ? classification(value.output.classification, "output.classification", issues)
      : undefined;
    if (
      input !== undefined &&
      output !== undefined &&
      CLASSIFICATION_ORDER[output] > CLASSIFICATION_ORDER[input]
    ) {
      issues.push("output classification cannot exceed input classification");
    }
    if (
      requested !== undefined &&
      output !== undefined &&
      CLASSIFICATION_ORDER[output] > CLASSIFICATION_ORDER[requested]
    ) {
      issues.push(
        "output classification cannot exceed requested output classification",
      );
    }
    if ("failure" in value) issues.push("applied receipt cannot include failure");
  } else if (value.status === "rejected" || value.status === "failed") {
    validateFailure(value.failure, issues);
    if ("output" in value) issues.push("failed receipt cannot include output");
  } else {
    issues.push("status must be applied, rejected, or failed");
  }
  return { valid: issues.length === 0, issues: Object.freeze(issues) };
}

/** Validate that result metadata exactly matches its receipt. */
export function validateFlowRedactionResult(
  value: unknown,
): FlowSecurityContractValidation {
  const issues: string[] = [];
  if (!isRecord(value)) return invalid("result must be an object");
  rejectUnexpectedKeys(
    value,
    ["schema", "status", "output", "receipt"],
    "result",
    issues,
  );
  if (value.schema !== FLOW_REDACTION_RESULT_SCHEMA) {
    issues.push(`schema must be ${FLOW_REDACTION_RESULT_SCHEMA}`);
  }
  const receiptValidation = validateFlowRedactionReceipt(value.receipt);
  issues.push(...receiptValidation.issues.map((issue) => `receipt.${issue}`));
  if (!isRecord(value.receipt) || value.status !== value.receipt.status) {
    issues.push("result status must match receipt status");
  }
  if (value.status === "applied") {
    if (!isRecord(value.output)) {
      issues.push("applied result must include output");
    } else {
      rejectUnexpectedKeys(
        value.output,
        ["value", "classification", "digest"],
        "result.output",
        issues,
      );
    }
    if (isRecord(value.output) && isRecord(value.receipt) && isRecord(value.receipt.output)) {
      if (
        value.output.classification !== value.receipt.output.classification ||
        value.output.digest !== value.receipt.output.digest
      ) {
        issues.push("result output metadata must match receipt output");
      }
    }
  } else if (value.status === "rejected" || value.status === "failed") {
    if ("output" in value) issues.push("failed result cannot include output");
  } else {
    issues.push("status must be applied, rejected, or failed");
  }
  return { valid: issues.length === 0, issues: Object.freeze(issues) };
}

function validateTransform(value: unknown, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push("transform must be an object");
    return;
  }
  rejectUnexpectedKeys(
    value,
    ["ref", "version", "semanticHash"],
    "transform",
    issues,
  );
  if (
    !nonEmptyString(value.ref) ||
    !value.ref.startsWith("transform://") ||
    !value.ref.includes("@")
  ) {
    issues.push("transform.ref must be a versioned transform URI");
  }
  requireString(value, "version", issues, "transform.");
  requireDigest(value.semanticHash, "transform.semanticHash", issues);
}

function validatePolicy(value: unknown, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push("policy must be an object");
    return;
  }
  rejectUnexpectedKeys(value, ["ref", "authority"], "policy", issues);
  if (
    !nonEmptyString(value.ref) ||
    !value.ref.startsWith("policy://") ||
    !value.ref.includes("@")
  ) {
    issues.push("policy.ref must be a versioned policy URI");
  }
  requireString(value, "authority", issues, "policy.");
}

function validateClassifiedDigest(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  rejectUnexpectedKeys(value, ["classification", "digest"], path, issues);
  classification(value.classification, `${path}.classification`, issues);
  requireDigest(value.digest, `${path}.digest`, issues);
}

function validateAttestation(value: unknown, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push("attestation must be an object");
    return;
  }
  rejectUnexpectedKeys(
    value,
    ["algorithm", "keyRef", "payloadDigest", "signature"],
    "attestation",
    issues,
  );
  if (value.algorithm !== "ed25519") {
    issues.push("attestation.algorithm must be ed25519");
  }
  requireString(value, "keyRef", issues, "attestation.");
  requireDigest(value.payloadDigest, "attestation.payloadDigest", issues);
  if (
    !nonEmptyString(value.signature) ||
    value.signature.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value.signature)
  ) {
    issues.push("attestation.signature must be base64");
  }
}

function validateFailure(value: unknown, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push("failed receipt must include failure");
    return;
  }
  rejectUnexpectedKeys(value, ["code", "retryable"], "failure", issues);
  const codes: readonly string[] = [
    "POLICY_DENIED",
    "TRANSFORM_UNAVAILABLE",
    "TRANSFORM_FAILED",
    "OUTPUT_CLASSIFICATION_INVALID",
    "RECEIPT_ATTESTATION_FAILED",
  ];
  if (!codes.includes(String(value.code))) {
    issues.push("failure.code is not recognized");
  }
  if (typeof value.retryable !== "boolean") {
    issues.push("failure.retryable must be a boolean");
  }
}

function classification(
  value: unknown,
  path: string,
  issues: string[],
): FlowDataClassification | undefined {
  if (
    value === "public" ||
    value === "internal" ||
    value === "sensitive" ||
    value === "secret"
  ) {
    return value;
  }
  issues.push(`${path} must be a data classification`);
  return undefined;
}

function requireDigest(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!nonEmptyString(value) || !SHA256_PATTERN.test(value)) {
    issues.push(`${path} must be a lowercase SHA-256 digest`);
  }
}

function requireString(
  value: Record<PropertyKey, unknown>,
  key: string,
  issues: string[],
  prefix = "",
): void {
  if (!nonEmptyString(value[key])) {
    issues.push(`${prefix}${key} must be a non-empty string`);
  }
}

function requireDate(
  value: Record<PropertyKey, unknown>,
  key: string,
  issues: string[],
): void {
  if (!validDate(value[key])) issues.push(`${key} must be an RFC 3339 date-time`);
}

function validDate(value: unknown): boolean {
  return (
    nonEmptyString(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnexpectedKeys(
  value: Record<PropertyKey, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  const allowedKeys = new Set<PropertyKey>(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "string" && !allowedKeys.has(key)) {
      issues.push(`${path}.${key} is not allowed`);
    }
  }
}

function invalid(issue: string): FlowSecurityContractValidation {
  return { valid: false, issues: Object.freeze([issue]) };
}
