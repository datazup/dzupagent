import { type FlowCapabilityOwner } from "../capability-manifest.js";

import {
  type FlowProfileDiagnostic,
  type FlowProfileDiagnosticCode,
  type FlowProfileValidationResult,
} from "./types.js";

export const PROFILE_NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
export const PROFILE_REF_PATTERN =
  /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)@([1-9][0-9]*)$/;
/* eslint-disable security/detect-unsafe-regex */
// Anchored, fully-separated groups (each `.`/`-` separator is mandatory, so
// the nested quantifier has no ambiguous overlap) — linear-time, no ReDoS.
// The detect-unsafe-regex heuristic over-flags the standard semver pattern.
export const EXACT_SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
/* eslint-enable security/detect-unsafe-regex */
export const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function parseProfileRef(
  ref: string
): { namespace: string; name: string; major: number } | null {
  const match = PROFILE_REF_PATTERN.exec(ref);
  return match && match[1] && match[2] && match[3]
    ? { namespace: match[1], name: match[2], major: Number(match[3]) }
    : null;
}

export function parseExactSemver(version: string): { major: number } | null {
  const match = EXACT_SEMVER_PATTERN.exec(version);
  return match && match[1] ? { major: Number(match[1]) } : null;
}

export function addDuplicateDiagnostics(
  values: unknown[],
  path: string,
  code: "DUPLICATE_NODE_KIND" | "DUPLICATE_CAPABILITY" | "DUPLICATE_DEPENDENCY",
  diagnostics: FlowProfileDiagnostic[]
): void {
  const seen = new Set<unknown>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      diagnostics.push(
        diag(code, `${path}[${index}]`, `Duplicate value: ${String(value)}`)
      );
    }
    seen.add(value);
  });
}

export function isFlowCapabilityOwner(
  value: unknown
): value is FlowCapabilityOwner {
  return value === "dzupagent" || value === "host" || value === "codev";
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)])
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function diag(
  code: FlowProfileDiagnosticCode,
  path: string,
  message: string
): FlowProfileDiagnostic {
  return { code, path, message };
}

export function invalid(
  code: FlowProfileDiagnosticCode,
  path: string,
  message: string
): FlowProfileValidationResult {
  return { valid: false, diagnostics: [diag(code, path, message)] };
}
