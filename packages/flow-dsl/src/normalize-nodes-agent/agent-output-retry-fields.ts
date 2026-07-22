/**
 * Per-field normalizers for the `agent` node's execution-control fields:
 * output shape, stop conditions, invalid-output handling, and the retry
 * branch matrix. Shape constraints must agree with `@dzupagent/flow-ast`'s
 * `parse/agent.ts` and `validate/agent.ts`.
 */

import type {
  AgentOnInvalidOutput,
  AgentOutput,
  AgentRetry,
  AgentStop,
} from "@dzupagent/flow-ast";
import { isPositiveFinitePolicyNumber } from "@dzupagent/flow-ast";

import { DSL_ERROR } from "../errors.js";
import { isPlainObject } from "../normalize-value-helpers.js";
import type { DslDiagnostic } from "../types.js";

export function normalizeOutput(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[]
): AgentOutput | undefined {
  if (raw === undefined) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "agent.output is required",
      path,
    });
    return undefined;
  }
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: "agent.output must be an object",
      path,
    });
    return undefined;
  }
  const key = raw.key;
  if (typeof key !== "string" || key.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "agent.output.key is required",
      path: `${path}.key`,
    });
    return undefined;
  }
  if (raw.schemaRef === undefined && raw.schema === undefined) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "agent.output requires either `schemaRef` or inline `schema`",
      path,
    });
    return undefined;
  }
  if (raw.schemaRef !== undefined && typeof raw.schemaRef !== "string") {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: "agent.output.schemaRef must be a string when present",
      path: `${path}.schemaRef`,
    });
    return undefined;
  }
  if (raw.schema !== undefined && !isPlainObject(raw.schema)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: "agent.output.schema must be an object when present",
      path: `${path}.schema`,
    });
    return undefined;
  }
  const out: AgentOutput = { key };
  if (typeof raw.schemaRef === "string") out.schemaRef = raw.schemaRef;
  if (isPlainObject(raw.schema)) out.schema = raw.schema;
  return out;
}

export function normalizeStop(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[]
): AgentStop | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: "agent.stop must be an object",
      path,
    });
    return undefined;
  }
  const stop: AgentStop = {};
  if (typeof raw.maxIterations === "number")
    stop.maxIterations = raw.maxIterations;
  if (raw.maxToolCalls !== undefined) {
    // DZUPAGENT-CODE-M-06: maxToolCalls must be a positive integer — parity
    // with parse/validate (reject 0/negative/non-finite uniformly).
    if (isPositiveFinitePolicyNumber(raw.maxToolCalls)) {
      stop.maxToolCalls = raw.maxToolCalls;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: "agent.stop.maxToolCalls must be a positive integer",
        path,
      });
    }
  }
  if (typeof raw.requireFinalSchema === "boolean")
    stop.requireFinalSchema = raw.requireFinalSchema;
  return stop;
}

export function normalizeOnInvalidOutput(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[]
): AgentOnInvalidOutput | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: "agent.onInvalidOutput must be an object",
      path,
    });
    return undefined;
  }
  if (typeof raw.retry !== "number" || raw.retry < 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "agent.onInvalidOutput.retry is required (non-negative number)",
      path: `${path}.retry`,
    });
    return undefined;
  }
  const out: AgentOnInvalidOutput = { retry: raw.retry };
  if (typeof raw.repairPrompt === "boolean")
    out.repairPrompt = raw.repairPrompt;
  if (typeof raw.failAfterRetries === "boolean")
    out.failAfterRetries = raw.failAfterRetries;
  return out;
}

export function normalizeRetry(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[]
): AgentRetry | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: "agent.retry must be an object",
      path,
    });
    return undefined;
  }
  const out: AgentRetry = {};

  if (raw.onInvalidOutput !== undefined) {
    const branch = readAttemptsBranch(
      raw.onInvalidOutput,
      `${path}.onInvalidOutput`,
      diagnostics
    );
    if (branch !== undefined) {
      const b: NonNullable<AgentRetry["onInvalidOutput"]> = {
        attempts: branch.attempts,
      };
      if (
        isPlainObject(raw.onInvalidOutput) &&
        typeof raw.onInvalidOutput.repairPrompt === "boolean"
      ) {
        b.repairPrompt = raw.onInvalidOutput.repairPrompt;
      }
      out.onInvalidOutput = b;
    }
  }

  if (raw.onToolError !== undefined) {
    const branch = readAttemptsBranch(
      raw.onToolError,
      `${path}.onToolError`,
      diagnostics
    );
    if (branch !== undefined) out.onToolError = { attempts: branch.attempts };
  }

  if (raw.onValidationFailure !== undefined) {
    const branch = readAttemptsBranch(
      raw.onValidationFailure,
      `${path}.onValidationFailure`,
      diagnostics
    );
    if (branch !== undefined) {
      const b: NonNullable<AgentRetry["onValidationFailure"]> = {
        attempts: branch.attempts,
      };
      if (
        isPlainObject(raw.onValidationFailure) &&
        typeof raw.onValidationFailure.fullLoop === "boolean"
      ) {
        b.fullLoop = raw.onValidationFailure.fullLoop;
      }
      out.onValidationFailure = b;
    }
  }

  if (raw.onModelUnavailable !== undefined) {
    const branch = readAttemptsBranch(
      raw.onModelUnavailable,
      `${path}.onModelUnavailable`,
      diagnostics
    );
    if (branch !== undefined) {
      const b: NonNullable<AgentRetry["onModelUnavailable"]> = {
        attempts: branch.attempts,
      };
      if (
        isPlainObject(raw.onModelUnavailable) &&
        typeof raw.onModelUnavailable.fallbackProfile === "string"
      ) {
        b.fallbackProfile = raw.onModelUnavailable.fallbackProfile;
      }
      out.onModelUnavailable = b;
    }
  }

  return out;
}

function readAttemptsBranch(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[]
): { attempts: number } | undefined {
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: `${path} must be an object`,
      path,
    });
    return undefined;
  }
  if (typeof raw.attempts !== "number" || raw.attempts < 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: `${path}.attempts is required (non-negative number)`,
      path: `${path}.attempts`,
    });
    return undefined;
  }
  return { attempts: raw.attempts };
}
