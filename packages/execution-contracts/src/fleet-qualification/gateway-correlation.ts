import { sealFields } from "./_seal.js";

// ---------------------------------------------------------------------------
// FleetGatewayCorrelationReceipt — migrated-API / Gateway egress correlation
// ---------------------------------------------------------------------------

export const FLEET_GATEWAY_CORRELATION_RECEIPT_SCHEMA =
  "datazup.fleetGatewayCorrelationReceipt/v1" as const;

/**
 * Sanitized evidence that Gateway egress was correctly correlated to an execution.
 * Produced once per execution's Gateway egress pass or migrated-API qualification run.
 * Never contains raw tokens, URLs, paths, credentials, or command arguments.
 */
export interface FleetGatewayCorrelationReceipt {
  schema: typeof FLEET_GATEWAY_CORRELATION_RECEIPT_SCHEMA;
  receiptId: string;
  sealedAt: string;
  /** Stable execution identity. */
  executionId: string;
  /** Worker instance identity. */
  workerId: string;
  /** Execution family that was rollout-gated (e.g. "codev-assistant"). */
  executionFamily: string;
  /**
   * Which correlation cases were verified. Use known values:
   * "success" | "missing-correlation" | "mismatched-fence" | "revoked" |
   * "post-terminal" | "replay-rejected" | "takeover-fence-enforced" |
   * "cleanup-digest-linked"
   */
  verifiedCases: string[];
  /** True when this is a provider-free (no live provider) qualification. */
  providerFree: boolean;
  /** True when this receipt was produced from a migrated-API lane. */
  migratedApi: boolean;
  /** SHA-256 seal of all fields above (excluding this field). */
  seal: string;
}

export function sealFleetGatewayCorrelationReceipt(params: {
  receiptId: string;
  sealedAt?: string;
  executionId: string;
  workerId: string;
  executionFamily: string;
  verifiedCases: string[];
  providerFree: boolean;
  migratedApi: boolean;
}): FleetGatewayCorrelationReceipt {
  const sealedAt = params.sealedAt ?? new Date().toISOString();
  const fields = {
    schema: FLEET_GATEWAY_CORRELATION_RECEIPT_SCHEMA,
    receiptId: params.receiptId,
    sealedAt,
    executionId: params.executionId,
    workerId: params.workerId,
    executionFamily: params.executionFamily,
    verifiedCases: params.verifiedCases,
    providerFree: params.providerFree,
    migratedApi: params.migratedApi,
  };
  return { ...fields, seal: sealFields(fields) };
}

export function verifyFleetGatewayCorrelationReceipt(
  receipt: FleetGatewayCorrelationReceipt
): boolean {
  const { seal, ...fields } = receipt;
  return sealFields(fields as Record<string, unknown>) === seal;
}
