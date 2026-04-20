/**
 * Tests for {@link DrizzleDlqStore} and its interaction with
 * {@link DrizzleMailboxStore} under rate-limit overflow.
 *
 * Uses an in-memory fake Drizzle client that honours the small subset of the
 * fluent API we touch:
 *   - insert(table).values(row)
 *   - select().from(table).where(predicate).orderBy(expr).limit(n)
 *   - update(table).set(patch).where(predicate)
 *   - delete(table).where(predicate)
 *
 * Predicates and order expressions are captured as structured tags by our
 * tiny shims for `and`, `eq`, `isNull`, `lte`, `asc`, `sql` (see fake-drizzle
 * below). This lets us evaluate them against the in-memory row arrays.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DrizzleDlqStore, MAX_DLQ_ATTEMPTS } from '../drizzle-dlq-store.js'
import { DrizzleMailboxStore } from '../drizzle-mailbox-store.js'
import { agentMailbox, agentMailDlq } from '../drizzle-schema.js'
import {
  MailRateLimiter,
  MailRateLimitError,
} from '../../notifications/mail-rate-limiter.js'

// ---------------------------------------------------------------------------
// Minimal in-memory fake Drizzle client
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

interface Predicate {
  (row: Row): boolean
}

// drizzle-orm helpers (and, eq, isNull, lte, asc, sql) return opaque tagged
// values when used against our fake tables. Our fake resolves them at
// query-evaluation time. We replace the real helpers inside
// drizzle-dlq-store.js via a runtime shim is NOT desirable — instead we make
// the fake interpret them by relying on the runtime behavior: drizzle-orm's
// helpers produce SQL objects, but when we run them against the fake, we
// rely on structural pattern-matching via the `sql` template, `and`, `eq`,
// etc. passing through unchanged references.
//
// Simpler approach: we intercept queries by only inspecting the tables the
// methods were called on and reimplement filtering ourselves using known
// column access patterns. The fake .where() receives *whatever* the store
// passed; we simply capture it and invoke any attached `__test_predicate`.
// The store code itself uses drizzle helpers, but the fake ignores them and
// uses custom bound predicates we install for each query context.

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
      values: async (row: Row) => {
        target.push({ ...row })
      },
    }
  }

  select(): SelectChain {
    return new SelectChain(this)
  }

  update(t: unknown): UpdateChain {
    return new UpdateChain(this, this.tableFor(t))
  }

  delete(t: unknown): DeleteChain {
    return new DeleteChain(this, this.tableFor(t))
  }
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
    if (typeof pred === 'function') this.filters.push(pred as Predicate)
    else if (
      pred &&
      typeof pred === 'object' &&
      '__pred' in pred &&
      typeof (pred as { __pred: unknown }).__pred === 'function'
    ) {
      this.filters.push((pred as { __pred: Predicate }).__pred)
    }
    return this
  }

  orderBy(expr: unknown): this {
    if (
      expr &&
      typeof expr === 'object' &&
      '__order' in expr &&
      typeof (expr as { __order: unknown }).__order === 'function'
    ) {
      this.orderFn = (expr as { __order: (a: Row, b: Row) => number }).__order
    }
    return this
  }

  limit(n: number): this {
    this.limitN = n
    return this
  }

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

  constructor(
    private readonly db: FakeDb,
    private readonly target: Row[],
  ) {
    void this.db
  }

  set(patch: Row): this {
    this.patch = patch
    return this
  }

  where(pred: unknown): this {
    if (typeof pred === 'function') this.filters.push(pred as Predicate)
    else if (
      pred &&
      typeof pred === 'object' &&
      '__pred' in pred &&
      typeof (pred as { __pred: unknown }).__pred === 'function'
    ) {
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

  constructor(
    private readonly db: FakeDb,
    private readonly target: Row[],
  ) {
    void this.db
  }

  where(pred: unknown): this {
    if (typeof pred === 'function') this.filters.push(pred as Predicate)
    else if (
      pred &&
      typeof pred === 'object' &&
      '__pred' in pred &&
      typeof (pred as { __pred: unknown }).__pred === 'function'
    ) {
      this.filters.push((pred as { __pred: Predicate }).__pred)
    }
    return this
  }

  then<T>(onFulfilled: (result: { rowCount: number }) => T): Promise<T> {
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

// ---------------------------------------------------------------------------
// Mock drizzle-orm helpers so the store's queries evaluate against our fake
// ---------------------------------------------------------------------------

vi.mock('drizzle-orm', async () => {
  const readCol = (col: unknown, row: Row): unknown => {
    if (col && typeof col === 'object' && 'name' in col) {
      const name = (col as { name: string }).name
      // Map snake_case column names to our camelCase row keys
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
    eq: (col: unknown, val: unknown) =>
      wrap((row: Row) => readCol(col, row) === val),
    and: (...preds: Array<{ __pred: Predicate } | Predicate>) =>
      wrap((row: Row) =>
        preds.every((p) =>
          typeof p === 'function'
            ? p(row)
            : (p as { __pred: Predicate }).__pred(row),
        ),
      ),
    isNull: (col: unknown) =>
      wrap((row: Row) => {
        const v = readCol(col, row)
        return v === null || v === undefined
      }),
    lte: (col: unknown, val: unknown) =>
      wrap((row: Row) => {
        const v = readCol(col, row) as number
        return v <= (val as number)
      }),
    gt: (col: unknown, val: unknown) =>
      wrap((row: Row) => {
        const v = readCol(col, row) as number
        return v > (val as number)
      }),
    asc: (col: unknown) => ({
      __order: (a: Row, b: Row) => {
        const av = readCol(col, a) as number
        const bv = readCol(col, b) as number
        return av - bv
      },
    }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
      // Used as `sql`${col} IS NOT NULL``
      const raw = strings.join('?')
      if (raw.includes('IS NOT NULL')) {
        const col = values[0]
        return wrap((row: Row) => {
          const v = readCol(col, row)
          return v !== null && v !== undefined
        })
      }
      // TTL expression used only by mailbox.findByRecipient; not exercised.
      return wrap(() => true)
    },
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DrizzleDlqStore', () => {
  let db: FakeDb
  let store: DrizzleDlqStore

  beforeEach(() => {
    db = new FakeDb()
    store = new DrizzleDlqStore(db)
  })

  // 1. DLQ drain: enqueue 3 msgs, drain returns them ordered by nextRetryAt
  it('drains due rows ordered by nextRetryAt (oldest first)', async () => {
    const base = 1_000_000
    // Enqueue three messages at staggered `now` values so their
    // nextRetryAt = now + 30_000 differ.
    await store.enqueue(
      { id: 'm1', from: 'a', to: 'b', subject: 's1', body: {}, createdAt: base },
      'rate_limit',
      base,
    )
    await store.enqueue(
      { id: 'm2', from: 'a', to: 'b', subject: 's2', body: {}, createdAt: base + 5 },
      'rate_limit',
      base + 5,
    )
    await store.enqueue(
      { id: 'm3', from: 'a', to: 'b', subject: 's3', body: {}, createdAt: base + 10 },
      'rate_limit',
      base + 10,
    )

    // All three are due once we are past the largest nextRetryAt.
    const later = base + 30_000 + 100
    const drained = await store.drain(10, later)
    expect(drained.length).toBe(3)
    expect(drained.map((r) => r.originalMessageId)).toEqual(['m1', 'm2', 'm3'])
    // Ordering assertion: nextRetryAt is monotonically non-decreasing.
    for (let i = 1; i < drained.length; i++) {
      expect(drained[i]!.nextRetryAt).toBeGreaterThanOrEqual(
        drained[i - 1]!.nextRetryAt,
      )
    }
  })

  // 2. Redeliver: redeliver moves message back to agent_mailbox
  it('redelivers a DLQ row into agent_mailbox and removes it from the DLQ', async () => {
    const row = await store.enqueue(
      {
        id: 'original-42',
        from: 'sender',
        to: 'recipient',
        subject: 'hi',
        body: { n: 1 },
        createdAt: 123,
      },
      'rate_limit',
      123,
    )

    const ok = await store.redeliver(row.id)
    expect(ok).toBe(true)

    expect(db.mailbox).toHaveLength(1)
    expect(db.mailbox[0]).toMatchObject({
      id: 'original-42',
      fromAgent: 'sender',
      toAgent: 'recipient',
      subject: 'hi',
    })
    expect(db.dlq).toHaveLength(0)
  })

  it('returns false when redelivering an unknown DLQ id', async () => {
    const ok = await store.redeliver('does-not-exist')
    expect(ok).toBe(false)
  })

  // 4. Poison-message isolation: after maxAttempts, deadAt is set, drain skips it
  it('marks a row dead after max attempts and drain skips it', async () => {
    const row = await store.enqueue(
      { id: 'poison', from: 'a', to: 'b', subject: 'x', body: {}, createdAt: 1 },
      'rate_limit',
      1,
    )

    // Drive recordAttempt MAX_DLQ_ATTEMPTS times; the final call should kill it.
    let killed = false
    for (let i = 0; i < MAX_DLQ_ATTEMPTS; i++) {
      killed = await store.recordAttempt(row.id, 2 + i)
    }
    expect(killed).toBe(true)

    // Underlying row should now have deadAt set.
    const persisted = db.dlq.find((r) => r['id'] === row.id) as {
      deadAt: number | null
      attempts: number
    }
    expect(persisted).toBeDefined()
    expect(persisted.deadAt).not.toBeNull()
    expect(persisted.attempts).toBe(MAX_DLQ_ATTEMPTS)

    // drain() must skip dead rows even when nextRetryAt is far in the past.
    const drained = await store.drain(10, Number.MAX_SAFE_INTEGER)
    expect(drained.find((r) => r.id === row.id)).toBeUndefined()
  })

  it('markDead() directly sets deadAt and excludes the row from drain', async () => {
    const row = await store.enqueue(
      { id: 'm', from: 'a', to: 'b', subject: 's', body: {}, createdAt: 1 },
      'rate_limit',
      1,
    )
    await store.markDead(row.id, 9_999)
    const drained = await store.drain(10, Number.MAX_SAFE_INTEGER)
    expect(drained).toHaveLength(0)
  })

  it('listDead returns only dead rows for a recipient', async () => {
    const r1 = await store.enqueue(
      { id: 'a', from: 'x', to: 'bob', subject: 's', body: {}, createdAt: 1 },
      'rate_limit',
      1,
    )
    await store.enqueue(
      { id: 'b', from: 'x', to: 'bob', subject: 's', body: {}, createdAt: 2 },
      'rate_limit',
      2,
    )
    await store.markDead(r1.id, 100)

    const dead = await store.listDead('bob')
    expect(dead).toHaveLength(1)
    expect(dead[0]!.originalMessageId).toBe('a')
  })
})

// ---------------------------------------------------------------------------
// 3. Rate-limit overflow: 11th message in 1 min goes to DLQ not mailbox
// ---------------------------------------------------------------------------

describe('DrizzleMailboxStore + MailRateLimiter + DrizzleDlqStore', () => {
  it('sends the 11th message within a minute to the DLQ, not the mailbox', async () => {
    const db = new FakeDb()
    const dlq = new DrizzleDlqStore(db)
    // Fixed clock so refill is zero across the 11 calls.
    const fixedNow = 1_700_000_000_000
    const limiter = new MailRateLimiter({
      capacity: 10,
      refillPerMinute: 10,
      now: () => fixedNow,
    })
    const mailbox = new DrizzleMailboxStore(db, { rateLimiter: limiter, dlq })

    // First 10 succeed.
    for (let i = 0; i < 10; i++) {
      await mailbox.save({
        id: `msg-${i}`,
        from: 'sender',
        to: 'popular-recipient',
        subject: 's',
        body: { i },
        createdAt: fixedNow,
      })
    }

    expect(db.mailbox).toHaveLength(10)
    expect(db.dlq).toHaveLength(0)

    // 11th throws and lands in DLQ.
    await expect(
      mailbox.save({
        id: 'msg-10',
        from: 'sender',
        to: 'popular-recipient',
        subject: 's',
        body: { i: 10 },
        createdAt: fixedNow,
      }),
    ).rejects.toBeInstanceOf(MailRateLimitError)

    expect(db.mailbox).toHaveLength(10)
    expect(db.dlq).toHaveLength(1)
    expect(db.dlq[0]).toMatchObject({
      originalMessageId: 'msg-10',
      fromAgent: 'sender',
      toAgent: 'popular-recipient',
      failReason: 'rate_limit',
      attempts: 0,
    })
  })
})
