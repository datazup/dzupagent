/**
 * Per-value admission for flow runtime input: the credential handle reference
 * reader and the recursive JSON value walker.
 *
 * Extracted from `flow-runtime-input.ts` (RF-03 pin exit). Neither function
 * calls back into `validateFlowRuntimeInput`, which is what makes this a clean
 * layer rather than a cycle.
 */

import {
  CREDENTIAL_KEYS,
  boundedString,
  describeType,
  invalidKeyIssue,
  isRfc3339DateTime,
  issue,
  plainRecord,
  utf8Bytes,
  validJsonObjectKey,
} from "./flow-runtime-input-values.js";
import { FLOW_CREDENTIAL_HANDLE_REF_SCHEMA } from "./flow-runtime-input-contracts.js";
import type {
  FlowRuntimeCredentialHandleRef,
  FlowRuntimeInputIssue,
  FlowRuntimeInputLimits,
  FlowRuntimeJsonValue,
} from "./flow-runtime-input-contracts.js";

export function validateCredentialHandle(
  value: unknown,
  path: string,
  issues: FlowRuntimeInputIssue[],
): FlowRuntimeCredentialHandleRef | undefined {
  const local: string[] = [];
  if (!plainRecord(value)) {
    local.push("must be an object");
  } else {
    const extras = Object.keys(value).filter((key) => !CREDENTIAL_KEYS.has(key));
    if (extras.length > 0) local.push(`contains unsupported fields: ${extras.sort().join(", ")}`);
    if (value.schema !== FLOW_CREDENTIAL_HANDLE_REF_SCHEMA) {
      local.push(`schema must be ${FLOW_CREDENTIAL_HANDLE_REF_SCHEMA}`);
    }
    boundedString(value.handleId, "handleId", 200, local);
    boundedString(value.bindingRef, "bindingRef", 500, local);
    if (typeof value.bindingRef === "string" && !value.bindingRef.startsWith("binding://")) {
      local.push("bindingRef must be a binding URI");
    }
    boundedString(value.capabilityRef, "capabilityRef", 200, local);
    if (value.provider !== undefined) boundedString(value.provider, "provider", 120, local);
    if (!Array.isArray(value.scopes) || value.scopes.length > 64) {
      local.push("scopes must be an array with at most 64 entries");
    } else {
      const scopeValues = value.scopes;
      for (const scope of scopeValues) boundedString(scope, "scope", 160, local);
      if (new Set(scopeValues).size !== scopeValues.length) local.push("scopes cannot contain duplicates");
    }
    if (value.expiresAt !== undefined) {
      boundedString(value.expiresAt, "expiresAt", 40, local);
      if (
        typeof value.expiresAt === "string" &&
        !isRfc3339DateTime(value.expiresAt)
      ) {
        local.push("expiresAt must be an RFC 3339 date-time when present");
      }
    }
  }

  if (local.length > 0) {
    issues.push(
      issue(
        "FLOW_INPUT_CREDENTIAL_HANDLE_INVALID",
        path,
        `Credential handle reference is invalid: ${local.join("; ")}.`,
      ),
    );
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    schema: FLOW_CREDENTIAL_HANDLE_REF_SCHEMA,
    handleId: record.handleId as string,
    bindingRef: record.bindingRef as string,
    capabilityRef: record.capabilityRef as string,
    ...(record.provider === undefined
      ? {}
      : { provider: record.provider as string }),
    scopes: [...(record.scopes as string[])].sort(),
    ...(record.expiresAt === undefined
      ? {}
      : { expiresAt: record.expiresAt as string }),
  };
}

export function validateJsonValue(
  value: unknown,
  path: string,
  limits: FlowRuntimeInputLimits,
  issues: FlowRuntimeInputIssue[],
  valueCounter: { total: number },
): value is FlowRuntimeJsonValue {
  const ancestors = new WeakSet<object>();

  const visit = (current: unknown, currentPath: string, depth: number): boolean => {
    valueCounter.total += 1;
    if (valueCounter.total > limits.maxTotalValues) {
      issues.push(
        issue(
          "FLOW_INPUT_MAX_TOTAL_VALUES",
          currentPath,
          `Input exceeds the ${limits.maxTotalValues} value limit.`,
        ),
      );
      return false;
    }
    if (depth > limits.maxDepth) {
      issues.push(
        issue(
          "FLOW_INPUT_MAX_DEPTH",
          currentPath,
          `Input exceeds the maximum depth of ${limits.maxDepth}.`,
        ),
      );
      return false;
    }
    if (current === null || typeof current === "boolean") return true;
    if (typeof current === "number") {
      if (Number.isFinite(current)) return true;
      issues.push(issue("FLOW_INPUT_VALUE_INVALID", currentPath, "Numbers must be finite."));
      return false;
    }
    if (typeof current === "string") {
      const bytes = utf8Bytes(current);
      if (bytes <= limits.maxStringBytes) return true;
      issues.push(
        issue(
          "FLOW_INPUT_MAX_STRING_BYTES",
          currentPath,
          `String is ${bytes} bytes; the per-string limit is ${limits.maxStringBytes}.`,
        ),
      );
      return false;
    }
    if (typeof current !== "object") {
      issues.push(
        issue(
          "FLOW_INPUT_VALUE_INVALID",
          currentPath,
          `Input values must be JSON; received ${describeType(current)}.`,
        ),
      );
      return false;
    }
    if (ancestors.has(current)) {
      issues.push(issue("FLOW_INPUT_VALUE_INVALID", currentPath, "Input values cannot be cyclic."));
      return false;
    }
    ancestors.add(current);
    let valid = true;
    if (Array.isArray(current)) {
      if (current.length > limits.maxArrayItems) {
        issues.push(
          issue(
            "FLOW_INPUT_MAX_ARRAY_ITEMS",
            currentPath,
            `Array has ${current.length} items; the limit is ${limits.maxArrayItems}.`,
          ),
        );
        valid = false;
      } else {
        for (let index = 0; index < current.length; index += 1) {
          valid = visit(current[index], `${currentPath}[${index}]`, depth + 1) && valid;
        }
      }
    } else if (!plainRecord(current)) {
      issues.push(issue("FLOW_INPUT_VALUE_INVALID", currentPath, "Objects must be plain JSON objects."));
      valid = false;
    } else {
      const keys = Object.keys(current);
      if (keys.length > limits.maxObjectKeys) {
        issues.push(
          issue(
            "FLOW_INPUT_MAX_OBJECT_KEYS",
            currentPath,
            `Object has ${keys.length} keys; the limit is ${limits.maxObjectKeys}.`,
          ),
        );
        valid = false;
      } else {
        for (const key of keys.sort()) {
          if (!validJsonObjectKey(key)) {
            issues.push(invalidKeyIssue(`${currentPath}.${key}`, key));
            valid = false;
            continue;
          }
          valid = visit(current[key], `${currentPath}.${key}`, depth + 1) && valid;
        }
      }
    }
    ancestors.delete(current);
    return valid;
  };

  return visit(value, path, 0);
}

