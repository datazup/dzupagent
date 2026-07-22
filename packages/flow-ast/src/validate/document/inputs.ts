import type { FlowDocumentV1 } from "../../types.js";
import {
  describeJsType,
  isFlowValue,
  isPlainObject,
  joinPath,
} from "../../validation-helpers.js";
import type { SchemaIssue } from "../shared.js";

export function validateOptionalInputs(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowDocumentV1["inputs"] | undefined {
  if (!("inputs" in obj) || obj["inputs"] === undefined) return undefined;
  const value = obj["inputs"];
  if (!isPlainObject(value)) {
    issues.push({
      path: joinPath(path, "inputs"),
      code: "MISSING_REQUIRED_FIELD",
      message: `document.inputs must be an object when present, received ${describeJsType(
        value
      )}`,
    });
    return undefined;
  }

  const inputs: NonNullable<FlowDocumentV1["inputs"]> = {};
  for (const [key, rawSpec] of Object.entries(value)) {
    if (!isPlainObject(rawSpec)) {
      issues.push({
        path: joinPath(joinPath(path, "inputs"), key),
        code: "MISSING_REQUIRED_FIELD",
        message: "input spec must be an object",
      });
      continue;
    }

    const type = rawSpec["type"];
    if (
      type !== "string" &&
      type !== "number" &&
      type !== "boolean" &&
      type !== "object" &&
      type !== "array" &&
      type !== "any"
    ) {
      issues.push({
        path: joinPath(joinPath(joinPath(path, "inputs"), key), "type"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "input spec.type must be one of string|number|boolean|object|array|any",
      });
      continue;
    }

    const spec: NonNullable<FlowDocumentV1["inputs"]>[string] = { type };
    if ("required" in rawSpec && rawSpec["required"] !== undefined) {
      if (typeof rawSpec["required"] === "boolean")
        spec.required = rawSpec["required"];
      else {
        issues.push({
          path: joinPath(joinPath(joinPath(path, "inputs"), key), "required"),
          code: "MISSING_REQUIRED_FIELD",
          message: "input spec.required must be a boolean when present",
        });
      }
    }
    if ("description" in rawSpec && rawSpec["description"] !== undefined) {
      if (typeof rawSpec["description"] === "string")
        spec.description = rawSpec["description"];
      else {
        issues.push({
          path: joinPath(
            joinPath(joinPath(path, "inputs"), key),
            "description"
          ),
          code: "MISSING_REQUIRED_FIELD",
          message: "input spec.description must be a string when present",
        });
      }
    }
    if ("default" in rawSpec && rawSpec["default"] !== undefined) {
      if (isFlowValue(rawSpec["default"])) {
        spec.default = rawSpec["default"];
      } else {
        issues.push({
          path: joinPath(joinPath(joinPath(path, "inputs"), key), "default"),
          code: "MISSING_REQUIRED_FIELD",
          message: "input spec.default must be a JSON-like value when present",
        });
      }
    }
    inputs[key] = spec;
  }
  return inputs;
}
