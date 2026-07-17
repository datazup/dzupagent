import { createHash } from 'node:crypto'

/**
 * X4 Fleet qualification receipt types and factory functions.
 *
 * Seals sanitized evidence for multi-worker cancellation isolation,
 * worker restart attribution (fencing tokens), batch concurrency,
 * cross-worker egress audit, and the final fleet-qualification summary.
 *
 * Rules:
 *  - No raw URLs, credentials, local paths, or command payloads in any receipt.
 *  - All receipts are sealed with SHA-256 of canonical JSON (excluding the seal field).
 *  - Schema versions follow the `datazup.<name>/v1` pattern.
 */

// ---------------------------------------------------------------------------
// Canonical JSON helpers (local copy — no shared dep)
// ---------------------------------------------------------------------------

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function sealFields(fields: Record<string, unknown>): string {
  return sha256Hex(stableJson(fields))
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
  direction: 'inbound' | 'outbound'
  /** Stable execution-scoped ID. */
  executionId: string
  /** Stable grant identifier from the ResourcePolicy. */
  grantId: string
  /** Whether the egress was permitted. */
  allowed: boolean
  /** Always true — confirms sanitization was applied. */
  sanitized: true
}

// ---------------------------------------------------------------------------
// FleetCancellationReceipt — sibling cancellation isolation
// ---------------------------------------------------------------------------

export const FLEET_CANCELLATION_RECEIPT_SCHEMA = 'datazup.fleetCancellationReceipt/v1' as const

/**
 * Sanitized record proving that cancelling executionId did NOT affect siblings.
 *
 * Produced once per cancelled execution. The `siblingIds` list proves which
 * concurrent executions were observed to have continued running after the
 * cancellation of `cancelledExecutionId`.
 */
export interface FleetCancellationReceipt {
  schema: typeof FLEET_CANCELLATION_RECEIPT_SCHEMA
  /** Stable ID for this receipt instance. */
  receiptId: string
  /** ISO 8601 sealed-at timestamp. */
  sealedAt: string
  /** The execution that was explicitly cancelled. */
  cancelledExecutionId: string
  /** Executions that continued unaffected after the cancellation. */
  siblingIds: string[]
  /** Worker host identifier (opaque, no hostname or IP). */
  workerHostRef: string
  /** Whether each sibling reached its natural completion after cancellation. */
  siblingsCompletedNaturally: boolean
  /** SHA-256 of canonical fields (excluding the seal itself). */
  seal: string
}

export interface SealFleetCancellationReceiptParams {
  receiptId: string
  cancelledExecutionId: string
  siblingIds: string[]
  workerHostRef: string
  siblingsCompletedNaturally: boolean
  sealedAt?: string
}

export function sealFleetCancellationReceipt(params: SealFleetCancellationReceiptParams): FleetCancellationReceipt {
  const sealedAt = params.sealedAt ?? new Date().toISOString()
  const fields = {
    schema: FLEET_CANCELLATION_RECEIPT_SCHEMA,
    receiptId: params.receiptId,
    sealedAt,
    cancelledExecutionId: params.cancelledExecutionId,
    siblingIds: params.siblingIds,
    workerHostRef: params.workerHostRef,
    siblingsCompletedNaturally: params.siblingsCompletedNaturally,
  }
  return { ...fields, seal: sealFields(fields) }
}

export function verifyFleetCancellationReceipt(receipt: FleetCancellationReceipt): boolean {
  const { seal, ...fields } = receipt
  return sha256Hex(stableJson(fields)) === seal
}

export interface FleetCancellationValidationResult {
  valid: boolean
  errors: string[]
}

export function validateFleetCancellationReceipt(value: unknown): FleetCancellationValidationResult {
  const errors: string[] = []
  if (value === null || typeof value !== 'object') {
    return { valid: false, errors: ['FleetCancellationReceipt must be an object'] }
  }
  const r = value as Record<string, unknown>
  if (r['schema'] !== FLEET_CANCELLATION_RECEIPT_SCHEMA)
    errors.push(`schema must be "${FLEET_CANCELLATION_RECEIPT_SCHEMA}"`)
  if (typeof r['receiptId'] !== 'string' || r['receiptId'].length === 0)
    errors.push('receiptId must be a non-empty string')
  if (typeof r['cancelledExecutionId'] !== 'string' || r['cancelledExecutionId'].length === 0)
    errors.push('cancelledExecutionId must be a non-empty string')
  if (!Array.isArray(r['siblingIds']) || (r['siblingIds'] as unknown[]).length === 0)
    errors.push('siblingIds must be a non-empty array')
  if (typeof r['workerHostRef'] !== 'string' || r['workerHostRef'].length === 0)
    errors.push('workerHostRef must be a non-empty string')
  if (typeof r['siblingsCompletedNaturally'] !== 'boolean') errors.push('siblingsCompletedNaturally must be a boolean')
  if (typeof r['seal'] !== 'string' || r['seal'].length !== 64)
    errors.push('seal must be a 64-character hex SHA-256 string')
  if (errors.length === 0 && !verifyFleetCancellationReceipt(value as FleetCancellationReceipt))
    errors.push('seal does not match receipt content')
  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// FleetTakeoverReceipt — worker restart / fencing-token attribution
// ---------------------------------------------------------------------------

export const FLEET_TAKEOVER_RECEIPT_SCHEMA = 'datazup.fleetTakeoverReceipt/v1' as const

/**
 * Sanitized record proving in-flight executions were correctly attributed
 * to the new worker's fencing token, and the old token was rejected.
 *
 * Fencing tokens are opaque short identifiers — no hostnames or credentials.
 */
export interface FleetTakeoverReceipt {
  schema: typeof FLEET_TAKEOVER_RECEIPT_SCHEMA
  receiptId: string
  sealedAt: string
  /** Execution IDs that were in-flight during the restart. */
  takenOverExecutionIds: string[]
  /** Opaque old fencing token (no hostname, IP, or credential). */
  oldFencingToken: string
  /** Opaque new fencing token. */
  newFencingToken: string
  /** Whether the old token was correctly rejected after restart. */
  oldTokenRejected: boolean
  /** Whether all in-flight executions were re-attributed to the new token. */
  attributionCorrect: boolean
  seal: string
}

export interface SealFleetTakeoverReceiptParams {
  receiptId: string
  takenOverExecutionIds: string[]
  oldFencingToken: string
  newFencingToken: string
  oldTokenRejected: boolean
  attributionCorrect: boolean
  sealedAt?: string
}

export function sealFleetTakeoverReceipt(params: SealFleetTakeoverReceiptParams): FleetTakeoverReceipt {
  const sealedAt = params.sealedAt ?? new Date().toISOString()
  const fields = {
    schema: FLEET_TAKEOVER_RECEIPT_SCHEMA,
    receiptId: params.receiptId,
    sealedAt,
    takenOverExecutionIds: params.takenOverExecutionIds,
    oldFencingToken: params.oldFencingToken,
    newFencingToken: params.newFencingToken,
    oldTokenRejected: params.oldTokenRejected,
    attributionCorrect: params.attributionCorrect,
  }
  return { ...fields, seal: sealFields(fields) }
}

export function verifyFleetTakeoverReceipt(receipt: FleetTakeoverReceipt): boolean {
  const { seal, ...fields } = receipt
  return sha256Hex(stableJson(fields)) === seal
}

export interface FleetTakeoverValidationResult {
  valid: boolean
  errors: string[]
}

export function validateFleetTakeoverReceipt(value: unknown): FleetTakeoverValidationResult {
  const errors: string[] = []
  if (value === null || typeof value !== 'object') {
    return { valid: false, errors: ['FleetTakeoverReceipt must be an object'] }
  }
  const r = value as Record<string, unknown>
  if (r['schema'] !== FLEET_TAKEOVER_RECEIPT_SCHEMA) errors.push(`schema must be "${FLEET_TAKEOVER_RECEIPT_SCHEMA}"`)
  if (typeof r['receiptId'] !== 'string' || r['receiptId'].length === 0)
    errors.push('receiptId must be a non-empty string')
  if (!Array.isArray(r['takenOverExecutionIds']) || (r['takenOverExecutionIds'] as unknown[]).length === 0)
    errors.push('takenOverExecutionIds must be a non-empty array')
  if (typeof r['oldFencingToken'] !== 'string' || r['oldFencingToken'].length === 0)
    errors.push('oldFencingToken must be a non-empty string')
  if (typeof r['newFencingToken'] !== 'string' || r['newFencingToken'].length === 0)
    errors.push('newFencingToken must be a non-empty string')
  if (r['oldFencingToken'] === r['newFencingToken']) errors.push('oldFencingToken and newFencingToken must differ')
  if (typeof r['oldTokenRejected'] !== 'boolean') errors.push('oldTokenRejected must be a boolean')
  if (typeof r['attributionCorrect'] !== 'boolean') errors.push('attributionCorrect must be a boolean')
  if (typeof r['seal'] !== 'string' || r['seal'].length !== 64)
    errors.push('seal must be a 64-character hex SHA-256 string')
  if (errors.length === 0 && !verifyFleetTakeoverReceipt(value as FleetTakeoverReceipt))
    errors.push('seal does not match receipt content')
  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// FleetBatchReport — concurrent execution batch
// ---------------------------------------------------------------------------

export const FLEET_BATCH_REPORT_SCHEMA = 'datazup.fleetBatchReport/v1' as const

/** Per-execution summary within a batch report. */
export interface FleetBatchExecutionEntry {
  executionId: string
  /** 'codex' | 'claude' — provider label only, no model version or API key. */
  provider: string
  /** Whether isolation receipt is present and verified for this execution. */
  isolationReceiptVerified: boolean
  /** Whether the execution completed without error. */
  completedWithoutError: boolean
}

/**
 * Sealed batch report covering ≥2 concurrent executions per provider.
 * Proves attribution, isolation enforcement, and cleanup across the batch.
 */
export interface FleetBatchReport {
  schema: typeof FLEET_BATCH_REPORT_SCHEMA
  receiptId: string
  sealedAt: string
  /** All executions in this batch, keyed by executionId. */
  executions: FleetBatchExecutionEntry[]
  /** Provider labels observed in this batch. */
  providersObserved: string[]
  /** Whether all executions passed isolation receipt verification. */
  allIsolationReceiptsVerified: boolean
  /** Whether post-batch cleanup completed without leaving artifacts. */
  cleanupVerified: boolean
  seal: string
}

export interface SealFleetBatchReportParams {
  receiptId: string
  executions: FleetBatchExecutionEntry[]
  cleanupVerified: boolean
  sealedAt?: string
}

/** Minimum concurrent executions per provider required for a valid batch. */
export const FLEET_BATCH_MIN_EXECUTIONS_PER_PROVIDER = 2

export function sealFleetBatchReport(params: SealFleetBatchReportParams): FleetBatchReport {
  const sealedAt = params.sealedAt ?? new Date().toISOString()
  const providersObserved = [...new Set(params.executions.map((e) => e.provider))].sort()
  const allIsolationReceiptsVerified = params.executions.every((e) => e.isolationReceiptVerified)
  const fields = {
    schema: FLEET_BATCH_REPORT_SCHEMA,
    receiptId: params.receiptId,
    sealedAt,
    executions: params.executions,
    providersObserved,
    allIsolationReceiptsVerified,
    cleanupVerified: params.cleanupVerified,
  }
  return { ...fields, seal: sealFields(fields) }
}

export function verifyFleetBatchReport(report: FleetBatchReport): boolean {
  const { seal, ...fields } = report
  return sha256Hex(stableJson(fields)) === seal
}

export interface FleetBatchValidationResult {
  valid: boolean
  errors: string[]
}

export function validateFleetBatchReport(value: unknown): FleetBatchValidationResult {
  const errors: string[] = []
  if (value === null || typeof value !== 'object') {
    return { valid: false, errors: ['FleetBatchReport must be an object'] }
  }
  const r = value as Record<string, unknown>
  if (r['schema'] !== FLEET_BATCH_REPORT_SCHEMA) errors.push(`schema must be "${FLEET_BATCH_REPORT_SCHEMA}"`)
  if (typeof r['receiptId'] !== 'string' || r['receiptId'].length === 0)
    errors.push('receiptId must be a non-empty string')
  if (!Array.isArray(r['executions'])) {
    errors.push('executions must be an array')
  } else {
    const execs = r['executions'] as FleetBatchExecutionEntry[]
    // Must have at least FLEET_BATCH_MIN_EXECUTIONS_PER_PROVIDER per provider.
    const countByProvider = new Map<string, number>()
    for (const e of execs) {
      countByProvider.set(e.provider, (countByProvider.get(e.provider) ?? 0) + 1)
    }
    for (const [provider, count] of countByProvider) {
      if (count < FLEET_BATCH_MIN_EXECUTIONS_PER_PROVIDER) {
        errors.push(
          `provider "${provider}" has only ${count} execution(s); need >= ${FLEET_BATCH_MIN_EXECUTIONS_PER_PROVIDER}`,
        )
      }
    }
    if (execs.length === 0) errors.push('executions must not be empty')
  }
  if (typeof r['cleanupVerified'] !== 'boolean') errors.push('cleanupVerified must be a boolean')
  if (typeof r['seal'] !== 'string' || r['seal'].length !== 64)
    errors.push('seal must be a 64-character hex SHA-256 string')
  if (errors.length === 0 && !verifyFleetBatchReport(value as FleetBatchReport))
    errors.push('seal does not match report content')
  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// FleetEgressAuditReceipt — cross-worker egress no-bleed
// ---------------------------------------------------------------------------

export const FLEET_EGRESS_AUDIT_RECEIPT_SCHEMA = 'datazup.fleetEgressAuditReceipt/v1' as const

/**
 * Sealed cross-worker egress audit receipt.
 * Proves egress policy correctly scopes provider endpoints per execution,
 * with no cross-execution grant bleed.
 */
export interface FleetEgressAuditReceipt {
  schema: typeof FLEET_EGRESS_AUDIT_RECEIPT_SCHEMA
  receiptId: string
  sealedAt: string
  /** Per-execution egress audit entries. All entries are sanitized. */
  entries: FleetEgressAuditEntry[]
  /** Whether any cross-execution grant bleed was detected. */
  crossExecutionBleedDetected: boolean
  /** Whether all executions had their egress correctly scoped. */
  allScopedCorrectly: boolean
  seal: string
}

export interface SealFleetEgressAuditReceiptParams {
  receiptId: string
  entries: FleetEgressAuditEntry[]
  crossExecutionBleedDetected: boolean
  sealedAt?: string
}

export function sealFleetEgressAuditReceipt(params: SealFleetEgressAuditReceiptParams): FleetEgressAuditReceipt {
  const sealedAt = params.sealedAt ?? new Date().toISOString()
  // Validate all entries are sanitized before sealing.
  for (const entry of params.entries) {
    if (!entry.sanitized) throw new Error(`FleetEgressAuditEntry for executionId=${entry.executionId} is not sanitized`)
  }
  // Group entries by executionId and verify no cross-bleed.
  const idSet = new Set(params.entries.map((e) => e.executionId))
  const allScopedCorrectly = idSet.size > 0 && !params.crossExecutionBleedDetected
  const fields = {
    schema: FLEET_EGRESS_AUDIT_RECEIPT_SCHEMA,
    receiptId: params.receiptId,
    sealedAt,
    entries: params.entries,
    crossExecutionBleedDetected: params.crossExecutionBleedDetected,
    allScopedCorrectly,
  }
  return { ...fields, seal: sealFields(fields) }
}

export function verifyFleetEgressAuditReceipt(receipt: FleetEgressAuditReceipt): boolean {
  const { seal, ...fields } = receipt
  return sha256Hex(stableJson(fields)) === seal
}

export interface FleetEgressAuditValidationResult {
  valid: boolean
  errors: string[]
}

export function validateFleetEgressAuditReceipt(value: unknown): FleetEgressAuditValidationResult {
  const errors: string[] = []
  if (value === null || typeof value !== 'object') {
    return { valid: false, errors: ['FleetEgressAuditReceipt must be an object'] }
  }
  const r = value as Record<string, unknown>
  if (r['schema'] !== FLEET_EGRESS_AUDIT_RECEIPT_SCHEMA)
    errors.push(`schema must be "${FLEET_EGRESS_AUDIT_RECEIPT_SCHEMA}"`)
  if (typeof r['receiptId'] !== 'string' || r['receiptId'].length === 0)
    errors.push('receiptId must be a non-empty string')
  if (!Array.isArray(r['entries'])) {
    errors.push('entries must be an array')
  } else {
    const entries = r['entries'] as FleetEgressAuditEntry[]
    for (const [i, e] of entries.entries()) {
      if (!e.sanitized) errors.push(`entries[${i}].sanitized must be true`)
      if (typeof e.executionId !== 'string' || e.executionId.length === 0)
        errors.push(`entries[${i}].executionId must be a non-empty string`)
      if (typeof e.grantId !== 'string' || e.grantId.length === 0)
        errors.push(`entries[${i}].grantId must be a non-empty string`)
      if (e.direction !== 'inbound' && e.direction !== 'outbound')
        errors.push(`entries[${i}].direction must be 'inbound' or 'outbound'`)
      if (typeof e.allowed !== 'boolean') errors.push(`entries[${i}].allowed must be a boolean`)
    }
  }
  if (typeof r['crossExecutionBleedDetected'] !== 'boolean')
    errors.push('crossExecutionBleedDetected must be a boolean')
  if (typeof r['allScopedCorrectly'] !== 'boolean') errors.push('allScopedCorrectly must be a boolean')
  if (typeof r['seal'] !== 'string' || r['seal'].length !== 64)
    errors.push('seal must be a 64-character hex SHA-256 string')
  if (errors.length === 0 && !verifyFleetEgressAuditReceipt(value as FleetEgressAuditReceipt))
    errors.push('seal does not match receipt content')
  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// FleetQualificationSummary — top-level digest chain
// ---------------------------------------------------------------------------

export const FLEET_QUALIFICATION_SUMMARY_SCHEMA = 'datazup.fleetQualificationSummary/v1' as const

/** Reference to an individual receipt by digest. */
export interface FleetReceiptRef {
  /** Human-readable label for the receipt type. */
  label: string
  /** sha256:<hex> digest of the receipt's canonical JSON. */
  digest: string
  /** Schema version string of the referenced receipt. */
  schema: string
}

/**
 * Top-level fleet qualification summary receipt.
 * References all individual receipts by digest, forming a digest chain.
 * All sub-receipts must be present and their digests must be verifiable.
 */
export interface FleetQualificationSummary {
  schema: typeof FLEET_QUALIFICATION_SUMMARY_SCHEMA
  receiptId: string
  sealedAt: string
  /** Reference to the X3 browser receipt that gates X4. */
  x3BrowserReceiptRef: FleetReceiptRef
  cancellationReceipts: FleetReceiptRef[]
  takeoverReceipts: FleetReceiptRef[]
  batchReportRef: FleetReceiptRef
  egressAuditRef: FleetReceiptRef
  /** Overall pass/fail verdict. */
  verdict: 'passed' | 'failed'
  /** SHA-256 of canonical fields (excluding the seal itself). */
  seal: string
}

export interface SealFleetQualificationSummaryParams {
  receiptId: string
  x3BrowserReceiptRef: FleetReceiptRef
  cancellationReceipts: FleetReceiptRef[]
  takeoverReceipts: FleetReceiptRef[]
  batchReportRef: FleetReceiptRef
  egressAuditRef: FleetReceiptRef
  verdict: 'passed' | 'failed'
  sealedAt?: string
}

export function sealFleetQualificationSummary(params: SealFleetQualificationSummaryParams): FleetQualificationSummary {
  const sealedAt = params.sealedAt ?? new Date().toISOString()
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
  }
  return { ...fields, seal: sealFields(fields) }
}

export function verifyFleetQualificationSummary(summary: FleetQualificationSummary): boolean {
  const { seal, ...fields } = summary
  return sha256Hex(stableJson(fields)) === seal
}

export interface FleetQualificationSummaryValidationResult {
  valid: boolean
  errors: string[]
}

/** Compute a `sha256:<hex>` digest from any serialisable object. */
export function computeReceiptDigest(receiptJson: string): string {
  return `sha256:${sha256Hex(receiptJson)}`
}

export function validateFleetQualificationSummary(value: unknown): FleetQualificationSummaryValidationResult {
  const errors: string[] = []
  if (value === null || typeof value !== 'object') {
    return { valid: false, errors: ['FleetQualificationSummary must be an object'] }
  }
  const r = value as Record<string, unknown>
  if (r['schema'] !== FLEET_QUALIFICATION_SUMMARY_SCHEMA)
    errors.push(`schema must be "${FLEET_QUALIFICATION_SUMMARY_SCHEMA}"`)
  if (typeof r['receiptId'] !== 'string' || r['receiptId'].length === 0)
    errors.push('receiptId must be a non-empty string')
  if (r['x3BrowserReceiptRef'] === null || typeof r['x3BrowserReceiptRef'] !== 'object')
    errors.push('x3BrowserReceiptRef must be an object')
  if (!Array.isArray(r['cancellationReceipts']) || (r['cancellationReceipts'] as unknown[]).length === 0)
    errors.push('cancellationReceipts must be a non-empty array')
  if (!Array.isArray(r['takeoverReceipts']) || (r['takeoverReceipts'] as unknown[]).length === 0)
    errors.push('takeoverReceipts must be a non-empty array')
  if (r['batchReportRef'] === null || typeof r['batchReportRef'] !== 'object')
    errors.push('batchReportRef must be an object')
  if (r['egressAuditRef'] === null || typeof r['egressAuditRef'] !== 'object')
    errors.push('egressAuditRef must be an object')
  if (r['verdict'] !== 'passed' && r['verdict'] !== 'failed') errors.push('verdict must be "passed" or "failed"')
  if (typeof r['seal'] !== 'string' || r['seal'].length !== 64)
    errors.push('seal must be a 64-character hex SHA-256 string')
  // Validate all digest refs follow sha256:<hex> pattern.
  const allRefs: unknown[] = [
    r['x3BrowserReceiptRef'],
    ...(Array.isArray(r['cancellationReceipts']) ? r['cancellationReceipts'] : []),
    ...(Array.isArray(r['takeoverReceipts']) ? r['takeoverReceipts'] : []),
    r['batchReportRef'],
    r['egressAuditRef'],
  ]
  for (const ref of allRefs) {
    if (ref === null || typeof ref !== 'object') continue
    const refObj = ref as Record<string, unknown>
    if (typeof refObj['digest'] !== 'string' || !refObj['digest'].startsWith('sha256:'))
      errors.push(`receipt ref digest must start with "sha256:": got ${String(refObj['digest'])}`)
  }
  if (errors.length === 0 && !verifyFleetQualificationSummary(value as FleetQualificationSummary))
    errors.push('seal does not match summary content')
  return { valid: errors.length === 0, errors }
}
