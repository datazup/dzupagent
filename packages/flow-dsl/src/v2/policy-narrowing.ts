import type { PrimitiveDefinitionV2 } from "../primitives/types.js";

export const FLOW_PRIMITIVE_POLICY_NARROWING_CAPABILITY =
  "flow.policy.primitive-narrowing@1" as const;

export interface PrimitivePolicyLimits {
  readonly timeoutMs?: number;
  readonly budgetCents?: number;
  readonly requireApproval?: boolean;
}

export interface PrimitivePolicyNarrowing {
  readonly timeoutMs?: number;
  readonly budgetCents?: number;
  readonly requireApproval?: true;
}

export type PrimitivePolicyNarrowingErrorCode =
  | "V2_POLICY_OBJECT_REQUIRED"
  | "V2_POLICY_EMPTY"
  | "V2_POLICY_OVERRIDE_NOT_ALLOWED"
  | "V2_POLICY_OVERRIDE_SEMANTICS_UNSUPPORTED"
  | "V2_POLICY_OVERRIDE_INVALID"
  | "V2_POLICY_OVERRIDE_WIDENS_AUTHORITY"
  | "V2_INHERITED_POLICY_INVALID";

export interface PrimitivePolicyNarrowingError {
  readonly code: PrimitivePolicyNarrowingErrorCode;
  readonly field?: string;
  readonly message: string;
}

export type PrimitivePolicyNarrowingResult =
  | {
      readonly ok: true;
      readonly narrowing: PrimitivePolicyNarrowing;
      readonly effectivePolicy: PrimitivePolicyLimits;
    }
  | {
      readonly ok: false;
      readonly errors: readonly PrimitivePolicyNarrowingError[];
    };

const SUPPORTED_OVERRIDE_FIELDS = new Set([
  "timeoutMs",
  "budgetCents",
  "requireApproval",
]);

/**
 * Validate and intersect one authored policy with inherited host constraints.
 *
 * Numeric values are upper bounds and therefore compose with `min`. Approval
 * composes with logical `or`; authored `false` is rejected because it could
 * remove an inherited approval requirement. No field outside the exact
 * primitive allowlist receives semantics implicitly.
 */
export function evaluatePrimitivePolicyNarrowing(
  definition: PrimitiveDefinitionV2,
  authoredPolicy: unknown,
  inheritedPolicy: PrimitivePolicyLimits = {},
): PrimitivePolicyNarrowingResult {
  const errors: PrimitivePolicyNarrowingError[] = [];
  if (!isPlainRecord(authoredPolicy)) {
    return failure(
      "V2_POLICY_OBJECT_REQUIRED",
      "v2 primitive policy must be a plain object",
    );
  }

  const authoredEntries = Object.entries(authoredPolicy).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (authoredEntries.length === 0) {
    return failure(
      "V2_POLICY_EMPTY",
      "v2 primitive policy must contain at least one narrowing override",
    );
  }

  validateInheritedPolicy(inheritedPolicy, errors);
  const narrowing: {
    timeoutMs?: number;
    budgetCents?: number;
    requireApproval?: true;
  } = {};

  for (const [field, value] of authoredEntries) {
    if (!definition.policy.allowedOverrides.includes(field)) {
      errors.push({
        code: "V2_POLICY_OVERRIDE_NOT_ALLOWED",
        field,
        message:
          `primitive ${definition.ref} does not allow policy override "${field}"`,
      });
      continue;
    }
    if (!SUPPORTED_OVERRIDE_FIELDS.has(field)) {
      errors.push({
        code: "V2_POLICY_OVERRIDE_SEMANTICS_UNSUPPORTED",
        field,
        message:
          `policy override "${field}" is allowlisted by ${definition.ref} but has no reviewed narrowing semantics`,
      });
      continue;
    }

    if (field === "requireApproval") {
      if (value !== true) {
        errors.push({
          code: "V2_POLICY_OVERRIDE_WIDENS_AUTHORITY",
          field,
          message:
            "policy.requireApproval must be true; false cannot remove or weaken inherited approval",
        });
      } else {
        narrowing.requireApproval = true;
      }
      continue;
    }

    if (!isPositiveFiniteNumber(value)) {
      errors.push({
        code: "V2_POLICY_OVERRIDE_INVALID",
        field,
        message: `policy.${field} must be a positive finite number`,
      });
      continue;
    }
    if (field !== "timeoutMs" && field !== "budgetCents") continue;
    const inherited = inheritedPolicy[field];
    if (
      typeof inherited === "number" &&
      Number.isFinite(inherited) &&
      value > inherited
    ) {
      errors.push({
        code: "V2_POLICY_OVERRIDE_WIDENS_AUTHORITY",
        field,
        message:
          `policy.${field}=${value} exceeds inherited ceiling ${inherited}`,
      });
      continue;
    }
    narrowing[field] = value;
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors: Object.freeze(
        errors.map((error) => Object.freeze({ ...error })),
      ),
    };
  }

  const effectivePolicy: PrimitivePolicyLimits = Object.freeze({
    ...(inheritedPolicy.timeoutMs === undefined
      ? {}
      : { timeoutMs: inheritedPolicy.timeoutMs }),
    ...(inheritedPolicy.budgetCents === undefined
      ? {}
      : { budgetCents: inheritedPolicy.budgetCents }),
    ...(inheritedPolicy.requireApproval === undefined
      ? {}
      : { requireApproval: inheritedPolicy.requireApproval }),
    ...(narrowing.timeoutMs === undefined
      ? {}
      : {
          timeoutMs: Math.min(
            inheritedPolicy.timeoutMs ?? Number.POSITIVE_INFINITY,
            narrowing.timeoutMs,
          ),
        }),
    ...(narrowing.budgetCents === undefined
      ? {}
      : {
          budgetCents: Math.min(
            inheritedPolicy.budgetCents ?? Number.POSITIVE_INFINITY,
            narrowing.budgetCents,
          ),
        }),
    ...(narrowing.requireApproval === true
      ? { requireApproval: true as const }
      : {}),
  });
  return {
    ok: true,
    narrowing: Object.freeze({ ...narrowing }),
    effectivePolicy,
  };
}

function validateInheritedPolicy(
  inherited: PrimitivePolicyLimits,
  errors: PrimitivePolicyNarrowingError[],
): void {
  for (const field of ["timeoutMs", "budgetCents"] as const) {
    const value = inherited[field];
    if (value !== undefined && !isPositiveFiniteNumber(value)) {
      errors.push({
        code: "V2_INHERITED_POLICY_INVALID",
        field,
        message: `inherited policy.${field} must be a positive finite number`,
      });
    }
  }
  if (
    inherited.requireApproval !== undefined &&
    typeof inherited.requireApproval !== "boolean"
  ) {
    errors.push({
      code: "V2_INHERITED_POLICY_INVALID",
      field: "requireApproval",
      message: "inherited policy.requireApproval must be boolean",
    });
  }
}

function failure(
  code: PrimitivePolicyNarrowingErrorCode,
  message: string,
): PrimitivePolicyNarrowingResult {
  return {
    ok: false,
    errors: Object.freeze([Object.freeze({ code, message })]),
  };
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
