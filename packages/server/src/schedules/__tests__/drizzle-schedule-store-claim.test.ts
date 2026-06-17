/**
 * P4 HA scheduling — DrizzleScheduleStore.claimDue over an in-memory fake
 * Drizzle client.
 *
 * Mirrors the fake-Drizzle convention in
 * persistence/__tests__/postgres-durable-node-ledger.test.ts: a tiny in-memory
 * client interprets the exact fluent chains the store uses
 * (select→from→where→limit, update→set→where→returning,
 * insert→values→returning), and the drizzle-orm helpers (eq/and/lte/or) are
 * replaced with structural predicate tags.
 *
 * cron-parser is intentionally NOT mocked — the store performs real cron math
 * to compute the advanced nextRunAt.
 *
 * The load-bearing assertion: two interleaved claimDue calls over the same
 * store yield DISJOINT claimed sets (compare-and-set winner discipline), so a
 * fleet of nodes fires each due occurrence exactly once. This fake-Drizzle
 * parity test is the gate where a live Postgres is unavailable.
 */
import { describe, it, expect, vi } from 'vitest'

type Pred = (row: Record<string, unknown>) => boolean

vi.mock('drizzle-orm', () => ({
  eq:
    (col: { _col: string }, v: unknown): Pred =>
    (r) => {
      const cell = r[col._col]
      const a = cell instanceof Date ? cell.getTime() : cell
      const b = v instanceof Date ? v.getTime() : v
      return a === b
    },
  lte:
    (col: { _col: string }, v: unknown): Pred =>
    (r) => {
      const cell = r[col._col]
      const a = cell instanceof Date ? cell.getTime() : (cell as number)
      const b = v instanceof Date ? v.getTime() : (v as number)
      return a !== null && a !== undefined && a <= b
    },
  and:
    (...ps: Pred[]): Pred =>
    (r) =>
      ps.every((p) => p(r)),
  or:
    (...ps: Pred[]): Pred =>
    (r) =>
      ps.some((p) => p(r)),
}))

vi.mock('../../persistence/drizzle-schema.js', () => {
  const col = (name: string) => ({ _col: name })
  return {
    scheduleConfigs: {
      id: col('id'),
      name: col('name'),
      cronExpression: col('cronExpression'),
      workflowText: col('workflowText'),
      enabled: col('enabled'),
      metadata: col('metadata'),
      tenantId: col('tenantId'),
      nextRunAt: col('nextRunAt'),
      running: col('running'),
      claimedBy: col('claimedBy'),
      lastClaimedAt: col('lastClaimedAt'),
      lastFiredAt: col('lastFiredAt'),
      createdAt: col('createdAt'),
      updatedAt: col('updatedAt'),
    },
  }
})

const { DrizzleScheduleStore } = await import('../schedule-store.js')

// ── Fake Drizzle DB ─────────────────────────────────────────────────────────
class FakeDb {
  rows = new Map<string, Record<string, unknown>>()

  insert(_t: unknown) {
    return {
      values: (vals: Record<string, unknown>) => ({
        returning: async () => {
          const row = { ...vals }
          this.rows.set(vals.id as string, row)
          return [{ ...row }]
        },
      }),
    }
  }

  update(_t: unknown) {
    return {
      set: (patch: Record<string, unknown>) => ({
        where: (pred: Pred) => ({
          returning: async () => {
            const out: Record<string, unknown>[] = []
            for (const [key, row] of this.rows) {
              if (!pred(row)) continue
              const updated = { ...row, ...patch }
              this.rows.set(key, updated)
              out.push({ ...updated })
            }
            return out
          },
        }),
      }),
    }
  }

  select() {
    return {
      from: (_t: unknown) => ({
        where: (pred: Pred) => {
          const all = [...this.rows.values()].filter(pred)
          const result = Object.assign(Promise.resolve(all), {
            limit: async (n: number) => all.slice(0, n),
          })
          return result
        },
      }),
    }
  }
}

const EVERY_5_MIN = '*/5 * * * *'

function seedDue(db: FakeDb, id: string, nextRunAtIso: string) {
  db.rows.set(id, {
    id,
    name: id,
    cronExpression: EVERY_5_MIN,
    workflowText: 'work',
    enabled: true,
    metadata: null,
    tenantId: 'default',
    nextRunAt: new Date(nextRunAtIso),
    running: false,
    claimedBy: null,
    lastClaimedAt: null,
    lastFiredAt: null,
    createdAt: new Date('2026-06-17T00:00:00.000Z'),
    updatedAt: new Date('2026-06-17T00:00:00.000Z'),
  })
}

describe('DrizzleScheduleStore (fake Drizzle) — atomic claimDue', () => {
  it('claims a due schedule and advances nextRunAt', async () => {
    const db = new FakeDb()
    seedDue(db, 's1', '2026-06-17T10:05:00.000Z')
    const store = new DrizzleScheduleStore(db as never)

    const claimed = await store.claimDue(new Date('2026-06-17T10:06:00.000Z'), {
      limit: 10,
      claimerId: 'node-a',
      skipIfRunning: true,
    })
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.claimedBy).toBe('node-a')
    expect(claimed[0]!.occurrence.toISOString()).toBe(
      '2026-06-17T10:05:00.000Z'
    )
    expect(claimed[0]!.nextRunAt).toBe('2026-06-17T10:10:00.000Z')
    expect(claimed[0]!.running).toBe(true)
  })

  it('two interleaved claimDue calls yield disjoint claimed sets', async () => {
    const db = new FakeDb()
    seedDue(db, 's1', '2026-06-17T10:05:00.000Z')
    seedDue(db, 's2', '2026-06-17T10:05:00.000Z')
    const store = new DrizzleScheduleStore(db as never)
    const now = new Date('2026-06-17T10:06:00.000Z')

    const [a, b] = await Promise.all([
      store.claimDue(now, {
        limit: 10,
        claimerId: 'node-a',
        skipIfRunning: true,
      }),
      store.claimDue(now, {
        limit: 10,
        claimerId: 'node-b',
        skipIfRunning: true,
      }),
    ])

    const aIds = a.map((c) => c.id)
    const bIds = b.map((c) => c.id)
    // No schedule claimed by both nodes.
    expect(aIds.filter((id) => bIds.includes(id))).toEqual([])
    // Every due schedule claimed exactly once across both.
    expect([...aIds, ...bIds].sort()).toEqual(['s1', 's2'])
  })

  it('compare-and-set rejects a second claim after a concurrent winner advanced the row', async () => {
    // Worst-case race: both nodes' SELECT snapshots see s1 due (running=false,
    // nextRunAt=10:05). Node-a's UPDATE wins and advances nextRunAt + sets
    // running=true. When node-b then issues its UPDATE for the SAME stale
    // candidate, the live row no longer satisfies the claim WHERE clause
    // (nextRunAt advanced past now AND running=true), so node-b wins nothing.
    const db = new FakeDb()
    seedDue(db, 's1', '2026-06-17T10:05:00.000Z')
    const store = new DrizzleScheduleStore(db as never)
    const now = new Date('2026-06-17T10:06:00.000Z')

    // Node-a claims (mutates the live row).
    const a = await store.claimDue(now, {
      limit: 10,
      claimerId: 'node-a',
      skipIfRunning: true,
    })
    expect(a).toHaveLength(1)

    // Node-b races with the SAME due `now` against the already-advanced row.
    const b = await store.claimDue(now, {
      limit: 10,
      claimerId: 'node-b',
      skipIfRunning: true,
    })
    expect(b).toHaveLength(0)
    // The row is owned by node-a only.
    expect(db.rows.get('s1')!.claimedBy).toBe('node-a')
  })

  it('does not claim a running schedule when skipIfRunning is set', async () => {
    const db = new FakeDb()
    seedDue(db, 's1', '2026-06-17T10:05:00.000Z')
    db.rows.get('s1')!.running = true
    const store = new DrizzleScheduleStore(db as never)

    const claimed = await store.claimDue(new Date('2026-06-17T10:06:00.000Z'), {
      limit: 10,
      claimerId: 'node-a',
      skipIfRunning: true,
    })
    expect(claimed).toHaveLength(0)
  })

  it('does not claim a not-yet-due schedule', async () => {
    const db = new FakeDb()
    seedDue(db, 's1', '2026-06-17T10:10:00.000Z')
    const store = new DrizzleScheduleStore(db as never)

    const claimed = await store.claimDue(new Date('2026-06-17T10:06:00.000Z'), {
      limit: 10,
      claimerId: 'node-a',
      skipIfRunning: true,
    })
    expect(claimed).toHaveLength(0)
  })

  it('markFired clears running and stamps lastFiredAt', async () => {
    const db = new FakeDb()
    seedDue(db, 's1', '2026-06-17T10:05:00.000Z')
    db.rows.get('s1')!.running = true
    const store = new DrizzleScheduleStore(db as never)

    await store.markFired('s1', new Date('2026-06-17T10:05:00.000Z'), 'run-1')
    const row = db.rows.get('s1')!
    expect(row.running).toBe(false)
    expect(row.lastFiredAt).toBeInstanceOf(Date)
  })
})
