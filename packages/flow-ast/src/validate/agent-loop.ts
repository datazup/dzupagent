/**
 * Agent-node loop-control validators: structured output, stop conditions,
 * invalid-output handling, and per-failure retry branches.
 *
 * Extracted from `validate/agent.ts` (MC-5 god-module split). Shape
 * constraints are unchanged from the original inline helpers.
 */

import type {
  AgentOnInvalidOutput,
  AgentOutput,
  AgentRetry,
  AgentStop,
} from "../types.js";
import {
  describeJsType,
  isPlainObject,
  joinPath,
} from "../validation-helpers.js";
import {
  isPositiveFinitePolicyNumber,
  isNonNegativeNumber,
} from "../policy-numbers.js";
import type { SchemaIssue } from "./shared.js";

export function validateAgentOutput(
  raw: unknown,
  path: string,
  issues: SchemaIssue[]
): AgentOutput | null {
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.output is required (object), received ${describeJsType(
        raw
      )}`,
    });
    return null;
  }
  const key = raw["key"];
  if (typeof key !== "string" || key.length === 0) {
    issues.push({
      path: joinPath(path, "key"),
      code: "MISSING_REQUIRED_FIELD",
      message: "agent.output.key is required (non-empty string)",
    });
    return null;
  }
  const schemaRef = raw["schemaRef"];
  const schema = raw["schema"];
  if (schemaRef === undefined && schema === undefined) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: "agent.output requires either `schemaRef` or inline `schema`",
    });
    return null;
  }
  if (schemaRef !== undefined && typeof schemaRef !== "string") {
    issues.push({
      path: joinPath(path, "schemaRef"),
      code: "MISSING_REQUIRED_FIELD",
      message: "agent.output.schemaRef must be a string when present",
    });
    return null;
  }
  if (schema !== undefined && !isPlainObject(schema)) {
    issues.push({
      path: joinPath(path, "schema"),
      code: "MISSING_REQUIRED_FIELD",
      message: "agent.output.schema must be an object when present",
    });
    return null;
  }
  const out: AgentOutput = { key };
  if (typeof schemaRef === "string") out.schemaRef = schemaRef;
  if (isPlainObject(schema)) out.schema = schema;
  return out;
}

export function validateAgentStop(
  raw: unknown,
  path: string,
  issues: SchemaIssue[]
): AgentStop | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.stop must be an object when present, received ${describeJsType(
        raw
      )}`,
    });
    return undefined;
  }
  const stop: AgentStop = {};
  if (raw["maxIterations"] !== undefined) {
    if (typeof raw["maxIterations"] !== "number") {
      issues.push({
        path: joinPath(path, "maxIterations"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.stop.maxIterations must be a number",
      });
    } else {
      stop.maxIterations = raw["maxIterations"];
    }
  }
  if (raw["maxToolCalls"] !== undefined) {
    if (!isPositiveFinitePolicyNumber(raw["maxToolCalls"])) {
      issues.push({
        path: joinPath(path, "maxToolCalls"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.stop.maxToolCalls must be a positive integer",
      });
    } else {
      stop.maxToolCalls = raw["maxToolCalls"];
    }
  }
  if (raw["requireFinalSchema"] !== undefined) {
    if (typeof raw["requireFinalSchema"] !== "boolean") {
      issues.push({
        path: joinPath(path, "requireFinalSchema"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.stop.requireFinalSchema must be a boolean",
      });
    } else {
      stop.requireFinalSchema = raw["requireFinalSchema"];
    }
  }
  return stop;
}

export function validateOnInvalidOutput(
  raw: unknown,
  path: string,
  issues: SchemaIssue[]
): AgentOnInvalidOutput | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.onInvalidOutput must be an object, received ${describeJsType(
        raw
      )}`,
    });
    return undefined;
  }
  const retry = raw["retry"];
  if (!isNonNegativeNumber(retry)) {
    issues.push({
      path: joinPath(path, "retry"),
      code: "MISSING_REQUIRED_FIELD",
      message: "agent.onInvalidOutput.retry is required (non-negative number)",
    });
    return undefined;
  }
  const out: AgentOnInvalidOutput = { retry };
  if (raw["repairPrompt"] !== undefined) {
    if (typeof raw["repairPrompt"] !== "boolean") {
      issues.push({
        path: joinPath(path, "repairPrompt"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.onInvalidOutput.repairPrompt must be a boolean",
      });
    } else {
      out.repairPrompt = raw["repairPrompt"];
    }
  }
  if (raw["failAfterRetries"] !== undefined) {
    if (typeof raw["failAfterRetries"] !== "boolean") {
      issues.push({
        path: joinPath(path, "failAfterRetries"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.onInvalidOutput.failAfterRetries must be a boolean",
      });
    } else {
      out.failAfterRetries = raw["failAfterRetries"];
    }
  }
  return out;
}

export function validateAgentRetry(
  raw: unknown,
  path: string,
  issues: SchemaIssue[]
): AgentRetry | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.retry must be an object, received ${describeJsType(raw)}`,
    });
    return undefined;
  }
  const out: AgentRetry = {};
  const onInvalidOutput = raw["onInvalidOutput"];
  if (isPlainObject(onInvalidOutput)) {
    const attempts = onInvalidOutput["attempts"];
    if (!isNonNegativeNumber(attempts)) {
      issues.push({
        path: joinPath(path, "onInvalidOutput.attempts"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "retry.onInvalidOutput.attempts is required (non-negative number)",
      });
    } else {
      const branch: NonNullable<AgentRetry["onInvalidOutput"]> = { attempts };
      if (typeof onInvalidOutput["repairPrompt"] === "boolean") {
        branch.repairPrompt = onInvalidOutput["repairPrompt"];
      }
      out.onInvalidOutput = branch;
    }
  } else if (onInvalidOutput !== undefined) {
    issues.push({
      path: joinPath(path, "onInvalidOutput"),
      code: "MISSING_REQUIRED_FIELD",
      message: "retry.onInvalidOutput must be an object",
    });
  }
  const onToolError = raw["onToolError"];
  if (isPlainObject(onToolError)) {
    const attempts = onToolError["attempts"];
    if (!isNonNegativeNumber(attempts)) {
      issues.push({
        path: joinPath(path, "onToolError.attempts"),
        code: "MISSING_REQUIRED_FIELD",
        message: "retry.onToolError.attempts is required (non-negative number)",
      });
    } else {
      out.onToolError = { attempts };
    }
  } else if (onToolError !== undefined) {
    issues.push({
      path: joinPath(path, "onToolError"),
      code: "MISSING_REQUIRED_FIELD",
      message: "retry.onToolError must be an object",
    });
  }
  const onValidationFailure = raw["onValidationFailure"];
  if (isPlainObject(onValidationFailure)) {
    const attempts = onValidationFailure["attempts"];
    if (!isNonNegativeNumber(attempts)) {
      issues.push({
        path: joinPath(path, "onValidationFailure.attempts"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "retry.onValidationFailure.attempts is required (non-negative number)",
      });
    } else {
      const branch: NonNullable<AgentRetry["onValidationFailure"]> = {
        attempts,
      };
      if (typeof onValidationFailure["fullLoop"] === "boolean") {
        branch.fullLoop = onValidationFailure["fullLoop"];
      }
      out.onValidationFailure = branch;
    }
  } else if (onValidationFailure !== undefined) {
    issues.push({
      path: joinPath(path, "onValidationFailure"),
      code: "MISSING_REQUIRED_FIELD",
      message: "retry.onValidationFailure must be an object",
    });
  }
  const onModelUnavailable = raw["onModelUnavailable"];
  if (isPlainObject(onModelUnavailable)) {
    const attempts = onModelUnavailable["attempts"];
    if (!isNonNegativeNumber(attempts)) {
      issues.push({
        path: joinPath(path, "onModelUnavailable.attempts"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "retry.onModelUnavailable.attempts is required (non-negative number)",
      });
    } else {
      const branch: NonNullable<AgentRetry["onModelUnavailable"]> = {
        attempts,
      };
      if (typeof onModelUnavailable["fallbackProfile"] === "string") {
        branch.fallbackProfile = onModelUnavailable["fallbackProfile"];
      }
      out.onModelUnavailable = branch;
    }
  } else if (onModelUnavailable !== undefined) {
    issues.push({
      path: joinPath(path, "onModelUnavailable"),
      code: "MISSING_REQUIRED_FIELD",
      message: "retry.onModelUnavailable must be an object",
    });
  }
  return out;
}
