import { sealFields, sha256Hex, stableJson } from "./_seal.js";

// ---------------------------------------------------------------------------
// FleetCancellationReceipt — sibling cancellation isolation
// ---------------------------------------------------------------------------

export const FLEET_CANCELLATION_RECEIPT_SCHEMA =
  "datazup.fleetCancellationReceipt/v1" as const;

/**
 * Sanitized record proving that cancelling executionId did NOT affect siblings.
 *
 * Produced once per cancelled execution. The `siblingIds` list proves which
 * concurrent executions were observed to have continued running after the
 * cancellation of `cancelledExecutionId`.
 */
export interface FleetCancellationReceipt {
  schema: typeof FLEET_CANCELLATION_RECEIPT_SCHEMA;
  /** Stable ID for this receipt instance. */
  receiptId: string;
  /** ISO 8601 sealed-at timestamp. */
  sealedAt: string;
  /** The execution that was explicitly cancelled. */
  cancelledExecutionId: string;
  /** Executions that continued unaffected after the cancellation. */
  siblingIds: string[];
  /** Worker host identifier (opaque, no hostname or IP). */
  workerHostRef: string;
  /** Whether each sibling reached its natural completion after cancellation. */
  siblingsCompletedNaturally: boolean;
  /** SHA-256 of canonical fields (excluding the seal itself). */
  seal: string;
}

export interface SealFleetCancellationReceiptParams {
  receiptId: string;
  cancelledExecutionId: string;
  siblingIds: string[];
  workerHostRef: string;
  siblingsCompletedNaturally: boolean;
  sealedAt?: string;
}

export function sealFleetCancellationReceipt(
  params: SealFleetCancellationReceiptParams
): FleetCancellationReceipt {
  const sealedAt = params.sealedAt ?? new Date().toISOString();
  const fields = {
    schema: FLEET_CANCELLATION_RECEIPT_SCHEMA,
    receiptId: params.receiptId,
    sealedAt,
    cancelledExecutionId: params.cancelledExecutionId,
    siblingIds: params.siblingIds,
    workerHostRef: params.workerHostRef,
    siblingsCompletedNaturally: params.siblingsCompletedNaturally,
  };
  return { ...fields, seal: sealFields(fields) };
}

export function verifyFleetCancellationReceipt(
  receipt: FleetCancellationReceipt
): boolean {
  const { seal, ...fields } = receipt;
  return sha256Hex(stableJson(fields)) === seal;
}

export interface FleetCancellationValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateFleetCancellationReceipt(
  value: unknown
): FleetCancellationValidationResult {
  const errors: string[] = [];
  if (value === null || typeof value !== "object") {
    return {
      valid: false,
      errors: ["FleetCancellationReceipt must be an object"],
    };
  }
  const r = value as Record<string, unknown>;
  if (r["schema"] !== FLEET_CANCELLATION_RECEIPT_SCHEMA)
    errors.push(`schema must be "${FLEET_CANCELLATION_RECEIPT_SCHEMA}"`);
  if (typeof r["receiptId"] !== "string" || r["receiptId"].length === 0)
    errors.push("receiptId must be a non-empty string");
  if (
    typeof r["cancelledExecutionId"] !== "string" ||
    r["cancelledExecutionId"].length === 0
  )
    errors.push("cancelledExecutionId must be a non-empty string");
  if (
    !Array.isArray(r["siblingIds"]) ||
    (r["siblingIds"] as unknown[]).length === 0
  )
    errors.push("siblingIds must be a non-empty array");
  if (typeof r["workerHostRef"] !== "string" || r["workerHostRef"].length === 0)
    errors.push("workerHostRef must be a non-empty string");
  if (typeof r["siblingsCompletedNaturally"] !== "boolean")
    errors.push("siblingsCompletedNaturally must be a boolean");
  if (typeof r["seal"] !== "string" || r["seal"].length !== 64)
    errors.push("seal must be a 64-character hex SHA-256 string");
  if (
    errors.length === 0 &&
    !verifyFleetCancellationReceipt(value as FleetCancellationReceipt)
  )
    errors.push("seal does not match receipt content");
  return { valid: errors.length === 0, errors };
}
