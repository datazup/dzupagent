import type { FlowDocumentPolicy } from "../../types.js";
import {
  describeJsType,
  isPlainObject,
  joinPath,
} from "../../validation-helpers.js";
import type { SchemaIssue } from "../shared.js";

export function validateOptionalDocumentPolicy(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowDocumentPolicy | undefined {
  if (!("policy" in obj) || obj["policy"] === undefined) return undefined;
  const value = obj["policy"];
  if (!isPlainObject(value)) {
    issues.push({
      path: joinPath(path, "policy"),
      code: "MISSING_REQUIRED_FIELD",
      message: `document.policy must be an object when present, received ${describeJsType(
        value
      )}`,
    });
    return undefined;
  }

  const policy: FlowDocumentPolicy = {};

  if ("budgetCents" in value && value["budgetCents"] !== undefined) {
    const v = value["budgetCents"];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      issues.push({
        path: joinPath(joinPath(path, "policy"), "budgetCents"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "document.policy.budgetCents must be a finite number when present",
      });
    } else if (v <= 0) {
      issues.push({
        path: joinPath(joinPath(path, "policy"), "budgetCents"),
        code: "MISSING_REQUIRED_FIELD",
        message: "document.policy.budgetCents must be greater than 0",
      });
    } else {
      policy.budgetCents = v;
    }
  }

  if ("timeoutMs" in value && value["timeoutMs"] !== undefined) {
    const v = value["timeoutMs"];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      issues.push({
        path: joinPath(joinPath(path, "policy"), "timeoutMs"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "document.policy.timeoutMs must be a finite number when present",
      });
    } else if (v <= 0) {
      issues.push({
        path: joinPath(joinPath(path, "policy"), "timeoutMs"),
        code: "MISSING_REQUIRED_FIELD",
        message: "document.policy.timeoutMs must be greater than 0",
      });
    } else {
      policy.timeoutMs = v;
    }
  }

  if ("workingDirectory" in value && value["workingDirectory"] !== undefined) {
    const v = value["workingDirectory"];
    if (typeof v !== "string") {
      issues.push({
        path: joinPath(joinPath(path, "policy"), "workingDirectory"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "document.policy.workingDirectory must be a string when present",
      });
    } else {
      policy.workingDirectory = v;
    }
  }

  return policy;
}
