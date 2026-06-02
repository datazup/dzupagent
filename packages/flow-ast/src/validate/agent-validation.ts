/**
 * Agent-node validation-block validators.
 *
 * Extracted from `validate/agent.ts` (MC-5 god-module split). Covers the
 * `agent.validation` block and the shared `commands` array shape, which is
 * reused both by the agent node's `validation.required` and by the standalone
 * `validate` node's `commands`. The shape constraints are unchanged.
 */

import type { AgentValidation, AgentValidationCommand } from "../types.js";
import {
  describeJsType,
  isPlainObject,
  joinPath,
} from "../validation-helpers.js";
import { isNonNegativeNumber } from "../policy-numbers.js";
import type { SchemaIssue } from "./shared.js";

export function validateAgentValidation(
  raw: unknown,
  path: string,
  issues: SchemaIssue[]
): AgentValidation | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.validation must be an object, received ${describeJsType(
        raw
      )}`,
    });
    return undefined;
  }
  const required = validateValidationCommands(
    raw["required"],
    joinPath(path, "required"),
    issues,
    /* required */ true
  );
  if (required === undefined) return undefined;
  const out: AgentValidation = { required };
  if (raw["repair"] !== undefined) {
    if (!isPlainObject(raw["repair"])) {
      issues.push({
        path: joinPath(path, "repair"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.validation.repair must be an object",
      });
    } else {
      const max = raw["repair"]["maxAttempts"];
      if (!isNonNegativeNumber(max)) {
        issues.push({
          path: joinPath(path, "repair.maxAttempts"),
          code: "MISSING_REQUIRED_FIELD",
          message:
            "agent.validation.repair.maxAttempts is required (non-negative number)",
        });
      } else {
        out.repair = { maxAttempts: max };
      }
    }
  }
  return out;
}

export function validateValidationCommands(
  raw: unknown,
  path: string,
  issues: SchemaIssue[],
  required: boolean
): AgentValidationCommand[] | undefined {
  if (raw === undefined) {
    if (required) {
      issues.push({
        path,
        code: "MISSING_REQUIRED_FIELD",
        message: `${path} is required (array of {command} objects)`,
      });
    }
    return undefined;
  }
  if (!Array.isArray(raw)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `${path} must be an array, received ${describeJsType(raw)}`,
    });
    return undefined;
  }
  if (required && raw.length === 0) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `${path} must contain at least one entry`,
    });
    return undefined;
  }
  const out: AgentValidationCommand[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const itemPath = `${path}[${i}]`;
    if (!isPlainObject(item)) {
      issues.push({
        path: itemPath,
        code: "MISSING_REQUIRED_FIELD",
        message: `${itemPath} must be an object`,
      });
      continue;
    }
    const command = item["command"];
    if (typeof command !== "string" || command.length === 0) {
      issues.push({
        path: joinPath(itemPath, "command"),
        code: "MISSING_REQUIRED_FIELD",
        message: `${itemPath}.command is required (non-empty string)`,
      });
      continue;
    }
    const entry: AgentValidationCommand = { command };
    if (typeof item["id"] === "string" && item["id"].length > 0)
      entry.id = item["id"];
    out.push(entry);
  }
  return out;
}
