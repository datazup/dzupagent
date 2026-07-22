import { createHash } from "node:crypto";

/**
 * Shared sealing helpers and cross-receipt sub-types for the X4 fleet
 * qualification receipts.
 *
 * Rules (enforced across all fleet-qualification receipts):
 *  - No raw URLs, credentials, local paths, or command payloads in any receipt.
 *  - All receipts are sealed with SHA-256 of canonical JSON (excluding the seal field).
 *  - Schema versions follow the `datazup.<name>/v1` pattern.
 */

// ---------------------------------------------------------------------------
// Canonical JSON helpers (local copy — no shared dep)
// ---------------------------------------------------------------------------

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function sealFields(fields: Record<string, unknown>): string {
  return sha256Hex(stableJson(fields));
}

// ---------------------------------------------------------------------------
// Shared sub-types
// ---------------------------------------------------------------------------

/**
 * Sanitized egress audit entry for a single egress decision.
 * Contains no raw URLs, credentials, or request payloads.
 */
export interface FleetEgressAuditEntry {
  /** 'inbound' | 'outbound' */
  direction: "inbound" | "outbound";
  /** Stable execution-scoped ID. */
  executionId: string;
  /** Stable grant identifier from the ResourcePolicy. */
  grantId: string;
  /** Whether the egress was permitted. */
  allowed: boolean;
  /** Always true — confirms sanitization was applied. */
  sanitized: true;
}
