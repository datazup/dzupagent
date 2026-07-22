import { sealFields, sha256Hex, stableJson } from "./_seal.js";

// ---------------------------------------------------------------------------
// FleetTakeoverReceipt — worker restart / fencing-token attribution
// ---------------------------------------------------------------------------

export const FLEET_TAKEOVER_RECEIPT_SCHEMA =
  "datazup.fleetTakeoverReceipt/v1" as const;

/**
 * Sanitized record proving in-flight executions were correctly attributed
 * to the new worker's fencing token, and the old token was rejected.
 *
 * Fencing tokens are opaque short identifiers — no hostnames or credentials.
 */
export interface FleetTakeoverReceipt {
  schema: typeof FLEET_TAKEOVER_RECEIPT_SCHEMA;
  receiptId: string;
  sealedAt: string;
  /** Execution IDs that were in-flight during the restart. */
  takenOverExecutionIds: string[];
  /** Opaque old fencing token (no hostname, IP, or credential). */
  oldFencingToken: string;
  /** Opaque new fencing token. */
  newFencingToken: string;
  /** Whether the old token was correctly rejected after restart. */
  oldTokenRejected: boolean;
  /** Whether all in-flight executions were re-attributed to the new token. */
  attributionCorrect: boolean;
  seal: string;
}

export interface SealFleetTakeoverReceiptParams {
  receiptId: string;
  takenOverExecutionIds: string[];
  oldFencingToken: string;
  newFencingToken: string;
  oldTokenRejected: boolean;
  attributionCorrect: boolean;
  sealedAt?: string;
}

export function sealFleetTakeoverReceipt(
  params: SealFleetTakeoverReceiptParams
): FleetTakeoverReceipt {
  const sealedAt = params.sealedAt ?? new Date().toISOString();
  const fields = {
    schema: FLEET_TAKEOVER_RECEIPT_SCHEMA,
    receiptId: params.receiptId,
    sealedAt,
    takenOverExecutionIds: params.takenOverExecutionIds,
    oldFencingToken: params.oldFencingToken,
    newFencingToken: params.newFencingToken,
    oldTokenRejected: params.oldTokenRejected,
    attributionCorrect: params.attributionCorrect,
  };
  return { ...fields, seal: sealFields(fields) };
}

export function verifyFleetTakeoverReceipt(
  receipt: FleetTakeoverReceipt
): boolean {
  const { seal, ...fields } = receipt;
  return sha256Hex(stableJson(fields)) === seal;
}

export interface FleetTakeoverValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateFleetTakeoverReceipt(
  value: unknown
): FleetTakeoverValidationResult {
  const errors: string[] = [];
  if (value === null || typeof value !== "object") {
    return { valid: false, errors: ["FleetTakeoverReceipt must be an object"] };
  }
  const r = value as Record<string, unknown>;
  if (r["schema"] !== FLEET_TAKEOVER_RECEIPT_SCHEMA)
    errors.push(`schema must be "${FLEET_TAKEOVER_RECEIPT_SCHEMA}"`);
  if (typeof r["receiptId"] !== "string" || r["receiptId"].length === 0)
    errors.push("receiptId must be a non-empty string");
  if (
    !Array.isArray(r["takenOverExecutionIds"]) ||
    (r["takenOverExecutionIds"] as unknown[]).length === 0
  )
    errors.push("takenOverExecutionIds must be a non-empty array");
  if (
    typeof r["oldFencingToken"] !== "string" ||
    r["oldFencingToken"].length === 0
  )
    errors.push("oldFencingToken must be a non-empty string");
  if (
    typeof r["newFencingToken"] !== "string" ||
    r["newFencingToken"].length === 0
  )
    errors.push("newFencingToken must be a non-empty string");
  if (r["oldFencingToken"] === r["newFencingToken"])
    errors.push("oldFencingToken and newFencingToken must differ");
  if (typeof r["oldTokenRejected"] !== "boolean")
    errors.push("oldTokenRejected must be a boolean");
  if (typeof r["attributionCorrect"] !== "boolean")
    errors.push("attributionCorrect must be a boolean");
  if (typeof r["seal"] !== "string" || r["seal"].length !== 64)
    errors.push("seal must be a 64-character hex SHA-256 string");
  if (
    errors.length === 0 &&
    !verifyFleetTakeoverReceipt(value as FleetTakeoverReceipt)
  )
    errors.push("seal does not match receipt content");
  return { valid: errors.length === 0, errors };
}
