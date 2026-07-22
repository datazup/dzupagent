import type { FlowDocumentV1 } from "../../types.js";
import {
  describeJsType,
  isPlainObject,
  joinPath,
} from "../../validation-helpers.js";
import type { SchemaIssue } from "../shared.js";

export function validateOptionalDefaults(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowDocumentV1["defaults"] | undefined {
  if (!("defaults" in obj) || obj["defaults"] === undefined) return undefined;
  const value = obj["defaults"];
  if (!isPlainObject(value)) {
    issues.push({
      path: joinPath(path, "defaults"),
      code: "MISSING_REQUIRED_FIELD",
      message: `document.defaults must be an object when present, received ${describeJsType(
        value
      )}`,
    });
    return undefined;
  }

  const defaults: NonNullable<FlowDocumentV1["defaults"]> = {};
  if ("personaRef" in value && value["personaRef"] !== undefined) {
    if (typeof value["personaRef"] === "string")
      defaults.personaRef = value["personaRef"];
    else {
      issues.push({
        path: joinPath(joinPath(path, "defaults"), "personaRef"),
        code: "MISSING_REQUIRED_FIELD",
        message: "defaults.personaRef must be a string when present",
      });
    }
  }
  if ("timeoutMs" in value && value["timeoutMs"] !== undefined) {
    if (
      typeof value["timeoutMs"] === "number" &&
      Number.isFinite(value["timeoutMs"]) &&
      value["timeoutMs"] > 0
    ) {
      defaults.timeoutMs = value["timeoutMs"];
    } else {
      issues.push({
        path: joinPath(joinPath(path, "defaults"), "timeoutMs"),
        code: "MISSING_REQUIRED_FIELD",
        message: "defaults.timeoutMs must be a positive number when present",
      });
    }
  }
  if ("retry" in value && value["retry"] !== undefined) {
    const retry = value["retry"];
    if (isPlainObject(retry)) {
      const attempts = retry["attempts"];
      if (
        typeof attempts === "number" &&
        Number.isInteger(attempts) &&
        attempts > 0
      ) {
        defaults.retry = { attempts };
        const delayMs = retry["delayMs"];
        if (delayMs !== undefined) {
          if (
            typeof delayMs === "number" &&
            Number.isFinite(delayMs) &&
            delayMs >= 0
          ) {
            defaults.retry.delayMs = delayMs;
          } else {
            issues.push({
              path: joinPath(
                joinPath(joinPath(path, "defaults"), "retry"),
                "delayMs"
              ),
              code: "MISSING_REQUIRED_FIELD",
              message:
                "defaults.retry.delayMs must be a non-negative number when present",
            });
          }
        }
      } else {
        issues.push({
          path: joinPath(
            joinPath(joinPath(path, "defaults"), "retry"),
            "attempts"
          ),
          code: "MISSING_REQUIRED_FIELD",
          message: "defaults.retry.attempts must be a positive integer",
        });
      }
    } else {
      issues.push({
        path: joinPath(joinPath(path, "defaults"), "retry"),
        code: "MISSING_REQUIRED_FIELD",
        message: "defaults.retry must be an object when present",
      });
    }
  }

  return Object.keys(defaults).length > 0 ? defaults : {};
}
