import type { SpddSwarmSubTask } from "../../types.js";
import {
  describeJsType,
  isPlainObject,
  joinPath,
} from "../../validation-helpers.js";
import type { SchemaIssue } from "../shared.js";

export function requireString(
  obj: Record<string, unknown>,
  path: string,
  field: string,
  nodeType: string,
  issues: SchemaIssue[]
): string | null {
  const value = obj[field];
  if (typeof value !== "string" || value.length === 0) {
    issues.push({
      path: joinPath(path, field),
      code: "MISSING_REQUIRED_FIELD",
      message: `${nodeType}.${field} is required (non-empty string), received ${describeJsType(
        value
      )}`,
    });
    return null;
  }
  return value;
}

export function requireSubTasks(
  obj: Record<string, unknown>,
  path: string,
  nodeType: string,
  issues: SchemaIssue[]
): SpddSwarmSubTask[] | null {
  const value = obj["subTasks"];
  if (!Array.isArray(value)) {
    issues.push({
      path: joinPath(path, "subTasks"),
      code: "MISSING_REQUIRED_FIELD",
      message: `${nodeType}.subTasks is required (array), received ${describeJsType(
        value
      )}`,
    });
    return null;
  }

  const subTasks: SpddSwarmSubTask[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    const itemPath = joinPath(joinPath(path, "subTasks"), String(index));
    if (!isPlainObject(item)) {
      issues.push({
        path: itemPath,
        code: "MISSING_REQUIRED_FIELD",
        message: `${nodeType}.subTasks items must be objects, received ${describeJsType(
          item
        )}`,
      });
      return null;
    }

    const role = requireString(item, itemPath, "role", nodeType, issues);
    if (role === null) return null;
    const personaRef =
      typeof item.personaRef === "string" ? item.personaRef : undefined;
    const input = isPlainObject(item.input)
      ? (item.input as Record<string, unknown>)
      : {};
    subTasks.push(
      personaRef === undefined ? { role, input } : { role, personaRef, input }
    );
  }

  return subTasks;
}

export function requireArray(
  obj: Record<string, unknown>,
  path: string,
  field: string,
  nodeType: string,
  issues: SchemaIssue[]
): unknown[] | null {
  const value = obj[field];
  if (!Array.isArray(value)) {
    issues.push({
      path: joinPath(path, field),
      code: "MISSING_REQUIRED_FIELD",
      message: `${nodeType}.${field} is required (array), received ${describeJsType(
        value
      )}`,
    });
    return null;
  }
  return value;
}
