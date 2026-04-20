/**
 * Tests for {@link MailDlqWorker}.
 *
 * Covers the three core behaviours specified in the wiring task:
 *   1. Successful redelivery: the worker drains due rows, calls
 *      `mailbox.save()`, and removes the DLQ entry.
 *   2. Failed redelivery: the worker calls `dlq.recordAttempt(id)` so the
 *      attempt counter advances (exponential backoff / eventual markDead).
 *   3. Rate-limit overflow: the worker surfaces `MailRateLimitError` to the
 *      failure hook with reason `'rate_limit'` and increments attempts.
 *
 * Uses the same in-memory fake Drizzle client pattern established in
 * `drizzle-dlq-store.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MailDlqWorker } from '../mail-dlq-worker.js'
import { DrizzleDlqStore } from '../../persistence/drizzle-dlq-store.js'
import { DrizzleMailboxStore } from '../../persistence/drizzle-mailbox-store.js'
import {
  agentMailbox,
  agentMailDlq,
} from '../../persistence/drizzle-schema.js'
import {
  MailRateLimiter,
} from '../mail-rate-limiter.js'
import type { MailboxStore, MailMessage } from '@dzupagent/agent'

// ---------------------------------------------------------------------------
// Minimal in-memory fake Drizzle client (mirrors drizzle-dlq-store.test.ts)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>
interface Predicate { (row: Row): boolean }

class FakeDb {
  dlq: Row[] = []
  mailbox: Row[] = []

  private tableFor(t: unknown): Row[] {
    if (t === agentMailDlq) return this.dlq
    if (t === agentMailbox) return this.mailbox
    throw new Error('unknown table')
  }

  insert(t: unknown): { values: (row: Row) => Promise<void> } {
    const target = this.tableFor(t)
    return {
      values: async (row: Row) => { target.push({ ...row }) },
    }
  }

  select(): SelectChain { return new SelectChain(this) }
  update(t: unknown): UpdateChain { return new UpdateChain(this.tableFor(t)) }
  delete(t: unknown): DeleteChain { return new DeleteChain(this.tableFor(t)) }
}

class SelectChain {
  private rows: Row[] = []
  private filters: Predicate[] = []
  private orderFn: ((a: Row, b: Row) => number) | null = null
  private limitN: number | null = null
  constructor(private readonly db: FakeDb) {}
  from(t: unknown): this {
    if (t === agentMailDlq) this.rows = this.db.dlq
    else if (t === agentMailbox) this.rows = this.db.mailbox
    else throw new Error('unknown table in from()')
    return this
  }
  where(pred: unknown): this {
    if (pred && typeof pred === 'object' && '__pred' in pred) {
      this.filters.push((pred as { __pred: Predicate }).__pred)
    }
    return this
  }
  orderBy(expr: unknown): this {
    if (expr && typeof expr === 'object' && '__order' in expr) {
      this.orderFn = (expr as { __order: (a: Row, b: Row) => number }).__order
    }
    return this
  }
  limit(n: number): this { this.limitN = n; return this }
  then<T>(onFulfilled: (rows: Row[]) => T): Promise<T> {
    let out = this.rows.slice()
    for (const f of this.filters) out = out.filter(f)
    if (this.orderFn) out.sort(this.orderFn)
    if (this.limitN !== null) out = out.slice(0, this.limitN)
    return Promise.resolve(onFulfilled(out))
  }
}

class UpdateChain {
  private patch: Row = {}
  private filters: Predicate[] = []
  constructor(private readonly target: Row[]) {}
  set(patch: Row): this { this.patch = patch; return this }
  where(pred: unknown): this {
    if (pred && typeof pred === 'object' && '__pred' in pred) {
      this.filters.push((pred as { __pred: Predicate }).__pred)
    }
    return this
  }
  then<T>(onFulfilled: (v: undefined) => T): Promise<T> {
    for (const row of this.target) {
      if (this.filters.every((f) => f(row))) Object.assign(row, this.patch)
    }
    return Promise.resolve(onFulfilled(undefined))
  }
}

class DeleteChain {
  private filters: Predicate[] = []
  constructor(private readonly target: Row[]) {}
  where(pred: unknown): this {
    if (pred && typeof pred === 'object' && '__pred' in pred) {
      this.filters.push((pred as { __pred: Predicate }).__pred)
    }
    return this
  }
  then<T>(onFulfilled: (r: { rowCount: number }) => T): Promise<T> {
    let removed = 0
    for (let i = this.target.length - 1; i >= 0; i--) {
      const row = this.target[i]!
      if (this.filters.every((f) => f(row))) {
        this.target.splice(i, 1)
        removed++
      }
    }
    return Promise.resolve(onFulfilled({ rowCount: removed }))
  }
}

vi.mock('drizzle-orm', async () => {
  const readCol = (col: unknown, row: Row): unknown => {
    if (col && typeof col === 'object' && 'name' in col) {
      const name = (col as { name: string }).name
      const map: Record<string, string> = {
        id: 'id',
        original_message_id: 'originalMessageId',
        from_agent: 'fromAgent',
        to_agent: 'toAgent',
        subject: 'subject',
        body: 'body',
        fail_reason: 'failReason',
        attempts: 'attempts',
        next_retry_at: 'nextRetryAt',
        created_at: 'createdAt',
        dead_at: 'deadAt',
        read_at: 'readAt',
        ttl_seconds: 'ttlSeconds',
      }
      return row[map[name] ?? name]
    }
    return col
  }
  const wrap = (pred: Predicate): { __pred: Predicate } => ({ __pred: pred })
  return {
    eq: (col: unknown, val: unknown) => wrap((row: Row) => readCol(col, row) === val),
    and: (...preds: Array<{ __pred: Predicate } | Predicate>) =>
      wrap((row: Row) => preds.every((p) => typeof p === 'function'
        ? p(row)
        : (p as { __pred: Predicate }).__pred(row))),
    isNull: (col: unknown) => wrap((row: Row) => {
      const v = readCol(col, row)
      return v === null || v === undefined
    }),
    lte: (col: unknown, val: unknown) => wrap((row: Row) => (readCol(col, row) as number) <= (val as number)),
    gt: (col: unknown, val: unknown) => wrap((row: Row) => (readCol(col, row) as number) > (val as number)),
    asc: (col: unknown) => ({
      __order: (a: Row, b: Row) => (readCol(col, a) as number) - (readCol(col, b) as number),
    }),
    sql: () => wrap(() => true),
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MailDlqWorker', () => {
  let db: FakeDb
  let dlq: DrizzleDlqStore

  beforeEach(() => {
    db = new FakeDb()
    dlq = new DrizzleDlqStore(db)
  })

  // 1. Success path: worker drains, saves, and removes the DLQ row.
  it('drains due rows, delivers via mailbox.save, and removes the DLQ entry', async () => {
    const msg: MailMessage = {
      id: 'orig-1',
      from: 'alice',
      to: 'bob',
      subject: 's',
      body: { n: 1 },
      createdAt: 1_000,
    }
    await dlq.enqueue(msg, 'rate_limit', 1_000)
    expect(db.dlq).toHaveLength(1)

    const saved: MailMessage[] = []
    const mailbox: MailboxStore = {
      save: async (m) => { saved.push(m) },
      findByRecipient: async () => [],
      markRead: async () => {},
      deleteExpired: async () => 0,
    }

    // `now` is past nextRetryAt (1_000 + 30_000 = 31_000).
    const worker = new MailDlqWorker({
      dlq,
      mailbox,
      intervalMs: 10_000,
      batchSize: 50,
      now: () => 100_000,
    })

    const result = await worker.tick()
    expect(result).toEqual({ delivered: 1, failed: 0 })
    expect(saved).toHaveLength(1)
    expect(saved[0]!.id).toBe('orig-1')
    expect(db.dlq).toHaveLength(0)
  })

  // 2. Failure path: worker calls dlq.recordAttempt on error, attempts advance.
  it('calls dlq.recordAttempt when redelivery throws and advances the attempt counter', async () => {
    const msg: MailMessage = {
      id: 'orig-2',
      from: 'alice',
      to: 'bob',
      subject: 's',
      body: { n: 2 },
      createdAt: 1_000,
    }
    await dlq.enqueue(msg, 'rate_limit', 1_000)

    const mailbox: MailboxStore = {
      save: async () => { throw new Error('db blew up') },
      findByRecipient: async () => [],
      markRead: async () => {},
      deleteExpired: async () => 0,
    }

    const failures: Array<{ id: string; reason: string }> = []
    const worker = new MailDlqWorker({
      dlq,
      mailbox,
      intervalMs: 10_000,
      batchSize: 50,
      now: () => 100_000,
      onFailure: (id, reason) => failures.push({ id, reason }),
    })

    const result = await worker.tick()
    expect(result).toEqual({ delivered: 0, failed: 1 })
    expect(db.dlq).toHaveLength(1)
    expect((db.dlq[0] as { attempts: number }).attempts).toBe(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.reason).toBe('transient')
  })

  // 3. Rate-limit re-fail path: worker correctly classifies and advances.
  it('classifies MailRateLimitError as rate_limit and still records an attempt', async () => {
    // Prime the DLQ with a message whose recipient bucket is exhausted.
    const msg: MailMessage = {
      id: 'orig-3',
      from: 'alice',
      to: 'popular',
      subject: 's',
      body: { n: 3 },
      createdAt: 1_000,
    }
    await dlq.enqueue(msg, 'rate_limit', 1_000)

    // Build a mailbox whose limiter refuses every save.
    const fixedNow = 50_000
    const limiter = new MailRateLimiter({ capacity: 1, refillPerMinute: 1, now: () => fixedNow })
    // Drain the single token so the next save overflows.
    expect(limiter.tryConsume('popular')).toBe(true)
    const mailbox = new DrizzleMailboxStore(db, { rateLimiter: limiter, dlq })

    const failures: Array<{ id: string; reason: string }> = []
    const worker = new MailDlqWorker({
      dlq,
      mailbox,
      intervalMs: 10_000,
      batchSize: 50,
      now: () => 100_000,
      onFailure: (id, reason) => failures.push({ id, reason }),
    })

    const result = await worker.tick()
    expect(result).toEqual({ delivered: 0, failed: 1 })
    expect(failures).toHaveLength(1)
    expect(failures[0]!.reason).toBe('rate_limit')
    // Original DLQ row still exists (attempts advanced). A new row may have
    // been enqueued by the overflowing save — the worker does not dedupe that,
    // which is acceptable for this unit.
    const originalRow = db.dlq.find(
      (r) => (r as { originalMessageId: string }).originalMessageId === 'orig-3'
        && (r as { attempts: number }).attempts === 1,
    )
    expect(originalRow).toBeDefined()
  })
})
