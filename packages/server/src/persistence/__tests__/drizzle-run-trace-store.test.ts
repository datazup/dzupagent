/**
 * Tests for {@link DrizzleRunTraceStore}.
 *
 * Uses an in-memory FakeDb that mirrors the pattern established by
 * drizzle-dlq-store.test.ts. The fake honours the fluent Drizzle API subset
 * used by the store:
 *   - insert(table).values(row)
 *   - select().from(table).where(pred).orderBy(expr).limit(n)
 *   - update(table).set(patch).where(pred)
 *   - delete(table).where(pred)
 *
 * drizzle-orm helpers (eq, and, gte, lt, asc) are mocked so that the
 * predicates produced by the store are evaluated against our in-memory arrays.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DrizzleRunTraceStore } from '../drizzle-run-trace-store.js'
import { runTraces, traceSteps } from '../drizzle-schema.js'

// ---------------------------------------------------------------------------
// Minimal in-memory fake Drizzle client
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>
type Predicate = (row: Row) => boolean

class FakeDb {
  traces: Row[] = []
  steps: Row[] = []

  private tableFor(t: unknown): Row[] {
    if (t === runTraces) return this.traces
    if (t === traceSteps) return this.steps
    throw new Error('FakeDb: unknown table')
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
    return new UpdateChain(this.tableFor(t))
  }

  delete(t: unknown): DeleteChain {
    return new DeleteChain(this.tableFor(t))
  }
}

class SelectChain {
  private rows: Row[] = []
  private filters: Predicate[] = []
  private orderFn: ((a: Row, b: Row) => number) | null = null
  private limitN: number | null = null

  constructor(private readonly db: FakeDb) {}

  from(t: unknown): this {
    if (t === runTraces) this.rows = this.db.traces
    else if (t === traceSteps) this.rows = this.db.steps
    else throw new Error('FakeDb: unknown table in from()')
    return this
  }

  where(pred: unknown): this {
    if (typeof pred === 'function') {
      this.filters.push(pred as Predicate)
    } else if (
      pred !== null &&
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
      expr !== null &&
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

  constructor(private readonly target: Row[]) {}

  set(patch: Row): this {
    this.patch = patch
    return this
  }

  where(pred: unknown): this {
    if (typeof pred === 'function') {
      this.filters.push(pred as Predicate)
    } else if (
      pred !== null &&
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

  constructor(private readonly target: Row[]) {}

  where(pred: unknown): this {
    if (typeof pred === 'function') {
      this.filters.push(pred as Predicate)
    } else if (
      pred !== null &&
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
// Mock drizzle-orm helpers
// ---------------------------------------------------------------------------

vi.mock('drizzle-orm', async () => {
  /**
   * Read a column value from a row. Columns in the schema store their
   * snake_case DB name in `.name`; our FakeDb rows use camelCase keys. This
   * map converts the DB column names used by DrizzleRunTraceStore back to the
   * camelCase keys we push into the fake arrays.
   */
  const colMap: Record<string, string> = {
    run_id: 'runId',
    agent_id: 'agentId',
    started_at: 'startedAt',
    completed_at: 'completedAt',
    total_steps: 'totalSteps',
    id: 'id',
    step_index: 'stepIndex',
    timestamp: 'timestamp',
    type: 'type',
    content: 'content',
    metadata: 'metadata',
    duration_ms: 'durationMs',
  }

  const readCol = (col: unknown, row: Row): unknown => {
    if (col !== null && typeof col === 'object' && 'name' in col) {
      const dbName = (col as { name: string }).name
      const key = colMap[dbName] ?? dbName
      return row[key]
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
    gte: (col: unknown, val: unknown) =>
      wrap((row: Row) => {
        const v = readCol(col, row) as number
        return v >= (val as number)
      }),
    lt: (col: unknown, val: unknown) =>
      wrap((row: Row) => {
        const v = readCol(col, row) as number
        return v < (val as number)
      }),
    asc: (col: unknown) => ({
      __order: (a: Row, b: Row) => {
        const av = readCol(col, a) as number
        const bv = readCol(col, b) as number
        return av - bv
      },
    }),
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<{ timestamp: number; type: string; content: unknown }> = {}) {
  return {
    timestamp: overrides.timestamp ?? Date.now(),
    type: (overrides.type ?? 'system') as
      | 'user_input'
      | 'llm_request'
      | 'llm_response'
      | 'tool_call'
      | 'tool_result'
      | 'system'
      | 'output',
    content: overrides.content ?? { text: 'hello' },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DrizzleRunTraceStore', () => {
  let db: FakeDb
  let store: DrizzleRunTraceStore

  beforeEach(() => {
    db = new FakeDb()
    store = new DrizzleRunTraceStore(db)
  })

  // 1. startTrace inserts a trace row with correct runId, agentId, startedAt, totalSteps=0
  it('startTrace inserts a trace row with correct fields and totalSteps=0', async () => {
    const before = Date.now()
    await store.startTrace('run-1', 'agent-A')
    const after = Date.now()

    expect(db.traces).toHaveLength(1)
    const row = db.traces[0]!
    expect(row['runId']).toBe('run-1')
    expect(row['agentId']).toBe('agent-A')
    expect(row['totalSteps']).toBe(0)
    expect(row['completedAt']).toBeNull()
    expect(typeof row['startedAt']).toBe('number')
    expect(row['startedAt'] as number).toBeGreaterThanOrEqual(before)
    expect(row['startedAt'] as number).toBeLessThanOrEqual(after)
  })

  // 2. addStep inserts a step with stepIndex=0 for the first step
  it('addStep inserts the first step with stepIndex=0', async () => {
    await store.startTrace('run-2', 'agent-B')
    await store.addStep('run-2', makeStep({ type: 'user_input', content: { msg: 'hi' } }))

    expect(db.steps).toHaveLength(1)
    const step = db.steps[0]!
    expect(step['runId']).toBe('run-2')
    expect(step['stepIndex']).toBe(0)
    expect(step['type']).toBe('user_input')
    expect(step['content']).toEqual({ msg: 'hi' })
  })

  // 3. addStep increments totalSteps on the trace row
  it('addStep increments totalSteps on the trace row', async () => {
    await store.startTrace('run-3', 'agent-C')
    await store.addStep('run-3', makeStep())
    await store.addStep('run-3', makeStep())

    const traceRow = db.traces.find((r) => r['runId'] === 'run-3')!
    expect(traceRow['totalSteps']).toBe(2)
  })

  // 4. Multiple addStep calls assign sequential stepIndices
  it('multiple addStep calls assign sequential stepIndices 0, 1, 2', async () => {
    await store.startTrace('run-4', 'agent-D')
    await store.addStep('run-4', makeStep({ type: 'user_input' }))
    await store.addStep('run-4', makeStep({ type: 'llm_request' }))
    await store.addStep('run-4', makeStep({ type: 'llm_response' }))

    const runSteps = db.steps.filter((s) => s['runId'] === 'run-4')
    expect(runSteps).toHaveLength(3)
    const indices = runSteps.map((s) => s['stepIndex']).sort()
    expect(indices).toEqual([0, 1, 2])
  })

  // 5. completeTrace sets completedAt on the trace row
  it('completeTrace sets completedAt on the trace row', async () => {
    await store.startTrace('run-5', 'agent-E')
    expect(db.traces[0]!['completedAt']).toBeNull()

    const before = Date.now()
    await store.completeTrace('run-5')
    const after = Date.now()

    const traceRow = db.traces.find((r) => r['runId'] === 'run-5')!
    expect(typeof traceRow['completedAt']).toBe('number')
    expect(traceRow['completedAt'] as number).toBeGreaterThanOrEqual(before)
    expect(traceRow['completedAt'] as number).toBeLessThanOrEqual(after)
  })

  // 6. getTrace returns RunTrace with steps array properly assembled
  it('getTrace returns a RunTrace with steps ordered by stepIndex', async () => {
    await store.startTrace('run-6', 'agent-F')
    await store.addStep('run-6', makeStep({ type: 'user_input', content: { n: 0 } }))
    await store.addStep('run-6', makeStep({ type: 'llm_request', content: { n: 1 } }))
    await store.completeTrace('run-6')

    const trace = await store.getTrace('run-6')
    expect(trace).not.toBeNull()
    expect(trace!.runId).toBe('run-6')
    expect(trace!.agentId).toBe('agent-F')
    expect(trace!.totalSteps).toBe(2)
    expect(typeof trace!.completedAt).toBe('number')
    expect(trace!.steps).toHaveLength(2)
    expect(trace!.steps[0]!.stepIndex).toBe(0)
    expect(trace!.steps[0]!.type).toBe('user_input')
    expect(trace!.steps[1]!.stepIndex).toBe(1)
    expect(trace!.steps[1]!.type).toBe('llm_request')
  })

  // 7. getSteps(runId, 1, 3) returns only steps at indices 1 and 2
  it('getSteps(runId, 1, 3) returns only steps at stepIndex 1 and 2', async () => {
    await store.startTrace('run-7', 'agent-G')
    await store.addStep('run-7', makeStep({ type: 'user_input' }))    // index 0
    await store.addStep('run-7', makeStep({ type: 'llm_request' }))  // index 1
    await store.addStep('run-7', makeStep({ type: 'llm_response' })) // index 2
    await store.addStep('run-7', makeStep({ type: 'tool_call' }))    // index 3

    const steps = await store.getSteps('run-7', 1, 3)
    expect(steps).toHaveLength(2)
    expect(steps[0]!.stepIndex).toBe(1)
    expect(steps[0]!.type).toBe('llm_request')
    expect(steps[1]!.stepIndex).toBe(2)
    expect(steps[1]!.type).toBe('llm_response')
  })

  // 8. deleteTrace removes both trace and step rows; getTrace returns null
  it('deleteTrace removes trace and step rows; getTrace returns null', async () => {
    await store.startTrace('run-8', 'agent-H')
    await store.addStep('run-8', makeStep())
    await store.addStep('run-8', makeStep())

    expect(db.traces).toHaveLength(1)
    expect(db.steps).toHaveLength(2)

    await store.deleteTrace('run-8')

    expect(db.traces).toHaveLength(0)
    expect(db.steps).toHaveLength(0)

    const trace = await store.getTrace('run-8')
    expect(trace).toBeNull()
  })
})
