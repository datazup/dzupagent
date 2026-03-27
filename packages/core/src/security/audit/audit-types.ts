/**
 * Compliance audit trail types.
 *
 * Provides tamper-evident, hash-chained audit logging for security,
 * compliance, and governance requirements.
 */

/** The type of actor that performed an auditable action. */
export type AuditActorType = 'user' | 'agent' | 'service' | 'system'

/** Identifies who performed an auditable action. */
export interface AuditActor {
  id: string
  type: AuditActorType
  name?: string
}

/** The outcome of an auditable action. */
export type AuditResult = 'success' | 'denied' | 'failed' | 'blocked'

/**
 * A single entry in the compliance audit log.
 *
 * Entries form a hash chain: each entry's `hash` is computed over its
 * content plus the `previousHash`, making the log tamper-evident.
 */
export interface ComplianceAuditEntry {
  /** Unique identifier for this entry. */
  id: string
  /** Monotonically increasing sequence number. */
  seq: number
  /** When the auditable action occurred. */
  timestamp: Date
  /** Who performed the action. */
  actor: AuditActor
  /** The action that was performed (e.g., 'tool:execute', 'memory:write'). */
  action: string
  /** The resource acted upon (e.g., a namespace, file path, agent ID). */
  resource?: string
  /** The outcome of the action. */
  result: AuditResult
  /** Arbitrary structured details about the action. */
  details: Record<string, unknown>
  /** Hash of the previous entry in the chain (empty string for first entry). */
  previousHash: string
  /** Hash of this entry (covers all fields + previousHash). */
  hash: string
  /** OpenTelemetry trace ID for correlation. */
  traceId?: string
  /** OpenTelemetry span ID for correlation. */
  spanId?: string
}

/** Filter criteria for searching audit entries. */
export interface AuditFilter {
  actorId?: string
  actorType?: AuditActorType
  action?: string
  result?: AuditResult
  fromDate?: Date
  toDate?: Date
  limit?: number
  offset?: number
}

/**
 * Retention policy for audit entries.
 * Named `AuditRetentionPolicy` to avoid conflict with
 * the memory `RetentionPolicy` type.
 */
export interface AuditRetentionPolicy {
  /** Maximum age in days before the policy action is applied. */
  maxAgeDays: number
  /** Whether to archive or delete expired entries. */
  action: 'archive' | 'delete'
  /** Optional regulation label (e.g., 'GDPR', 'SOX'). */
  regulation?: string
}

/** Result of a hash-chain integrity verification. */
export interface IntegrityCheckResult {
  /** Whether the entire chain is valid. */
  valid: boolean
  /** Total number of entries checked. */
  totalEntries: number
  /** Sequence number where the chain first broke (if invalid). */
  brokenAtSeq?: number
  /** Entry ID where the chain first broke (if invalid). */
  brokenAtId?: string
}
