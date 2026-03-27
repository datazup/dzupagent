/**
 * Audit trail types for sandbox operations.
 *
 * Every sandbox action (execute, upload, download, cleanup, create, destroy)
 * is recorded as a hash-chained audit entry for tamper detection.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditAction = 'execute' | 'upload' | 'download' | 'cleanup' | 'create' | 'destroy'

export interface SandboxAuditEntry {
  /** Unique entry identifier */
  id: string
  /** Sequence number within the sandbox chain (0-based) */
  seq: number
  /** Sandbox identifier */
  sandboxId: string
  /** Optional run/session identifier */
  runId?: string
  /** What operation was performed */
  action: AuditAction
  /** Operation-specific details */
  details: Record<string, unknown>
  /** Hash of the previous entry (empty string for seq 0) */
  previousHash: string
  /** Hash of this entry (covers id, seq, sandboxId, action, details, previousHash) */
  hash: string
  /** When the action occurred */
  timestamp: Date
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface SandboxAuditStore {
  /**
   * Append a new audit entry. The store assigns seq, previousHash, and hash.
   */
  append(
    entry: Omit<SandboxAuditEntry, 'seq' | 'previousHash' | 'hash'>,
  ): Promise<SandboxAuditEntry>

  /** Retrieve all entries for a given sandbox, ordered by seq. */
  getBySandbox(sandboxId: string): Promise<SandboxAuditEntry[]>

  /**
   * Verify the hash chain for a given sandbox.
   * @returns valid=true if the chain is intact, otherwise brokenAt indicates the seq where it breaks.
   */
  verifyChain(sandboxId: string): Promise<{ valid: boolean; brokenAt?: number }>
}
