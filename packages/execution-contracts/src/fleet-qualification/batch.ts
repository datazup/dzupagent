import { sealFields, sha256Hex, stableJson } from "./_seal.js";

// ---------------------------------------------------------------------------
// FleetBatchReport — concurrent execution batch
// ---------------------------------------------------------------------------

export const FLEET_BATCH_REPORT_SCHEMA = "datazup.fleetBatchReport/v1" as const;

/** Per-execution summary within a batch report. */
export interface FleetBatchExecutionEntry {
  executionId: string;
  /** 'codex' | 'claude' — provider label only, no model version or API key. */
  provider: string;
  /** Whether isolation receipt is present and verified for this execution. */
  isolationReceiptVerified: boolean;
  /** Whether the execution completed without error. */
  completedWithoutError: boolean;
}

/**
 * Sealed batch report covering ≥2 concurrent executions per provider.
 * Proves attribution, isolation enforcement, and cleanup across the batch.
 */
export interface FleetBatchReport {
  schema: typeof FLEET_BATCH_REPORT_SCHEMA;
  receiptId: string;
  sealedAt: string;
  /** All executions in this batch, keyed by executionId. */
  executions: FleetBatchExecutionEntry[];
  /** Provider labels observed in this batch. */
  providersObserved: string[];
  /** Whether all executions passed isolation receipt verification. */
  allIsolationReceiptsVerified: boolean;
  /** Whether post-batch cleanup completed without leaving artifacts. */
  cleanupVerified: boolean;
  seal: string;
}

export interface SealFleetBatchReportParams {
  receiptId: string;
  executions: FleetBatchExecutionEntry[];
  cleanupVerified: boolean;
  sealedAt?: string;
}

/** Minimum concurrent executions per provider required for a valid batch. */
export const FLEET_BATCH_MIN_EXECUTIONS_PER_PROVIDER = 2;

export function sealFleetBatchReport(
  params: SealFleetBatchReportParams
): FleetBatchReport {
  const sealedAt = params.sealedAt ?? new Date().toISOString();
  const providersObserved = [
    ...new Set(params.executions.map((e) => e.provider)),
  ].sort();
  const allIsolationReceiptsVerified = params.executions.every(
    (e) => e.isolationReceiptVerified
  );
  const fields = {
    schema: FLEET_BATCH_REPORT_SCHEMA,
    receiptId: params.receiptId,
    sealedAt,
    executions: params.executions,
    providersObserved,
    allIsolationReceiptsVerified,
    cleanupVerified: params.cleanupVerified,
  };
  return { ...fields, seal: sealFields(fields) };
}

export function verifyFleetBatchReport(report: FleetBatchReport): boolean {
  const { seal, ...fields } = report;
  return sha256Hex(stableJson(fields)) === seal;
}

export interface FleetBatchValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateFleetBatchReport(
  value: unknown
): FleetBatchValidationResult {
  const errors: string[] = [];
  if (value === null || typeof value !== "object") {
    return { valid: false, errors: ["FleetBatchReport must be an object"] };
  }
  const r = value as Record<string, unknown>;
  if (r["schema"] !== FLEET_BATCH_REPORT_SCHEMA)
    errors.push(`schema must be "${FLEET_BATCH_REPORT_SCHEMA}"`);
  if (typeof r["receiptId"] !== "string" || r["receiptId"].length === 0)
    errors.push("receiptId must be a non-empty string");
  if (!Array.isArray(r["executions"])) {
    errors.push("executions must be an array");
  } else {
    const execs = r["executions"] as FleetBatchExecutionEntry[];
    // Must have at least FLEET_BATCH_MIN_EXECUTIONS_PER_PROVIDER per provider.
    const countByProvider = new Map<string, number>();
    for (const e of execs) {
      countByProvider.set(
        e.provider,
        (countByProvider.get(e.provider) ?? 0) + 1
      );
    }
    for (const [provider, count] of countByProvider) {
      if (count < FLEET_BATCH_MIN_EXECUTIONS_PER_PROVIDER) {
        errors.push(
          `provider "${provider}" has only ${count} execution(s); need >= ${FLEET_BATCH_MIN_EXECUTIONS_PER_PROVIDER}`
        );
      }
    }
    if (execs.length === 0) errors.push("executions must not be empty");
  }
  if (typeof r["cleanupVerified"] !== "boolean")
    errors.push("cleanupVerified must be a boolean");
  if (typeof r["seal"] !== "string" || r["seal"].length !== 64)
    errors.push("seal must be a 64-character hex SHA-256 string");
  if (errors.length === 0 && !verifyFleetBatchReport(value as FleetBatchReport))
    errors.push("seal does not match report content");
  return { valid: errors.length === 0, errors };
}
