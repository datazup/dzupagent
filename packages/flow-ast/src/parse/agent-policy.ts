/**
 * Agent-node policy parser.
 *
 * Extracted from `parse/agent.ts` (MC-5 god-module split). Covers the
 * `agent.policy` block (timeouts, budgets, tool-call caps, working directory,
 * approval, audit). Mirrors `../validate/agent-policy.ts`; shape constraints
 * are unchanged.
 */

import type { AgentPolicy } from "../types.js";
import { type ParseContext, isPlainObject, joinPointer } from "./shared.js";
import {
  isPositiveFinitePolicyNumber,
  isPositiveFiniteNumber,
} from "../policy-numbers.js";

export function parsePolicy(
  raw: unknown,
  pointer: string,
  ctx: ParseContext
): AgentPolicy | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    ctx.errors.push({
      code: "EXPECTED_OBJECT",
      message: "agent.policy must be an object",
      pointer,
    });
    return undefined;
  }
  const policy: AgentPolicy = {};
  if (raw.timeoutMs !== undefined) {
    if (!isPositiveFiniteNumber(raw.timeoutMs)) {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: "agent.policy.timeoutMs must be a positive number",
        pointer: joinPointer(pointer, "timeoutMs"),
      });
    } else {
      policy.timeoutMs = raw.timeoutMs;
    }
  }
  numberField(raw, "budgetCents", pointer, ctx, (v) => {
    policy.budgetCents = v;
  });
  if (raw.maxToolCalls !== undefined) {
    if (!isPositiveFinitePolicyNumber(raw.maxToolCalls)) {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: "agent.policy.maxToolCalls must be a positive integer",
        pointer: joinPointer(pointer, "maxToolCalls"),
      });
    } else {
      policy.maxToolCalls = raw.maxToolCalls;
    }
  }
  if (raw.workingDirectory !== undefined) {
    if (typeof raw.workingDirectory !== "string") {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: "agent.policy.workingDirectory must be a string",
        pointer: joinPointer(pointer, "workingDirectory"),
      });
    } else policy.workingDirectory = raw.workingDirectory;
  }
  if (raw.approval !== undefined) {
    if (!isPlainObject(raw.approval)) {
      ctx.errors.push({
        code: "EXPECTED_OBJECT",
        message: "agent.policy.approval must be an object",
        pointer: joinPointer(pointer, "approval"),
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
        ctx.errors.push({
          code: "WRONG_FIELD_TYPE",
          message:
            "agent.policy.approval.requiredFor must be an array of strings",
          pointer: joinPointer(pointer, "approval/requiredFor"),
        });
      }
    }
  }
  if (raw.audit !== undefined) {
    if (!isPlainObject(raw.audit)) {
      ctx.errors.push({
        code: "EXPECTED_OBJECT",
        message: "agent.policy.audit must be an object",
        pointer: joinPointer(pointer, "audit"),
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

function numberField(
  obj: Record<string, unknown>,
  key: string,
  pointer: string,
  ctx: ParseContext,
  assign: (v: number) => void
): void {
  if (obj[key] === undefined) return;
  if (typeof obj[key] !== "number") {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `${pointer}/${key} must be a number`,
      pointer: joinPointer(pointer, key),
    });
    return;
  }
  assign(obj[key] as number);
}
