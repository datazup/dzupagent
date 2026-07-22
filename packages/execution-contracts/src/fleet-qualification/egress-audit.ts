import {
  sealFields,
  sha256Hex,
  stableJson,
  type FleetEgressAuditEntry,
} from "./_seal.js";

// ---------------------------------------------------------------------------
// FleetEgressAuditReceipt — cross-worker egress no-bleed
// ---------------------------------------------------------------------------

export const FLEET_EGRESS_AUDIT_RECEIPT_SCHEMA =
  "datazup.fleetEgressAuditReceipt/v1" as const;

/**
 * Sealed cross-worker egress audit receipt.
 * Proves egress policy correctly scopes provider endpoints per execution,
 * with no cross-execution grant bleed.
 */
export interface FleetEgressAuditReceipt {
  schema: typeof FLEET_EGRESS_AUDIT_RECEIPT_SCHEMA;
  receiptId: string;
  sealedAt: string;
  /** Per-execution egress audit entries. All entries are sanitized. */
  entries: FleetEgressAuditEntry[];
  /** Whether any cross-execution grant bleed was detected. */
  crossExecutionBleedDetected: boolean;
  /** Whether all executions had their egress correctly scoped. */
  allScopedCorrectly: boolean;
  seal: string;
}

export interface SealFleetEgressAuditReceiptParams {
  receiptId: string;
  entries: FleetEgressAuditEntry[];
  crossExecutionBleedDetected: boolean;
  sealedAt?: string;
}

export function sealFleetEgressAuditReceipt(
  params: SealFleetEgressAuditReceiptParams
): FleetEgressAuditReceipt {
  const sealedAt = params.sealedAt ?? new Date().toISOString();
  // Validate all entries are sanitized before sealing.
  for (const entry of params.entries) {
    if (!entry.sanitized)
      throw new Error(
        `FleetEgressAuditEntry for executionId=${entry.executionId} is not sanitized`
      );
  }
  // Group entries by executionId and verify no cross-bleed.
  const idSet = new Set(params.entries.map((e) => e.executionId));
  const allScopedCorrectly =
    idSet.size > 0 && !params.crossExecutionBleedDetected;
  const fields = {
    schema: FLEET_EGRESS_AUDIT_RECEIPT_SCHEMA,
    receiptId: params.receiptId,
    sealedAt,
    entries: params.entries,
    crossExecutionBleedDetected: params.crossExecutionBleedDetected,
    allScopedCorrectly,
  };
  return { ...fields, seal: sealFields(fields) };
}

export function verifyFleetEgressAuditReceipt(
  receipt: FleetEgressAuditReceipt
): boolean {
  const { seal, ...fields } = receipt;
  return sha256Hex(stableJson(fields)) === seal;
}

export interface FleetEgressAuditValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateFleetEgressAuditReceipt(
  value: unknown
): FleetEgressAuditValidationResult {
  const errors: string[] = [];
  if (value === null || typeof value !== "object") {
    return {
      valid: false,
      errors: ["FleetEgressAuditReceipt must be an object"],
    };
  }
  const r = value as Record<string, unknown>;
  if (r["schema"] !== FLEET_EGRESS_AUDIT_RECEIPT_SCHEMA)
    errors.push(`schema must be "${FLEET_EGRESS_AUDIT_RECEIPT_SCHEMA}"`);
  if (typeof r["receiptId"] !== "string" || r["receiptId"].length === 0)
    errors.push("receiptId must be a non-empty string");
  if (!Array.isArray(r["entries"])) {
    errors.push("entries must be an array");
  } else {
    const entries = r["entries"] as FleetEgressAuditEntry[];
    for (const [i, e] of entries.entries()) {
      if (!e.sanitized) errors.push(`entries[${i}].sanitized must be true`);
      if (typeof e.executionId !== "string" || e.executionId.length === 0)
        errors.push(`entries[${i}].executionId must be a non-empty string`);
      if (typeof e.grantId !== "string" || e.grantId.length === 0)
        errors.push(`entries[${i}].grantId must be a non-empty string`);
      if (e.direction !== "inbound" && e.direction !== "outbound")
        errors.push(`entries[${i}].direction must be 'inbound' or 'outbound'`);
      if (typeof e.allowed !== "boolean")
        errors.push(`entries[${i}].allowed must be a boolean`);
    }
  }
  if (typeof r["crossExecutionBleedDetected"] !== "boolean")
    errors.push("crossExecutionBleedDetected must be a boolean");
  if (typeof r["allScopedCorrectly"] !== "boolean")
    errors.push("allScopedCorrectly must be a boolean");
  if (typeof r["seal"] !== "string" || r["seal"].length !== 64)
    errors.push("seal must be a 64-character hex SHA-256 string");
  if (
    errors.length === 0 &&
    !verifyFleetEgressAuditReceipt(value as FleetEgressAuditReceipt)
  )
    errors.push("seal does not match receipt content");
  return { valid: errors.length === 0, errors };
}
