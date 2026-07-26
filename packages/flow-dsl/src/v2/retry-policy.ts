import type { PrimitiveDefinitionV2 } from "../primitives/types.js";

export const FLOW_PRIMITIVE_RETRY_POLICY_CAPABILITY =
  "flow.retry.primitive-errors@1" as const;

export const MAX_PRIMITIVE_RETRY_ATTEMPTS = 20;

export interface PrimitiveRetryBackoff {
  readonly strategy: "fixed" | "exponential";
  readonly initialMs: number;
  readonly maxMs: number;
  readonly jitter: "none" | "full";
}

export interface PrimitiveRetryPolicy {
  /** Exact, case-sensitive primitive error codes. Wildcards are not allowed. */
  readonly match: readonly string[];
  /** Total same-invocation attempts, including the initial attempt. */
  readonly maxAttempts: number;
  readonly backoff?: PrimitiveRetryBackoff;
  readonly attemptIdentity: "same-invocation";
}

export type PrimitiveRetryPolicyErrorCode =
  | "V2_RETRY_OBJECT_REQUIRED"
  | "V2_RETRY_UNKNOWN_FIELD"
  | "V2_RETRY_MATCH_REQUIRED"
  | "V2_RETRY_MATCH_INVALID"
  | "V2_RETRY_MATCH_DUPLICATE"
  | "V2_RETRY_ERROR_UNDECLARED"
  | "V2_RETRY_ERROR_NOT_RETRYABLE"
  | "V2_RETRY_MAX_ATTEMPTS_INVALID"
  | "V2_RETRY_BACKOFF_OBJECT_REQUIRED"
  | "V2_RETRY_BACKOFF_UNKNOWN_FIELD"
  | "V2_RETRY_BACKOFF_INVALID";

export interface PrimitiveRetryPolicyError {
  readonly code: PrimitiveRetryPolicyErrorCode;
  readonly field?: string;
  readonly message: string;
}

export type PrimitiveRetryPolicyResult =
  | {
      readonly ok: true;
      readonly policy: PrimitiveRetryPolicy;
    }
  | {
      readonly ok: false;
      readonly errors: readonly PrimitiveRetryPolicyError[];
    };

const RETRY_FIELDS = new Set(["match", "maxAttempts", "backoff"]);
const BACKOFF_FIELDS = new Set([
  "strategy",
  "initialMs",
  "maxMs",
  "jitter",
]);

/**
 * Validate a bounded same-invocation retry envelope against one exact
 * primitive definition. This function grants no runtime authority: targets
 * must separately adopt FLOW_PRIMITIVE_RETRY_POLICY_CAPABILITY.
 */
export function evaluatePrimitiveRetryPolicy(
  definition: PrimitiveDefinitionV2,
  raw: unknown,
): PrimitiveRetryPolicyResult {
  if (!isPlainRecord(raw)) {
    return failure(
      "V2_RETRY_OBJECT_REQUIRED",
      "v2 primitive retry must be a plain object",
    );
  }

  const errors: PrimitiveRetryPolicyError[] = [];
  for (const field of Object.keys(raw).sort()) {
    if (!RETRY_FIELDS.has(field)) {
      errors.push({
        code: "V2_RETRY_UNKNOWN_FIELD",
        field,
        message: `v2 primitive retry does not support field "${field}"`,
      });
    }
  }

  const match = validateMatch(definition, raw.match, errors);
  const maxAttempts = validateMaxAttempts(raw.maxAttempts, errors);
  const backoff = validateBackoff(raw.backoff, errors);
  if (errors.length > 0 || match === undefined || maxAttempts === undefined) {
    return {
      ok: false,
      errors: freezeErrors(errors),
    };
  }

  return {
    ok: true,
    policy: Object.freeze({
      match: Object.freeze([...match]),
      maxAttempts,
      ...(backoff === undefined ? {} : { backoff }),
      attemptIdentity: "same-invocation" as const,
    }),
  };
}

function validateMatch(
  definition: PrimitiveDefinitionV2,
  raw: unknown,
  errors: PrimitiveRetryPolicyError[],
): readonly string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push({
      code: "V2_RETRY_MATCH_REQUIRED",
      field: "match",
      message: "retry.match must be a non-empty array of exact error codes",
    });
    return undefined;
  }

  const declared = new Map(
    definition.errors.map((error) => [error.code, error] as const),
  );
  const seen = new Set<string>();
  const match: string[] = [];
  for (const [index, value] of raw.entries()) {
    const field = `match[${index}]`;
    if (typeof value !== "string" || value.length === 0 || value === "*") {
      errors.push({
        code: "V2_RETRY_MATCH_INVALID",
        field,
        message:
          "retry.match entries must be non-empty exact error codes; wildcards are not allowed",
      });
      continue;
    }
    if (seen.has(value)) {
      errors.push({
        code: "V2_RETRY_MATCH_DUPLICATE",
        field,
        message: `retry.match repeats error code "${value}"`,
      });
      continue;
    }
    seen.add(value);
    const error = declared.get(value);
    if (error === undefined) {
      errors.push({
        code: "V2_RETRY_ERROR_UNDECLARED",
        field,
        message:
          `primitive ${definition.ref} does not declare error code "${value}"`,
      });
      continue;
    }
    if (!error.retryable) {
      errors.push({
        code: "V2_RETRY_ERROR_NOT_RETRYABLE",
        field,
        message:
          `primitive ${definition.ref} declares error code "${value}" as terminal`,
      });
      continue;
    }
    match.push(value);
  }
  return match;
}

function validateMaxAttempts(
  value: unknown,
  errors: PrimitiveRetryPolicyError[],
): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 2 ||
    value > MAX_PRIMITIVE_RETRY_ATTEMPTS
  ) {
    errors.push({
      code: "V2_RETRY_MAX_ATTEMPTS_INVALID",
      field: "maxAttempts",
      message:
        `retry.maxAttempts must be an integer from 2 to ${MAX_PRIMITIVE_RETRY_ATTEMPTS}, including the initial attempt`,
    });
    return undefined;
  }
  return value;
}

function validateBackoff(
  raw: unknown,
  errors: PrimitiveRetryPolicyError[],
): PrimitiveRetryBackoff | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainRecord(raw)) {
    errors.push({
      code: "V2_RETRY_BACKOFF_OBJECT_REQUIRED",
      field: "backoff",
      message: "retry.backoff must be a plain object",
    });
    return undefined;
  }
  for (const field of Object.keys(raw).sort()) {
    if (!BACKOFF_FIELDS.has(field)) {
      errors.push({
        code: "V2_RETRY_BACKOFF_UNKNOWN_FIELD",
        field: `backoff.${field}`,
        message: `retry.backoff does not support field "${field}"`,
      });
    }
  }
  const validStrategy =
    raw.strategy === "fixed" || raw.strategy === "exponential";
  const validInitial = isNonNegativeInteger(raw.initialMs);
  const validMaximum = isNonNegativeInteger(raw.maxMs);
  const validJitter = raw.jitter === "none" || raw.jitter === "full";
  if (!validStrategy) {
    errors.push(
      invalidBackoff(
        "strategy",
        'retry.backoff.strategy must be "fixed" or "exponential"',
      ),
    );
  }
  if (!validInitial) {
    errors.push(
      invalidBackoff(
        "initialMs",
        "retry.backoff.initialMs must be a non-negative integer",
      ),
    );
  }
  if (!validMaximum) {
    errors.push(
      invalidBackoff(
        "maxMs",
        "retry.backoff.maxMs must be a non-negative integer",
      ),
    );
  }
  if (!validJitter) {
    errors.push(
      invalidBackoff(
        "jitter",
        'retry.backoff.jitter must be "none" or "full"',
      ),
    );
  }
  if (
    validInitial &&
    validMaximum &&
    (raw.maxMs as number) < (raw.initialMs as number)
  ) {
    errors.push(
      invalidBackoff(
        "maxMs",
        "retry.backoff.maxMs must be greater than or equal to initialMs",
      ),
    );
  }
  if (
    !validStrategy ||
    !validInitial ||
    !validMaximum ||
    !validJitter ||
    (raw.maxMs as number) < (raw.initialMs as number)
  ) {
    return undefined;
  }
  return Object.freeze({
    strategy: raw.strategy as PrimitiveRetryBackoff["strategy"],
    initialMs: raw.initialMs as number,
    maxMs: raw.maxMs as number,
    jitter: raw.jitter as PrimitiveRetryBackoff["jitter"],
  });
}

function invalidBackoff(
  field: string,
  message: string,
): PrimitiveRetryPolicyError {
  return {
    code: "V2_RETRY_BACKOFF_INVALID",
    field: `backoff.${field}`,
    message,
  };
}

function failure(
  code: PrimitiveRetryPolicyErrorCode,
  message: string,
): PrimitiveRetryPolicyResult {
  return {
    ok: false,
    errors: Object.freeze([Object.freeze({ code, message })]),
  };
}

function freezeErrors(
  errors: readonly PrimitiveRetryPolicyError[],
): readonly PrimitiveRetryPolicyError[] {
  return Object.freeze(
    errors.map((error) => Object.freeze({ ...error })),
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
