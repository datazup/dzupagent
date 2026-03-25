/**
 * ComplianceAuditStore — persistence interface for the audit trail.
 */

import type {
  ComplianceAuditEntry,
  AuditFilter,
  AuditRetentionPolicy,
  IntegrityCheckResult,
} from './audit-types.js'

/**
 * Storage backend for compliance audit entries.
 *
 * Implementations must guarantee:
 * - `append()` assigns monotonic `seq`, computes `previousHash`/`hash`
 * - `verifyIntegrity()` walks the entire chain and validates hashes
 * - `export()` yields NDJSON (newline-delimited JSON) lines
 */
export interface ComplianceAuditStore {
  /** Append a new entry. The store assigns seq, previousHash, and hash. */
  append(
    entry: Omit<ComplianceAuditEntry, 'seq' | 'previousHash' | 'hash'>,
  ): Promise<ComplianceAuditEntry>

  /** Search entries matching the given filter. */
  search(filter: AuditFilter): Promise<ComplianceAuditEntry[]>

  /** Count entries matching the given filter. */
  count(filter: AuditFilter): Promise<number>

  /** Verify the hash chain integrity of the entire log. */
  verifyIntegrity(): Promise<IntegrityCheckResult>

  /** Apply retention policies, returning counts of archived/deleted entries. */
  applyRetention(
    policies: AuditRetentionPolicy[],
  ): Promise<{ archived: number; deleted: number }>

  /** Export the entire audit log as NDJSON lines. */
  export(): AsyncIterable<string>
}
