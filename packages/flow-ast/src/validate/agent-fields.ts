/**
 * Agent-node optional primitive-field validators.
 *
 * Extracted from `validate/agent.ts` (MC-5 god-module split). These encode the
 * shape constraints for the simple optional fields on an agent node
 * (`profile`, `toolset`, `tools`, `model`, `provider`, `input`). They stay
 * agent-local rather than promoted to `shared.ts` because their error messages
 * are phrased against the agent-node surface.
 */

import { isPlainObject, joinPath } from "../validation-helpers.js";
import type { SchemaIssue } from "./shared.js";

export function optionalString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: SchemaIssue[]
): string | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined;
  const v = obj[key];
  if (typeof v !== "string") {
    issues.push({
      path: joinPath(path, key),
      code: "MISSING_REQUIRED_FIELD",
      message: `${key} must be a string when present`,
    });
    return undefined;
  }
  return v;
}

export function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: SchemaIssue[]
): string[] | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined;
  const v = obj[key];
  if (Array.isArray(v) && v.every((x): x is string => typeof x === "string"))
    return v;
  issues.push({
    path: joinPath(path, key),
    code: "MISSING_REQUIRED_FIELD",
    message: `${key} must be an array of strings when present`,
  });
  return undefined;
}

export function optionalObject(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: SchemaIssue[]
): Record<string, unknown> | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined;
  const v = obj[key];
  if (isPlainObject(v)) return v;
  issues.push({
    path: joinPath(path, key),
    code: "MISSING_REQUIRED_FIELD",
    message: `${key} must be an object when present`,
  });
  return undefined;
}
