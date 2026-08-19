import { canonicalInputDigest } from "../idempotency.js";
import type {
  LoopEconomicsEvidenceDiagnosticCodeV2,
  LoopEconomicsEvidenceDiagnosticV2,
  LoopEconomicsEvidenceValidationV2,
  LoopEconomicsSha256DigestV2,
} from "./types.js";

export function compareExpected(
  actual: unknown,
  expected: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (expected !== undefined && actual !== expected) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", path, "Evidence differs from current host authority.");
  }
}

export function mapV1Code(code: string): LoopEconomicsEvidenceDiagnosticCodeV2 {
  if (code.endsWith("COST_MISMATCH")) return "LOOP_ECONOMICS_V2_COST_MISMATCH";
  if (code.endsWith("OWNER_MISMATCH")) return "LOOP_ECONOMICS_V2_OWNER_MISMATCH";
  if (code.endsWith("BINDING_MISMATCH")) return "LOOP_ECONOMICS_V2_BINDING_MISMATCH";
  return "LOOP_ECONOMICS_V2_INVALID";
}

export function validation(
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[],
  resolutionStatus: LoopEconomicsEvidenceValidationV2["resolutionStatus"]
): LoopEconomicsEvidenceValidationV2 {
  const valid = diagnostics.length === 0;
  return {
    valid,
    terminalSuccess: valid && resolutionStatus === "settled",
    requiresReconciliation: valid && resolutionStatus === "reconciliation-required",
    resolutionStatus,
    diagnostics,
  };
}

export function invalid(
  path: string,
  message: string
): LoopEconomicsEvidenceValidationV2 {
  return validation(
    [{ code: "LOOP_ECONOMICS_V2_INVALID", path, message }],
    "invalid"
  );
}

export function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.${key}`, "Unknown V2 evidence field is not admitted.");
    }
  }
}

export function add(
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[],
  code: LoopEconomicsEvidenceDiagnosticCodeV2,
  path: string,
  message: string
): void {
  diagnostics.push({ code, path, message });
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function nonEmpty(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!nonEmptyString(value)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Field must be non-empty.");
  }
}

export function sha(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(typeof value === "string" ? value : "")) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Field must be a lowercase SHA-256 digest.");
  }
}

export function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function nonNegativeSafeIntegerField(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!nonNegativeSafeInteger(value)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Field must be a non-negative safe integer.");
  }
}

export function positiveSafeIntegerField(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!positiveSafeInteger(value)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Field must be a positive safe integer.");
  }
}

export function digest(value: unknown): LoopEconomicsSha256DigestV2 {
  return `sha256:${canonicalInputDigest(value)}`;
}

export function safeDigest(
  value: unknown
): LoopEconomicsSha256DigestV2 | undefined {
  try {
    return digest(value);
  } catch {
    return undefined;
  }
}

export function canonicalEqual(left: unknown, right: unknown): boolean {
  const leftDigest = safeDigest(left);
  return leftDigest !== undefined && leftDigest === safeDigest(right);
}

export function containsCycle(value: unknown): boolean {
  const active = new WeakSet<object>();
  const visited = new WeakSet<object>();
  const visit = (candidate: unknown): boolean => {
    if (typeof candidate !== "object" || candidate === null) return false;
    if (active.has(candidate)) return true;
    if (visited.has(candidate)) return false;
    active.add(candidate);
    const children = Array.isArray(candidate)
      ? candidate
      : Object.values(candidate);
    for (const child of children) {
      if (visit(child)) return true;
    }
    active.delete(candidate);
    visited.add(candidate);
    return false;
  };
  return visit(value);
}
