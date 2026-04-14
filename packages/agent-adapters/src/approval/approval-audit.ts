/**
 * Approval Audit Trail — records every approval decision for compliance
 * and debugging purposes.
 *
 * Provides an in-memory bounded store by default; consumers can implement
 * {@link ApprovalAuditStore} for persistent backends (database, file, etc.).
 */

import type { AdapterProviderId } from '../types.js'
import type { ApprovalMode } from './adapter-approval.js'

/** Record of a single approval decision. */
export interface ApprovalAuditEntry {
  requestId: string
  providerId: AdapterProviderId
  action: 'requested' | 'granted' | 'rejected' | 'timed_out' | 'auto_approved'
  timestamp: number
  /** Who made the decision (user ID, 'system', 'auto-policy'). */
  actor: string
  /** Why the decision was made. */
  reason?: string | undefined
  /** Cost at time of decision. */
  estimatedCostCents?: number | undefined
  /** Approval mode that was active. */
  mode: ApprovalMode
}

/** Query filters for audit entries. */
export interface AuditQueryFilters {
  requestId?: string | undefined
  providerId?: AdapterProviderId | undefined
  action?: ApprovalAuditEntry['action'] | undefined
  since?: number | undefined
  until?: number | undefined
  limit?: number | undefined
}

/** Interface for audit storage backends. */
export interface ApprovalAuditStore {
  record(entry: ApprovalAuditEntry): void
  query(filters?: AuditQueryFilters): ApprovalAuditEntry[]
  clear(): void
}

/**
 * In-memory audit store with bounded size.
 * Evicts oldest entries when at capacity.
 */
export class InMemoryApprovalAuditStore implements ApprovalAuditStore {
  private readonly entries: ApprovalAuditEntry[] = []
  private readonly maxEntries: number

  constructor(maxEntries: number = 1000) {
    this.maxEntries = maxEntries
  }

  record(entry: ApprovalAuditEntry): void {
    this.entries.push(entry)
    while (this.entries.length > this.maxEntries) {
      this.entries.shift()
    }
  }

  query(filters?: AuditQueryFilters): ApprovalAuditEntry[] {
    let result: ApprovalAuditEntry[] = this.entries

    if (filters?.requestId) {
      result = result.filter((e) => e.requestId === filters.requestId)
    }
    if (filters?.providerId) {
      result = result.filter((e) => e.providerId === filters.providerId)
    }
    if (filters?.action) {
      result = result.filter((e) => e.action === filters.action)
    }
    if (filters?.since !== undefined) {
      const since = filters.since
      result = result.filter((e) => e.timestamp >= since)
    }
    if (filters?.until !== undefined) {
      const until = filters.until
      result = result.filter((e) => e.timestamp <= until)
    }
    if (filters?.limit !== undefined) {
      result = result.slice(-filters.limit)
    }

    return result
  }

  clear(): void {
    this.entries.length = 0
  }
}
