/**
 * Agent-node policy and template-ref validators.
 *
 * Extracted from `validate/agent.ts` (MC-5 god-module split). Covers the
 * `agent.policy` block (timeouts, budgets, tool-call caps, working directory,
 * approval, audit) and the `agent.template` ref block. Shape constraints are
 * unchanged.
 */

import type { AgentPolicy, AgentTemplateRef } from "../types.js";
import {
  describeJsType,
  isPlainObject,
  joinPath,
} from "../validation-helpers.js";
import {
  isPositiveFinitePolicyNumber,
  isPositiveFiniteNumber,
} from "../policy-numbers.js";
import type { SchemaIssue } from "./shared.js";

export function validateAgentPolicy(
  raw: unknown,
  path: string,
  issues: SchemaIssue[]
): AgentPolicy | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.policy must be an object, received ${describeJsType(
        raw
      )}`,
    });
    return undefined;
  }
  const policy: AgentPolicy = {};
  if (raw["timeoutMs"] !== undefined) {
    if (!isPositiveFiniteNumber(raw["timeoutMs"])) {
      issues.push({
        path: joinPath(path, "timeoutMs"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.policy.timeoutMs must be a positive number",
      });
    } else {
      policy.timeoutMs = raw["timeoutMs"];
    }
  }
  if (raw["budgetCents"] !== undefined) {
    if (typeof raw["budgetCents"] !== "number") {
      issues.push({
        path: joinPath(path, "budgetCents"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.policy.budgetCents must be a number",
      });
    } else {
      policy.budgetCents = raw["budgetCents"];
    }
  }
  if (raw["maxToolCalls"] !== undefined) {
    if (!isPositiveFinitePolicyNumber(raw["maxToolCalls"])) {
      issues.push({
        path: joinPath(path, "maxToolCalls"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.policy.maxToolCalls must be a positive integer",
      });
    } else {
      policy.maxToolCalls = raw["maxToolCalls"];
    }
  }
  if (raw["workingDirectory"] !== undefined) {
    if (typeof raw["workingDirectory"] !== "string") {
      issues.push({
        path: joinPath(path, "workingDirectory"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.policy.workingDirectory must be a string",
      });
    } else {
      policy.workingDirectory = raw["workingDirectory"];
    }
  }
  if (raw["approval"] !== undefined) {
    if (!isPlainObject(raw["approval"])) {
      issues.push({
        path: joinPath(path, "approval"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.policy.approval must be an object",
      });
    } else {
      const requiredFor = raw["approval"]["requiredFor"];
      if (requiredFor === undefined) {
        policy.approval = {};
      } else if (
        Array.isArray(requiredFor) &&
        requiredFor.every((v): v is string => typeof v === "string")
      ) {
        policy.approval = { requiredFor };
      } else {
        issues.push({
          path: joinPath(path, "approval.requiredFor"),
          code: "MISSING_REQUIRED_FIELD",
          message:
            "agent.policy.approval.requiredFor must be an array of strings",
        });
      }
    }
  }
  if (raw["audit"] !== undefined) {
    if (!isPlainObject(raw["audit"])) {
      issues.push({
        path: joinPath(path, "audit"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.policy.audit must be an object",
      });
    } else {
      const audit: NonNullable<AgentPolicy["audit"]> = {};
      if (typeof raw["audit"]["captureToolCalls"] === "boolean") {
        audit.captureToolCalls = raw["audit"]["captureToolCalls"];
      }
      if (typeof raw["audit"]["captureDiffs"] === "boolean") {
        audit.captureDiffs = raw["audit"]["captureDiffs"];
      }
      policy.audit = audit;
    }
  }
  return policy;
}

export function validateAgentTemplateRef(
  raw: unknown,
  path: string,
  issues: SchemaIssue[]
): AgentTemplateRef | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.template must be an object when present, received ${describeJsType(
        raw
      )}`,
    });
    return undefined;
  }
  const ref = raw["ref"];
  if (typeof ref !== "string" || ref.length === 0) {
    issues.push({
      path: joinPath(path, "ref"),
      code: "MISSING_REQUIRED_FIELD",
      message: "agent.template.ref is required (non-empty string)",
    });
    return undefined;
  }
  const out: AgentTemplateRef = { ref };
  if (raw["inputDefaults"] !== undefined) {
    if (!isPlainObject(raw["inputDefaults"])) {
      issues.push({
        path: joinPath(path, "inputDefaults"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.template.inputDefaults must be an object when present",
      });
    } else {
      out.inputDefaults = raw["inputDefaults"];
    }
  }
  return out;
}
