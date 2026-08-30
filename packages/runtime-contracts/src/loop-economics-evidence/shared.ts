import { canonicalInputDigest } from "../idempotency.js";
import type {
  LoopEconomicsEvidenceDiagnostic,
  LoopEconomicsEvidenceDiagnosticCode,
  LoopEconomicsEvidenceInput,
  LoopEconomicsEvidenceV1,
  LoopEconomicsEvidenceValidation,
  Sha256Digest,
} from "./types.js";

export function reservationCore(value: LoopEconomicsEvidenceInput | LoopEconomicsEvidenceV1) {
  return {
    schema: value.schema,
    canonicalization: value.canonicalization,
    owner: value.owner,
    executions: value.executions,
    effectIntents: value.effectIntents,
  };
}

export function sumPricedReservations(executions: readonly unknown[]): number | undefined {
  let total = 0;
  for (const execution of executions) {
    if (!record(execution) || !record(execution.money) || execution.money.status !== "priced" || !record(execution.money.reservation)) {
      return undefined;
    }
    const amount = execution.money.reservation.reservedAmountMicros;
    if (!nonNegativeSafeInteger(amount)) return undefined;
    total += amount;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

export function sumTerminalCosts(terminal: unknown): number | undefined {
  if (!record(terminal) || terminal.status !== "recorded" || !Array.isArray(terminal.executions)) return undefined;
  let total = 0;
  for (const execution of terminal.executions) {
    if (!record(execution) || !record(execution.usage) || !record(execution.usage.cost) || execution.usage.cost.status === "unknown") {
      return undefined;
    }
    const amount = execution.usage.cost.amountMicros;
    if (!nonNegativeSafeInteger(amount)) return undefined;
    total += amount;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

export function validateSortedUniqueNodes(
  values: readonly unknown[],
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  let previous: string | undefined;
  values.forEach((value, index) => {
    const nodeId = record(value) && nonEmptyString(value.nodeId)
      ? value.nodeId
      : undefined;
    if (nodeId === undefined) return;
    if (previous !== undefined && nodeId <= previous) {
      add(diagnostics, "LOOP_ECONOMICS_INVALID", `${path}[${index}].nodeId`, "Node bindings must be unique and sorted by nodeId.");
    }
    previous = nodeId;
  });
}

export function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      add(diagnostics, "LOOP_ECONOMICS_INVALID", `${path}.${key}`, "Unknown evidence field is not admitted.");
    }
  }
}

export function add(
  diagnostics: LoopEconomicsEvidenceDiagnostic[],
  code: LoopEconomicsEvidenceDiagnosticCode,
  path: string,
  message: string
): void {
  diagnostics.push({ code, path, message });
}

export function invalid(path: string, message: string): LoopEconomicsEvidenceValidation {
  return {
    valid: false,
    diagnostics: [{ code: "LOOP_ECONOMICS_INVALID", path, message }],
  };
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
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  if (!nonEmptyString(value)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", path, "Field must be non-empty.");
  }
}

export function sha(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(typeof value === "string" ? value : "")) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", path, "Field must be a lowercase SHA-256 digest.");
  }
}

export function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function positiveSafeIntegerValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function nonNegativeSafeIntegerField(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  if (!nonNegativeSafeInteger(value)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", path, "Field must be a non-negative safe integer.");
  }
}

export function positiveSafeInteger(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  if (!positiveSafeIntegerValue(value)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", path, "Field must be a positive safe integer.");
  }
}

export function iso(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function digest(value: unknown): Sha256Digest {
  return `sha256:${canonicalInputDigest(value)}`;
}

export function safeDigest(value: unknown): Sha256Digest | undefined {
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
