/**
 * Per-field normalizers for the `agent` node's validation and policy fields,
 * plus the shared `normalizeCommands` helper (also consumed by the `validate`
 * node). Shape constraints must agree with `@dzupagent/flow-ast`'s
 * `parse/agent.ts` and `validate/agent.ts`.
 */

import type {
  AgentPolicy,
  AgentValidation,
  AgentValidationCommand,
} from "@dzupagent/flow-ast";
import { isPositiveFinitePolicyNumber } from "@dzupagent/flow-ast";

import { DSL_ERROR } from "../errors.js";
import { isPlainObject } from "../normalize-value-helpers.js";
import type { DslDiagnostic } from "../types.js";

export function normalizeValidation(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[]
): AgentValidation | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: "agent.validation must be an object",
      path,
    });
    return undefined;
  }
  const required = normalizeCommands(
    raw.required,
    `${path}.required`,
    diagnostics,
    true
  );
  if (required === undefined) return undefined;
  const out: AgentValidation = { required };
  if (raw.repair !== undefined) {
    if (!isPlainObject(raw.repair)) {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: "agent.validation.repair must be an object",
        path: `${path}.repair`,
      });
    } else {
      const max = raw.repair.maxAttempts;
      if (typeof max !== "number" || max < 0) {
        diagnostics.push({
          phase: "normalize",
          code: DSL_ERROR.MISSING_REQUIRED_FIELD,
          message:
            "agent.validation.repair.maxAttempts is required (non-negative number)",
          path: `${path}.repair.maxAttempts`,
        });
      } else {
        out.repair = { maxAttempts: max };
      }
    }
  }
  return out;
}

export function normalizeCommands(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
  required: boolean
): AgentValidationCommand[] | undefined {
  if (raw === undefined) {
    if (required) {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.MISSING_REQUIRED_FIELD,
        message: `${path} is required`,
        path,
      });
    }
    return undefined;
  }
  if (!Array.isArray(raw)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: `${path} must be an array`,
      path,
    });
    return undefined;
  }
  if (required && raw.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: `${path} must contain at least one entry`,
      path,
    });
    return undefined;
  }
  const out: AgentValidationCommand[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const itemPath = `${path}[${i}]`;
    if (!isPlainObject(item)) {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: `${itemPath} must be an object`,
        path: itemPath,
      });
      continue;
    }
    const command = item.command;
    if (typeof command !== "string" || command.length === 0) {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.MISSING_REQUIRED_FIELD,
        message: `${itemPath}.command is required (non-empty string)`,
        path: `${itemPath}.command`,
      });
      continue;
    }
    const entry: AgentValidationCommand = { command };
    if (typeof item.id === "string" && item.id.length > 0) entry.id = item.id;
    out.push(entry);
  }
  return out;
}

export function normalizePolicy(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[]
): AgentPolicy | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: "agent.policy must be an object",
      path,
    });
    return undefined;
  }
  const policy: AgentPolicy = {};
  if (typeof raw.timeoutMs === "number") policy.timeoutMs = raw.timeoutMs;
  if (typeof raw.budgetCents === "number") policy.budgetCents = raw.budgetCents;
  if (raw.maxToolCalls !== undefined) {
    // DZUPAGENT-CODE-M-06: maxToolCalls must be a positive integer — parity
    // with parse/validate (reject 0/negative/non-finite uniformly).
    if (isPositiveFinitePolicyNumber(raw.maxToolCalls)) {
      policy.maxToolCalls = raw.maxToolCalls;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: "agent.policy.maxToolCalls must be a positive integer",
        path,
      });
    }
  }
  if (typeof raw.workingDirectory === "string")
    policy.workingDirectory = raw.workingDirectory;
  if (raw.approval !== undefined) {
    if (!isPlainObject(raw.approval)) {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: "agent.policy.approval must be an object",
        path: `${path}.approval`,
      });
    } else {
      const requiredFor = raw.approval.requiredFor;
      if (requiredFor === undefined) {
        policy.approval = {};
      } else if (
        Array.isArray(requiredFor) &&
        requiredFor.every((v): v is string => typeof v === "string")
      ) {
        policy.approval = { requiredFor };
      } else {
        diagnostics.push({
          phase: "normalize",
          code: DSL_ERROR.INVALID_NODE_SHAPE,
          message:
            "agent.policy.approval.requiredFor must be an array of strings",
          path: `${path}.approval.requiredFor`,
        });
      }
    }
  }
  if (raw.audit !== undefined) {
    if (!isPlainObject(raw.audit)) {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: "agent.policy.audit must be an object",
        path: `${path}.audit`,
      });
    } else {
      const audit: NonNullable<AgentPolicy["audit"]> = {};
      if (typeof raw.audit.captureToolCalls === "boolean") {
        audit.captureToolCalls = raw.audit.captureToolCalls;
      }
      if (typeof raw.audit.captureDiffs === "boolean") {
        audit.captureDiffs = raw.audit.captureDiffs;
      }
      policy.audit = audit;
    }
  }
  return policy;
}
