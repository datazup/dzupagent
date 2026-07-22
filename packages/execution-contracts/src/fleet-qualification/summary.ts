import { sealFields, sha256Hex, stableJson } from "./_seal.js";

// ---------------------------------------------------------------------------
// FleetQualificationSummary — top-level digest chain
// ---------------------------------------------------------------------------

export const FLEET_QUALIFICATION_SUMMARY_SCHEMA =
  "datazup.fleetQualificationSummary/v1" as const;

/** Reference to an individual receipt by digest. */
export interface FleetReceiptRef {
  /** Human-readable label for the receipt type. */
  label: string;
  /** sha256:<hex> digest of the receipt's canonical JSON. */
  digest: string;
  /** Schema version string of the referenced receipt. */
  schema: string;
}

/**
 * Top-level fleet qualification summary receipt.
 * References all individual receipts by digest, forming a digest chain.
 * All sub-receipts must be present and their digests must be verifiable.
 */
export interface FleetQualificationSummary {
  schema: typeof FLEET_QUALIFICATION_SUMMARY_SCHEMA;
  receiptId: string;
  sealedAt: string;
  /** Reference to the X3 browser receipt that gates X4. */
  x3BrowserReceiptRef: FleetReceiptRef;
  cancellationReceipts: FleetReceiptRef[];
  takeoverReceipts: FleetReceiptRef[];
  batchReportRef: FleetReceiptRef;
  egressAuditRef: FleetReceiptRef;
  /** Overall pass/fail verdict. */
  verdict: "passed" | "failed";
  /** SHA-256 of canonical fields (excluding the seal itself). */
  seal: string;
}

export interface SealFleetQualificationSummaryParams {
  receiptId: string;
  x3BrowserReceiptRef: FleetReceiptRef;
  cancellationReceipts: FleetReceiptRef[];
  takeoverReceipts: FleetReceiptRef[];
  batchReportRef: FleetReceiptRef;
  egressAuditRef: FleetReceiptRef;
  verdict: "passed" | "failed";
  sealedAt?: string;
}

export function sealFleetQualificationSummary(
  params: SealFleetQualificationSummaryParams
): FleetQualificationSummary {
  const sealedAt = params.sealedAt ?? new Date().toISOString();
  const fields = {
    schema: FLEET_QUALIFICATION_SUMMARY_SCHEMA,
    receiptId: params.receiptId,
    sealedAt,
    x3BrowserReceiptRef: params.x3BrowserReceiptRef,
    cancellationReceipts: params.cancellationReceipts,
    takeoverReceipts: params.takeoverReceipts,
    batchReportRef: params.batchReportRef,
    egressAuditRef: params.egressAuditRef,
    verdict: params.verdict,
  };
  return { ...fields, seal: sealFields(fields) };
}

export function verifyFleetQualificationSummary(
  summary: FleetQualificationSummary
): boolean {
  const { seal, ...fields } = summary;
  return sha256Hex(stableJson(fields)) === seal;
}

export interface FleetQualificationSummaryValidationResult {
  valid: boolean;
  errors: string[];
}

/** Compute a `sha256:<hex>` digest from any serialisable object. */
export function computeReceiptDigest(receiptJson: string): string {
  return `sha256:${sha256Hex(receiptJson)}`;
}

export function validateFleetQualificationSummary(
  value: unknown
): FleetQualificationSummaryValidationResult {
  const errors: string[] = [];
  if (value === null || typeof value !== "object") {
    return {
      valid: false,
      errors: ["FleetQualificationSummary must be an object"],
    };
  }
  const r = value as Record<string, unknown>;
  if (r["schema"] !== FLEET_QUALIFICATION_SUMMARY_SCHEMA)
    errors.push(`schema must be "${FLEET_QUALIFICATION_SUMMARY_SCHEMA}"`);
  if (typeof r["receiptId"] !== "string" || r["receiptId"].length === 0)
    errors.push("receiptId must be a non-empty string");
  if (
    r["x3BrowserReceiptRef"] === null ||
    typeof r["x3BrowserReceiptRef"] !== "object"
  )
    errors.push("x3BrowserReceiptRef must be an object");
  if (
    !Array.isArray(r["cancellationReceipts"]) ||
    (r["cancellationReceipts"] as unknown[]).length === 0
  )
    errors.push("cancellationReceipts must be a non-empty array");
  if (
    !Array.isArray(r["takeoverReceipts"]) ||
    (r["takeoverReceipts"] as unknown[]).length === 0
  )
    errors.push("takeoverReceipts must be a non-empty array");
  if (r["batchReportRef"] === null || typeof r["batchReportRef"] !== "object")
    errors.push("batchReportRef must be an object");
  if (r["egressAuditRef"] === null || typeof r["egressAuditRef"] !== "object")
    errors.push("egressAuditRef must be an object");
  if (r["verdict"] !== "passed" && r["verdict"] !== "failed")
    errors.push('verdict must be "passed" or "failed"');
  if (typeof r["seal"] !== "string" || r["seal"].length !== 64)
    errors.push("seal must be a 64-character hex SHA-256 string");
  // Validate all digest refs follow sha256:<hex> pattern.
  const allRefs: unknown[] = [
    r["x3BrowserReceiptRef"],
    ...(Array.isArray(r["cancellationReceipts"])
      ? r["cancellationReceipts"]
      : []),
    ...(Array.isArray(r["takeoverReceipts"]) ? r["takeoverReceipts"] : []),
    r["batchReportRef"],
    r["egressAuditRef"],
  ];
  for (const ref of allRefs) {
    if (ref === null || typeof ref !== "object") continue;
    const refObj = ref as Record<string, unknown>;
    if (
      typeof refObj["digest"] !== "string" ||
      !refObj["digest"].startsWith("sha256:")
    )
      errors.push(
        `receipt ref digest must start with "sha256:": got ${String(
          refObj["digest"]
        )}`
      );
  }
  if (
    errors.length === 0 &&
    !verifyFleetQualificationSummary(value as FleetQualificationSummary)
  )
    errors.push("seal does not match summary content");
  return { valid: errors.length === 0, errors };
}
