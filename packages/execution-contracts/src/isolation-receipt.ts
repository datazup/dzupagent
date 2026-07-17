import { createHash } from 'node:crypto'
import type { ResourcePolicy } from './resource-policy.js'
import type { HostCapabilities } from './host-capabilities.js'
import type { EgressRecord } from './egress-policy.js'

/**
 * Provider-free isolation receipt module (X2 scaffolding).
 *
 * Seals a sanitized summary of what isolation was applied for one execution.
 * Real Codex/Claude lanes will populate this via separate qualification runs.
 * No URLs, credentials, local paths, or raw payloads appear in the receipt.
 */

export interface IsolationReceiptSummary {
  /** Stable execution-scoped ID. */
  executionId: string
  /** ISO 8601 sealed-at timestamp. */
  sealedAt: string
  /** Policy ID from the applied ResourcePolicy. */
  policyId: string
  /** SHA-256 signature of the signed execution policy (from SignedExecutionPolicy.signature). */
  policySignature: string
  /** SHA-256 digest of the command catalog (from CommandCatalog.digest). */
  catalogDigest: string
  /** Wall-time budget in seconds from the policy. */
  wallTimeSec: number
  /** Capabilities that were available on this host. */
  hostCapabilities: HostCapabilities
  /** Limits actually applied vs. unavailable on this host. */
  limitsApplied: string[]
  limitsUnavailable: string[]
  /** Egress decisions (sanitized — no URLs). */
  egressRecords: EgressRecord[]
  /** Whether the process group was killed before natural exit. */
  forciblyTerminated: boolean
  /** Whether provider-session resume state was preserved. */
  sessionStatePreserved: boolean
  /** SHA-256 of this receipt's canonical fields (excluding the seal itself). */
  seal: string
}

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

export interface SealIsolationReceiptParams {
  executionId: string
  policy: ResourcePolicy
  policySignature: string
  catalogDigest: string
  hostCapabilities: HostCapabilities
  limitsApplied: string[]
  limitsUnavailable: string[]
  egressRecords: EgressRecord[]
  forciblyTerminated: boolean
  sessionStatePreserved: boolean
  sealedAt?: string
}

export function sealIsolationReceipt(
  params: SealIsolationReceiptParams,
): IsolationReceiptSummary {
  assertSha256Hex(params.policySignature, 'policySignature')
  assertSha256Hex(params.catalogDigest, 'catalogDigest')
  const sealedAt = params.sealedAt ?? new Date().toISOString()
  const unsealedFields = {
    executionId: params.executionId,
    sealedAt,
    policyId: params.policy.policyId,
    policySignature: params.policySignature,
    catalogDigest: params.catalogDigest,
    wallTimeSec: params.policy.wallTimeSec,
    hostCapabilities: params.hostCapabilities,
    limitsApplied: params.limitsApplied,
    limitsUnavailable: params.limitsUnavailable,
    egressRecords: params.egressRecords,
    forciblyTerminated: params.forciblyTerminated,
    sessionStatePreserved: params.sessionStatePreserved,
  }
  const seal = createHash('sha256')
    .update(stableJson(unsealedFields), 'utf8')
    .digest('hex')
  return { ...unsealedFields, seal }
}

/**
 * Verify that a receipt's seal matches its content.
 */
export function verifyIsolationReceipt(
  receipt: IsolationReceiptSummary,
): boolean {
  if (!isSha256Hex(receipt.policySignature) || !isSha256Hex(receipt.catalogDigest)) return false
  const { seal, ...fields } = receipt
  const expected = createHash('sha256')
    .update(stableJson(fields), 'utf8')
    .digest('hex')
  return expected === seal
}

function assertSha256Hex(value: string, field: 'policySignature' | 'catalogDigest'): void {
  if (!isSha256Hex(value)) {
    const code = field === 'policySignature' ? 'POLICY_SIGNATURE' : 'CATALOG_DIGEST'
    throw new Error(`ISOLATION_RECEIPT_${code}_INVALID`)
  }
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}
