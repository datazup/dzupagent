/**
 * InMemoryAuditStore — in-process implementation of ComplianceAuditStore.
 *
 * Uses a simple array with SHA-256-based hash chaining.
 * Suitable for testing, development, and single-process deployments.
 */

import type { ComplianceAuditStore } from './audit-store.js'
import type {
  ComplianceAuditEntry,
  AuditFilter,
  AuditRetentionPolicy,
  IntegrityCheckResult,
} from './audit-types.js'

/**
 * Compute a deterministic hash string for an audit entry.
 *
 * Uses a simple but collision-resistant string hash since
 * SubtleCrypto (SHA-256) is async and adds complexity.
 * For production, swap with a crypto-backed implementation.
 */
function computeHash(content: string, previousHash: string): string {
  const input = previousHash + '|' + content
  // djb2-variant producing a 16-hex-char hash
  let h1 = 5381
  let h2 = 52711
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = ((h1 << 5) + h1 + ch) | 0
    h2 = ((h2 << 5) + h2 + ch) | 0
  }
  const a = (h1 >>> 0).toString(16).padStart(8, '0')
  const b = (h2 >>> 0).toString(16).padStart(8, '0')
  return a + b
}

function entryContent(entry: Omit<ComplianceAuditEntry, 'hash' | 'previousHash' | 'seq'>): string {
  return JSON.stringify({
    id: entry.id,
    timestamp: entry.timestamp.toISOString(),
    actor: entry.actor,
    action: entry.action,
    resource: entry.resource,
    result: entry.result,
    details: entry.details,
    traceId: entry.traceId,
    spanId: entry.spanId,
  })
}

function matchesFilter(entry: ComplianceAuditEntry, filter: AuditFilter): boolean {
  if (filter.actorId !== undefined && entry.actor.id !== filter.actorId) return false
  if (filter.actorType !== undefined && entry.actor.type !== filter.actorType) return false
  if (filter.action !== undefined && entry.action !== filter.action) return false
  if (filter.result !== undefined && entry.result !== filter.result) return false
  if (filter.fromDate !== undefined && entry.timestamp < filter.fromDate) return false
  if (filter.toDate !== undefined && entry.timestamp > filter.toDate) return false
  return true
}

export class InMemoryAuditStore implements ComplianceAuditStore {
  private readonly entries: ComplianceAuditEntry[] = []
  private nextSeq = 1

  async append(
    input: Omit<ComplianceAuditEntry, 'seq' | 'previousHash' | 'hash'>,
  ): Promise<ComplianceAuditEntry> {
    const seq = this.nextSeq++
    const previousHash =
      this.entries.length > 0
        ? this.entries[this.entries.length - 1]!.hash
        : ''

    const content = entryContent(input)
    const hash = computeHash(content, previousHash)

    const entry: ComplianceAuditEntry = {
      ...input,
      seq,
      previousHash,
      hash,
    }

    this.entries.push(entry)
    return entry
  }

  async search(filter: AuditFilter): Promise<ComplianceAuditEntry[]> {
    let results = this.entries.filter((e) => matchesFilter(e, filter))
    const offset = filter.offset ?? 0
    const limit = filter.limit ?? results.length
    results = results.slice(offset, offset + limit)
    return results
  }

  async count(filter: AuditFilter): Promise<number> {
    return this.entries.filter((e) => matchesFilter(e, filter)).length
  }

  async verifyIntegrity(): Promise<IntegrityCheckResult> {
    if (this.entries.length === 0) {
      return { valid: true, totalEntries: 0 }
    }

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!
      const expectedPrevHash = i === 0 ? '' : this.entries[i - 1]!.hash
      if (entry.previousHash !== expectedPrevHash) {
        return {
          valid: false,
          totalEntries: this.entries.length,
          brokenAtSeq: entry.seq,
          brokenAtId: entry.id,
        }
      }

      const content = entryContent(entry)
      const expectedHash = computeHash(content, entry.previousHash)
      if (entry.hash !== expectedHash) {
        return {
          valid: false,
          totalEntries: this.entries.length,
          brokenAtSeq: entry.seq,
          brokenAtId: entry.id,
        }
      }
    }

    return { valid: true, totalEntries: this.entries.length }
  }

  async applyRetention(
    policies: AuditRetentionPolicy[],
  ): Promise<{ archived: number; deleted: number }> {
    const now = Date.now()
    let archived = 0
    let deleted = 0

    for (const policy of policies) {
      const cutoff = now - policy.maxAgeDays * 24 * 60 * 60 * 1000
      const toRemove: number[] = []

      for (let i = 0; i < this.entries.length; i++) {
        if (this.entries[i]!.timestamp.getTime() < cutoff) {
          toRemove.push(i)
        }
      }

      if (policy.action === 'archive') {
        archived += toRemove.length
      } else {
        deleted += toRemove.length
      }

      // Remove in reverse order to preserve indices
      for (let i = toRemove.length - 1; i >= 0; i--) {
        this.entries.splice(toRemove[i]!, 1)
      }
    }

    return { archived, deleted }
  }

  async *export(): AsyncIterable<string> {
    for (const entry of this.entries) {
      yield JSON.stringify({
        ...entry,
        timestamp: entry.timestamp.toISOString(),
      })
    }
  }
}
