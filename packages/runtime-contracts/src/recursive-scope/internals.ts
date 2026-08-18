import {
  CANONICAL_JSON_VERSION,
  canonicalInputDigest,
  canonicalJson,
} from "../idempotency.js";
import type {
  RecursiveScopeContractIssue,
  RecursiveScopeContractIssueCode,
  RecursiveScopedJsonValue,
  RecursiveScopedSha256Digest,
} from "./types.js";

export { CANONICAL_JSON_VERSION, canonicalJson };

export function digest(value: unknown): RecursiveScopedSha256Digest {
  return `sha256:${canonicalInputDigest(value)}`;
}

export function safeDigest(value: unknown): RecursiveScopedSha256Digest | undefined {
  try {
    return digest(value);
  } catch {
    return undefined;
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function sha256(value: unknown): value is RecursiveScopedSha256Digest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

export function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

export function jsonValue(value: unknown, seen = new Set<object>()): value is RecursiveScopedJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => jsonValue(entry, seen))
    : Object.values(value as Record<string, unknown>).every((entry) =>
        jsonValue(entry, seen),
      );
  seen.delete(value);
  return valid;
}

export function issue(
  issues: RecursiveScopeContractIssue[],
  path: string,
  code: RecursiveScopeContractIssueCode,
  message: string,
): void {
  issues.push({ code, path, message });
}

export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  issues: RecursiveScopeContractIssue[],
): void {
  const expected = new Set(keys);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      issue(issues, `${path}.${key}`, "MISSING_FIELD", "Required field is missing.");
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      issue(issues, `${path}.${key}`, "UNKNOWN_FIELD", "Unknown field is not allowed.");
    }
  }
}

export function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

export function sortedRecord<T>(
  value: Readonly<Record<string, T>> | undefined,
): Readonly<Record<string, T>> {
  return Object.fromEntries(
    Object.entries(value ?? {}).sort(([left], [right]) => compareText(left, right)),
  );
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
