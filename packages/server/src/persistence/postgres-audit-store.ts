/**
 * PostgresAuditStore — Drizzle-backed implementation of ComplianceAuditStore.
 *
 * Uses the `dzupagent_audit_log` table defined in drizzle-schema.ts.
 * Appends are micro-batched (flush every 500ms or 100 entries) to avoid
 * per-event database round-trips on hot audit paths.
 */

import { eq, gte, lte, and, desc, asc, count, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { ComplianceAuditStore } from '@dzupagent/core'
import type {
  ComplianceAuditEntry,
  AuditFilter,
  AuditRetentionPolicy,
  IntegrityCheckResult,
} from '@dzupagent/core'
import { auditLog } from './drizzle-schema.js'

type DB = PostgresJsDatabase<Record<string, never>>

// ---------------------------------------------------------------------------
// Hash (mirrors InMemoryAuditStore for cross-store consistency)
// ---------------------------------------------------------------------------

function computeHash(content: string, previousHash: string): string {
  const input = previousHash + '|' + content
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

// ---------------------------------------------------------------------------
// Row → entry conversion
// ---------------------------------------------------------------------------

type AuditRow = typeof auditLog.$inferSelect

function rowToEntry(row: AuditRow): ComplianceAuditEntry {
  return {
    id: row.id,
    seq: row.seq,
    timestamp: row.ts,
    actor: {
      id: row.actorId,
      type: row.actorType as ComplianceAuditEntry['actor']['type'],
      name: row.actorName ?? undefined,
    },
    action: row.action,
    resource: row.resource ?? undefined,
    result: row.result as ComplianceAuditEntry['result'],
    details: row.details ?? {},
    previousHash: row.previousHash,
    hash: row.hash,
    traceId: row.traceId ?? undefined,
    spanId: row.spanId ?? undefined,
  }
}

// ---------------------------------------------------------------------------
// Micro-batch flush queue
// ---------------------------------------------------------------------------

interface PendingEntry {
  entry: Omit<ComplianceAuditEntry, 'seq' | 'previousHash' | 'hash'>
  resolve: (value: ComplianceAuditEntry) => void
  reject: (reason: unknown) => void
}

// ---------------------------------------------------------------------------
// PostgresAuditStore
// ---------------------------------------------------------------------------

export class PostgresAuditStore implements ComplianceAuditStore {
  private readonly db: DB
  private readonly batchSize: number
  private readonly flushIntervalMs: number

  private readonly pendingQueue: PendingEntry[] = []
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private flushing = false
  private cachedMaxSeq: number | undefined

  constructor(db: DB, opts: { batchSize?: number; flushIntervalMs?: number } = {}) {
    this.db = db
    this.batchSize = opts.batchSize ?? 100
    this.flushIntervalMs = opts.flushIntervalMs ?? 500
  }

  // ---------------------------------------------------------------------------
  // ComplianceAuditStore API
  // ---------------------------------------------------------------------------

  async append(
    input: Omit<ComplianceAuditEntry, 'seq' | 'previousHash' | 'hash'>,
  ): Promise<ComplianceAuditEntry> {
    return new Promise<ComplianceAuditEntry>((resolve, reject) => {
      this.pendingQueue.push({ entry: input, resolve, reject })
      this.scheduleFlush()
    })
  }

  async search(filter: AuditFilter): Promise<ComplianceAuditEntry[]> {
    await this.flush()
    const conditions = this.buildConditions(filter)
    const offset = filter.offset ?? 0
    const limit = filter.limit ?? 1000

    const base = this.db.select().from(auditLog)
    const query = conditions.length > 0
      ? base.where(and(...conditions))
      : base

    const rows = await query.orderBy(asc(auditLog.seq)).limit(limit).offset(offset)
    return rows.map(rowToEntry)
  }

  async count(filter: AuditFilter): Promise<number> {
    await this.flush()
    const conditions = this.buildConditions(filter)
    const base = this.db.select({ cnt: count() }).from(auditLog)
    const rows = conditions.length > 0
      ? await base.where(and(...conditions))
      : await base
    return rows[0]?.cnt ?? 0
  }

  async verifyIntegrity(): Promise<IntegrityCheckResult> {
    await this.flush()
    const rows = await this.db.select().from(auditLog).orderBy(asc(auditLog.seq))
    const entries = rows.map(rowToEntry)

    if (entries.length === 0) return { valid: true, totalEntries: 0 }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!
      const expectedPrevHash = i === 0 ? '' : entries[i - 1]!.hash
      if (entry.previousHash !== expectedPrevHash) {
        return { valid: false, totalEntries: entries.length, brokenAtSeq: entry.seq, brokenAtId: entry.id }
      }
      if (entry.hash !== computeHash(entryContent(entry), entry.previousHash)) {
        return { valid: false, totalEntries: entries.length, brokenAtSeq: entry.seq, brokenAtId: entry.id }
      }
    }

    return { valid: true, totalEntries: entries.length }
  }

  async applyRetention(
    policies: AuditRetentionPolicy[],
  ): Promise<{ archived: number; deleted: number }> {
    await this.flush()
    let deleted = 0
    for (const policy of policies) {
      const cutoff = new Date(Date.now() - policy.maxAgeDays * 24 * 60 * 60 * 1000)
      if (policy.action === 'delete') {
        const rows = await this.db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(lte(auditLog.ts, cutoff))
        if (rows.length > 0) {
          await this.db.delete(auditLog).where(lte(auditLog.ts, cutoff))
          deleted += rows.length
        }
      }
    }
    return { archived: 0, deleted }
  }

  async *export(): AsyncIterable<string> {
    await this.flush()
    const rows = await this.db.select().from(auditLog).orderBy(asc(auditLog.seq))
    for (const row of rows) {
      const entry = rowToEntry(row)
      yield JSON.stringify({ ...entry, timestamp: entry.timestamp.toISOString() })
    }
  }

  /** Flush all pending writes. Call before graceful shutdown. */
  async flush(): Promise<void> {
    if (this.pendingQueue.length === 0) return
    if (this.flushing) {
      await this.waitForFlush()
      return
    }
    await this.doFlush()
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private buildConditions(filter: AuditFilter): SQL[] {
    const conditions: SQL[] = []
    if (filter.actorId !== undefined) conditions.push(eq(auditLog.actorId, filter.actorId))
    if (filter.actorType !== undefined) conditions.push(eq(auditLog.actorType, filter.actorType))
    if (filter.action !== undefined) conditions.push(eq(auditLog.action, filter.action))
    if (filter.result !== undefined) conditions.push(eq(auditLog.result, filter.result))
    if (filter.fromDate !== undefined) conditions.push(gte(auditLog.ts, filter.fromDate))
    if (filter.toDate !== undefined) conditions.push(lte(auditLog.ts, filter.toDate))
    return conditions
  }

  private scheduleFlush(): void {
    if (this.pendingQueue.length >= this.batchSize) {
      void this.doFlush()
      return
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined
        void this.doFlush()
      }, this.flushIntervalMs)
    }
  }

  private async waitForFlush(): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (!this.flushing) resolve()
        else setTimeout(check, 10)
      }
      check()
    })
  }

  private async doFlush(): Promise<void> {
    if (this.flushing || this.pendingQueue.length === 0) return
    this.flushing = true

    const batch = this.pendingQueue.splice(0, this.batchSize)

    try {
      // Get the last seq + hash atomically
      const lastRow = await this.db
        .select({ seq: auditLog.seq, hash: auditLog.hash })
        .from(auditLog)
        .orderBy(desc(auditLog.seq))
        .limit(1)

      let previousHash = lastRow[0]?.hash ?? ''
      const baseSeq = (lastRow[0]?.seq ?? (this.cachedMaxSeq ?? 0))

      const completed: ComplianceAuditEntry[] = []
      for (let i = 0; i < batch.length; i++) {
        const { entry } = batch[i]!
        const seq = baseSeq + i + 1
        const content = entryContent(entry)
        const hash = computeHash(content, previousHash)
        const full: ComplianceAuditEntry = { ...entry, seq, previousHash, hash }
        previousHash = hash
        completed.push(full)
      }

      this.cachedMaxSeq = baseSeq + batch.length

      await this.db.insert(auditLog).values(
        completed.map((e) => ({
          id: e.id,
          seq: e.seq,
          ts: e.timestamp,
          actorId: e.actor.id,
          actorType: e.actor.type,
          actorName: e.actor.name ?? null,
          action: e.action,
          resource: e.resource ?? null,
          result: e.result,
          details: e.details,
          previousHash: e.previousHash,
          hash: e.hash,
          traceId: e.traceId ?? null,
          spanId: e.spanId ?? null,
        })),
      )

      for (let i = 0; i < batch.length; i++) {
        batch[i]!.resolve(completed[i]!)
      }
    } catch (err) {
      for (const { reject } of batch) {
        reject(err)
      }
    } finally {
      this.flushing = false
    }
  }
}
