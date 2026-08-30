import { canonicalInputDigest } from "../idempotency.js";
import type {
  ExecutionBoundaryIssue,
  ExecutionBoundaryIssueCode,
  ExecutionBoundarySha256Digest,
  ExecutionDefinitionOwnerV1,
  ExecutionStateAccessUnknownReasonV1,
} from "./types.js";

export const ACCESS_REASONS: readonly ExecutionStateAccessUnknownReasonV1[] = [
  "not-declared",
  "runtime-observation-unavailable",
  "observation-incomplete",
];

export function validateOwnDigest(
  value: Record<string, unknown>,
  digestKey: string,
  path: string,
  issues: ExecutionBoundaryIssue[],
): void {
  const actual = value[digestKey];
  if (!sha256(actual)) {
    issues.push(issue("INVALID_VALUE", path, "Identity must be a SHA-256 digest."));
    return;
  }
  try {
    const core = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== digestKey),
    );
    if (actual !== digest(core)) {
      issues.push(
        issue("DIGEST_MISMATCH", path, "Digest does not match canonical content."),
      );
    }
  } catch {
    issues.push(
      issue("DIGEST_MISMATCH", path, "Content cannot be canonically hashed."),
    );
  }
}

export function compareCanonical(
  left: unknown,
  right: unknown,
  path: string,
  message: string,
  issues: ExecutionBoundaryIssue[],
): void {
  try {
    if (canonicalInputDigest(left) !== canonicalInputDigest(right)) {
      issues.push(issue("BINDING_MISMATCH", path, message));
    }
  } catch {
    issues.push(issue("BINDING_MISMATCH", path, message));
  }
}

export function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ExecutionBoundaryIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      issues.push(
        issue("UNKNOWN_FIELD", `${path}.${key}`, "Field is outside the V1 schema."),
      );
    }
  }
}

export function copyOwner(owner: ExecutionDefinitionOwnerV1): ExecutionDefinitionOwnerV1 {
  return { ...owner };
}

export function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validStateKey(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/\s/u.test(value);
}

export function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function sha256(value: unknown): value is ExecutionBoundarySha256Digest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

export function isoInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function digest(value: unknown): ExecutionBoundarySha256Digest {
  return `sha256:${canonicalInputDigest(value)}`;
}

export function issue(
  code: ExecutionBoundaryIssueCode,
  path: string,
  message: string,
): ExecutionBoundaryIssue {
  return { code, path, message };
}

export function assertValid(
  prefix: string,
  issues: readonly ExecutionBoundaryIssue[],
): void {
  if (issues.length > 0) {
    throw new TypeError(
      `${prefix}: ${issues.map((item) => `${item.path} ${item.code}`).join(", ")}`,
    );
  }
}
