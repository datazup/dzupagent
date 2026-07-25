import type { PrimitiveDefinitionV2 } from "../primitives/types.js";

export const FLOW_PRIMITIVE_TERMINAL_CATCH_CAPABILITY =
  "flow.catch.primitive-terminal@1" as const;

export const MAX_PRIMITIVE_TERMINAL_CATCH_CLAUSES = 20;

export interface PrimitiveTerminalAttemptContract {
  readonly schema: "dzupagent.primitiveTerminalAttempt/v1";
  readonly primitiveRef: PrimitiveDefinitionV2["ref"];
  readonly primitiveSemanticHash: `sha256:${string}`;
  readonly errorCode: string;
  readonly status: "terminal";
  readonly retryable: false;
  readonly attemptIdentity: "same-invocation";
  readonly classification: "internal";
  readonly rawProviderContent: "excluded";
}

export type PrimitiveTerminalCatchAction =
  | {
      readonly action: "continue" | "complete";
    }
  | {
      readonly action: "fail";
      readonly code: string;
    };

export interface PrimitiveTerminalCatchClause {
  readonly matches: readonly PrimitiveTerminalAttemptContract[];
  readonly outcome: PrimitiveTerminalCatchAction;
}

export interface PrimitiveTerminalCatchContract {
  readonly clauses: readonly PrimitiveTerminalCatchClause[];
}

export type PrimitiveTerminalCatchErrorCode =
  | "V2_CATCH_ARRAY_REQUIRED"
  | "V2_CATCH_EMPTY"
  | "V2_CATCH_TOO_MANY_CLAUSES"
  | "V2_CATCH_CLAUSE_OBJECT_REQUIRED"
  | "V2_CATCH_UNKNOWN_FIELD"
  | "V2_CATCH_MATCH_REQUIRED"
  | "V2_CATCH_MATCH_INVALID"
  | "V2_CATCH_MATCH_DUPLICATE"
  | "V2_CATCH_ERROR_UNDECLARED"
  | "V2_CATCH_ERROR_NOT_TERMINAL"
  | "V2_CATCH_ACTION_INVALID"
  | "V2_CATCH_FAILURE_CODE_REQUIRED"
  | "V2_CATCH_FAILURE_CODE_FORBIDDEN";

export interface PrimitiveTerminalCatchError {
  readonly code: PrimitiveTerminalCatchErrorCode;
  readonly field?: string;
  readonly message: string;
}

export type PrimitiveTerminalCatchResult =
  | {
      readonly ok: true;
      readonly contract: PrimitiveTerminalCatchContract;
    }
  | {
      readonly ok: false;
      readonly errors: readonly PrimitiveTerminalCatchError[];
    };

const CLAUSE_FIELDS = new Set(["match", "action", "code"]);
const FAILURE_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

/**
 * Validate explicit handling for exact terminal primitive errors.
 *
 * Retryable errors are deliberately rejected: they belong to the separate
 * same-invocation retry contract. This validator records code-only,
 * content-free terminal attempt descriptors and grants no runtime authority.
 */
export function evaluatePrimitiveTerminalCatch(
  definition: PrimitiveDefinitionV2,
  raw: unknown,
): PrimitiveTerminalCatchResult {
  if (!Array.isArray(raw)) {
    return failure(
      "V2_CATCH_ARRAY_REQUIRED",
      "v2 primitive catch must be an array of terminal-error clauses",
    );
  }
  if (raw.length === 0) {
    return failure(
      "V2_CATCH_EMPTY",
      "v2 primitive catch must contain at least one clause",
    );
  }
  if (raw.length > MAX_PRIMITIVE_TERMINAL_CATCH_CLAUSES) {
    return failure(
      "V2_CATCH_TOO_MANY_CLAUSES",
      `v2 primitive catch supports at most ${MAX_PRIMITIVE_TERMINAL_CATCH_CLAUSES} clauses`,
    );
  }

  const errors: PrimitiveTerminalCatchError[] = [];
  const claimedCodes = new Set<string>();
  const clauses: PrimitiveTerminalCatchClause[] = [];
  for (const [index, value] of raw.entries()) {
    const clausePath = `[${index}]`;
    if (!isPlainRecord(value)) {
      errors.push({
        code: "V2_CATCH_CLAUSE_OBJECT_REQUIRED",
        field: clausePath,
        message: `catch${clausePath} must be a plain object`,
      });
      continue;
    }
    for (const field of Object.keys(value).sort()) {
      if (!CLAUSE_FIELDS.has(field)) {
        errors.push({
          code: "V2_CATCH_UNKNOWN_FIELD",
          field: `${clausePath}.${field}`,
          message: `catch${clausePath} does not support field "${field}"`,
        });
      }
    }
    const matches = validateTerminalMatches(
      definition,
      value.match,
      clausePath,
      claimedCodes,
      errors,
    );
    const outcome = validateOutcome(value, clausePath, errors);
    if (matches.length > 0 && outcome !== undefined) {
      clauses.push(
        Object.freeze({
          matches: Object.freeze(matches),
          outcome,
        }),
      );
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors: freezeErrors(errors),
    };
  }
  return {
    ok: true,
    contract: Object.freeze({
      clauses: Object.freeze(clauses),
    }),
  };
}

function validateTerminalMatches(
  definition: PrimitiveDefinitionV2,
  raw: unknown,
  clausePath: string,
  claimedCodes: Set<string>,
  errors: PrimitiveTerminalCatchError[],
): PrimitiveTerminalAttemptContract[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push({
      code: "V2_CATCH_MATCH_REQUIRED",
      field: `${clausePath}.match`,
      message:
        `catch${clausePath}.match must be a non-empty array of exact terminal error codes`,
    });
    return [];
  }

  const declared = new Map(
    definition.errors.map((error) => [error.code, error] as const),
  );
  const matches: PrimitiveTerminalAttemptContract[] = [];
  for (const [matchIndex, code] of raw.entries()) {
    const field = `${clausePath}.match[${matchIndex}]`;
    if (typeof code !== "string" || code.length === 0 || code === "*") {
      errors.push({
        code: "V2_CATCH_MATCH_INVALID",
        field,
        message:
          "catch match entries must be non-empty exact error codes; wildcards are not allowed",
      });
      continue;
    }
    if (claimedCodes.has(code)) {
      errors.push({
        code: "V2_CATCH_MATCH_DUPLICATE",
        field,
        message: `catch handles terminal error code "${code}" more than once`,
      });
      continue;
    }
    claimedCodes.add(code);
    const declaredError = declared.get(code);
    if (declaredError === undefined) {
      errors.push({
        code: "V2_CATCH_ERROR_UNDECLARED",
        field,
        message:
          `primitive ${definition.ref} does not declare error code "${code}"`,
      });
      continue;
    }
    if (declaredError.retryable) {
      errors.push({
        code: "V2_CATCH_ERROR_NOT_TERMINAL",
        field,
        message:
          `primitive ${definition.ref} declares error code "${code}" as retryable; use retry instead of catch`,
      });
      continue;
    }
    matches.push(
      Object.freeze({
        schema: "dzupagent.primitiveTerminalAttempt/v1" as const,
        primitiveRef: definition.ref,
        primitiveSemanticHash: definition.compatibility.semanticHash,
        errorCode: code,
        status: "terminal" as const,
        retryable: false as const,
        attemptIdentity: "same-invocation" as const,
        classification: "internal" as const,
        rawProviderContent: "excluded" as const,
      }),
    );
  }
  return matches;
}

function validateOutcome(
  value: Record<string, unknown>,
  clausePath: string,
  errors: PrimitiveTerminalCatchError[],
): PrimitiveTerminalCatchAction | undefined {
  if (
    value.action !== "continue" &&
    value.action !== "complete" &&
    value.action !== "fail"
  ) {
    errors.push({
      code: "V2_CATCH_ACTION_INVALID",
      field: `${clausePath}.action`,
      message:
        `catch${clausePath}.action must be "continue", "complete", or "fail"`,
    });
    return undefined;
  }
  if (value.action === "fail") {
    if (
      typeof value.code !== "string" ||
      !FAILURE_CODE_PATTERN.test(value.code)
    ) {
      errors.push({
        code: "V2_CATCH_FAILURE_CODE_REQUIRED",
        field: `${clausePath}.code`,
        message:
          `catch${clausePath}.code must be a non-empty stable failure code when action is "fail"`,
      });
      return undefined;
    }
    return Object.freeze({ action: "fail" as const, code: value.code });
  }
  if (value.code !== undefined) {
    errors.push({
      code: "V2_CATCH_FAILURE_CODE_FORBIDDEN",
      field: `${clausePath}.code`,
      message:
        `catch${clausePath}.code is allowed only when action is "fail"`,
    });
    return undefined;
  }
  return Object.freeze({ action: value.action });
}

function failure(
  code: PrimitiveTerminalCatchErrorCode,
  message: string,
): PrimitiveTerminalCatchResult {
  return {
    ok: false,
    errors: Object.freeze([Object.freeze({ code, message })]),
  };
}

function freezeErrors(
  errors: readonly PrimitiveTerminalCatchError[],
): readonly PrimitiveTerminalCatchError[] {
  return Object.freeze(
    errors.map((error) => Object.freeze({ ...error })),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
