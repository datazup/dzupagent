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
  hostCapabilities: HostCapabilities
  limitsApplied: string[]
  limitsUnavailable: string[]
  egressRecords: EgressRecord[]
  forciblyTerminated: boolean
  sessionStatePreserved: boolean
  sealedAt?: string
}

export function sealIsolationReceipt(params: SealIsolationReceiptParams): IsolationReceiptSummary {
  const sealedAt = params.sealedAt ?? new Date().toISOString()
  const unsealedFields = {
    executionId: params.executionId,
    sealedAt,
    policyId: params.policy.policyId,
    wallTimeSec: params.policy.wallTimeSec,
    hostCapabilities: params.hostCapabilities,
    limitsApplied: params.limitsApplied,
    limitsUnavailable: params.limitsUnavailable,
    egressRecords: params.egressRecords,
    forciblyTerminated: params.forciblyTerminated,
    sessionStatePreserved: params.sessionStatePreserved,
  }
  const seal = createHash('sha256').update(stableJson(unsealedFields), 'utf8').digest('hex')
  return { ...unsealedFields, seal }
}

/**
 * Verify that a receipt's seal matches its content.
 */
export function verifyIsolationReceipt(receipt: IsolationReceiptSummary): boolean {
  const { seal, ...fields } = receipt
  const expected = createHash('sha256').update(stableJson(fields), 'utf8').digest('hex')
  return expected === seal
}
