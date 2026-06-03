/**
 * Agent-node loop-control parsers: structured output, stop conditions,
 * invalid-output handling, and per-failure retry branches.
 *
 * Extracted from `parse/agent.ts` (MC-5 god-module split). Mirrors the
 * validator under `../validate/agent-loop.ts`; shape constraints are unchanged.
 */

import type {
  AgentOnInvalidOutput,
  AgentOutput,
  AgentRetry,
  AgentStop,
} from "../types.js";
import {
  type ParseContext,
  describeJsType,
  isPlainObject,
  joinPointer,
} from "./shared.js";
import {
  isPositiveFinitePolicyNumber,
  isNonNegativeNumber,
} from "../policy-numbers.js";

export function parseOutput(
  raw: unknown,
  pointer: string,
  ctx: ParseContext
): AgentOutput | null {
  if (!isPlainObject(raw)) {
    ctx.errors.push({
      code: "EXPECTED_OBJECT",
      message: `agent.output is required (object), received ${describeJsType(
        raw
      )}`,
      pointer,
    });
    return null;
  }
  const key = raw.key;
  if (typeof key !== "string" || key.length === 0) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: "agent.output.key is required (non-empty string)",
      pointer: joinPointer(pointer, "key"),
    });
    return null;
  }
  const schemaRef = raw.schemaRef;
  const schema = raw.schema;
  if (schemaRef === undefined && schema === undefined) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: "agent.output requires either `schemaRef` or inline `schema`",
      pointer,
    });
    return null;
  }
  if (schemaRef !== undefined && typeof schemaRef !== "string") {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: "agent.output.schemaRef must be a string when present",
      pointer: joinPointer(pointer, "schemaRef"),
    });
    return null;
  }
  if (schema !== undefined && !isPlainObject(schema)) {
    ctx.errors.push({
      code: "EXPECTED_OBJECT",
      message: "agent.output.schema must be an object when present",
      pointer: joinPointer(pointer, "schema"),
    });
    return null;
  }
  const out: AgentOutput = { key };
  if (typeof schemaRef === "string") out.schemaRef = schemaRef;
  if (isPlainObject(schema)) out.schema = schema;
  return out;
}

export function parseStop(
  raw: unknown,
  pointer: string,
  ctx: ParseContext
): AgentStop | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    ctx.errors.push({
      code: "EXPECTED_OBJECT",
      message: "agent.stop must be an object when present",
      pointer,
    });
    return undefined;
  }
  const stop: AgentStop = {};
  if (raw.maxIterations !== undefined) {
    if (typeof raw.maxIterations !== "number") {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: "agent.stop.maxIterations must be a number",
        pointer: joinPointer(pointer, "maxIterations"),
      });
    } else stop.maxIterations = raw.maxIterations;
  }
  if (raw.maxToolCalls !== undefined) {
    if (!isPositiveFinitePolicyNumber(raw.maxToolCalls)) {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: "agent.stop.maxToolCalls must be a positive integer",
        pointer: joinPointer(pointer, "maxToolCalls"),
      });
    } else stop.maxToolCalls = raw.maxToolCalls;
  }
  if (raw.requireFinalSchema !== undefined) {
    if (typeof raw.requireFinalSchema !== "boolean") {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: "agent.stop.requireFinalSchema must be a boolean",
        pointer: joinPointer(pointer, "requireFinalSchema"),
      });
    } else stop.requireFinalSchema = raw.requireFinalSchema;
  }
  return stop;
}

export function parseOnInvalidOutput(
  raw: unknown,
  pointer: string,
  ctx: ParseContext
): AgentOnInvalidOutput | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    ctx.errors.push({
      code: "EXPECTED_OBJECT",
      message: "agent.onInvalidOutput must be an object",
      pointer,
    });
    return undefined;
  }
  const retry = raw.retry;
  if (!isNonNegativeNumber(retry)) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: "agent.onInvalidOutput.retry is required (non-negative number)",
      pointer: joinPointer(pointer, "retry"),
    });
    return undefined;
  }
  const out: AgentOnInvalidOutput = { retry };
  if (typeof raw.repairPrompt === "boolean")
    out.repairPrompt = raw.repairPrompt;
  if (typeof raw.failAfterRetries === "boolean")
    out.failAfterRetries = raw.failAfterRetries;
  return out;
}

export function parseRetry(
  raw: unknown,
  pointer: string,
  ctx: ParseContext
): AgentRetry | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    ctx.errors.push({
      code: "EXPECTED_OBJECT",
      message: "agent.retry must be an object",
      pointer,
    });
    return undefined;
  }
  const out: AgentRetry = {};

  const onInvalidOutput = parseAttemptsBranch(
    raw.onInvalidOutput,
    joinPointer(pointer, "onInvalidOutput"),
    ctx
  );
  if (onInvalidOutput !== undefined) {
    const branch: NonNullable<AgentRetry["onInvalidOutput"]> = {
      attempts: onInvalidOutput.attempts,
    };
    if (
      isPlainObject(raw.onInvalidOutput) &&
      typeof raw.onInvalidOutput.repairPrompt === "boolean"
    ) {
      branch.repairPrompt = raw.onInvalidOutput.repairPrompt;
    }
    out.onInvalidOutput = branch;
  }

  const onToolError = parseAttemptsBranch(
    raw.onToolError,
    joinPointer(pointer, "onToolError"),
    ctx
  );
  if (onToolError !== undefined)
    out.onToolError = { attempts: onToolError.attempts };

  const onValidationFailure = parseAttemptsBranch(
    raw.onValidationFailure,
    joinPointer(pointer, "onValidationFailure"),
    ctx
  );
  if (onValidationFailure !== undefined) {
    const branch: NonNullable<AgentRetry["onValidationFailure"]> = {
      attempts: onValidationFailure.attempts,
    };
    if (
      isPlainObject(raw.onValidationFailure) &&
      typeof raw.onValidationFailure.fullLoop === "boolean"
    ) {
      branch.fullLoop = raw.onValidationFailure.fullLoop;
    }
    out.onValidationFailure = branch;
  }

  const onModelUnavailable = parseAttemptsBranch(
    raw.onModelUnavailable,
    joinPointer(pointer, "onModelUnavailable"),
    ctx
  );
  if (onModelUnavailable !== undefined) {
    const branch: NonNullable<AgentRetry["onModelUnavailable"]> = {
      attempts: onModelUnavailable.attempts,
    };
    if (
      isPlainObject(raw.onModelUnavailable) &&
      typeof raw.onModelUnavailable.fallbackProfile === "string"
    ) {
      branch.fallbackProfile = raw.onModelUnavailable.fallbackProfile;
    }
    out.onModelUnavailable = branch;
  }

  return out;
}

export function parseAttemptsBranch(
  raw: unknown,
  pointer: string,
  ctx: ParseContext
): { attempts: number } | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    ctx.errors.push({
      code: "EXPECTED_OBJECT",
      message: `${pointer} must be an object`,
      pointer,
    });
    return undefined;
  }
  const attempts = raw.attempts;
  if (!isNonNegativeNumber(attempts)) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `${pointer}/attempts is required (non-negative number)`,
      pointer: joinPointer(pointer, "attempts"),
    });
    return undefined;
  }
  return { attempts };
}
