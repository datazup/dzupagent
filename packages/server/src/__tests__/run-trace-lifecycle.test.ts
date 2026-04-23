/**
 * Integration tests for DrizzleRunTraceStore wiring into the run lifecycle.
 *
 * Covers:
 *   1. GET /api/runs/:id/trace returns trace steps when a traceStore is configured
 *   2. GET /api/runs/:id/trace omits the trace field when no traceStore is configured
 *   3. DrizzleRunTraceStore.startTrace + getTrace round-trip stores runId+agentId
 *   4. DrizzleRunTraceStore auto-increments stepIndex across sequential addStep calls
 *   5. DrizzleRunTraceStore.completeTrace + getTrace round-trips completedAt
 *   6. run-trace.ts route correctly awaits the async DrizzleRunTraceStore (regression test
 *      for the Promise-as-truthy bug where `!promise` was always false)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import { InMemoryRunTraceStore } from '../persistence/run-trace-store.js'
import { DrizzleRunTraceStore } from '../persistence/drizzle-run-trace-store.js'
import { runTraces, traceSteps } from '../persistence/drizzle-schema.js'

// ---------------------------------------------------------------------------
// Minimal in-memory fake Drizzle client (mirrors drizzle-run-trace-store.test.ts)
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

  insert(t: unknown) {
    const target = this.tableFor(t)
    return {
      values: async (row: Row) => {
        target.push({ ...row })
      },
    }
  }

  select() {
    return new SelectChain(this)
  }

  update(t: unknown) {
    return new UpdateChain(this.tableFor(t))
  }

  delete(t: unknown) {
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

  const wrap = (pred: Predicate) => ({ __pred: pred })

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
// Shared fixtures
// ---------------------------------------------------------------------------

function buildConfigWithTraceStore(): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    traceStore: new InMemoryRunTraceStore(),
  }
}

function buildConfigWithoutTraceStore(): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('D4: run lifecycle wiring — DrizzleRunTraceStore', () => {
  describe('GET /api/runs/:id/trace integration', () => {
    let config: ForgeServerConfig
    let app: ReturnType<typeof createForgeApp>
    let runId: string

    beforeEach(async () => {
      config = buildConfigWithTraceStore()
      app = createForgeApp(config)

      await config.agentStore.save({
        id: 'agent-trace',
        name: 'Trace Agent',
        instructions: 'test',
        modelTier: 'chat',
      })

      const run = await config.runStore.create({ agentId: 'agent-trace', input: 'hello' })
      runId = run.id

      const traceStore = config.traceStore as InMemoryRunTraceStore
      traceStore.startTrace(runId, 'agent-trace')
      traceStore.addStep(runId, { timestamp: 100, type: 'user_input', content: 'hi' })
      traceStore.addStep(runId, { timestamp: 200, type: 'output', content: 'done' })
      traceStore.completeTrace(runId)
    })

    // Test 1
    it('includes structured trace.steps when traceStore is configured', async () => {
      const res = await app.request(`/api/runs/${runId}/trace`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { trace?: { steps: unknown[]; totalSteps: number } }
      }
      expect(body.data.trace).toBeDefined()
      expect(body.data.trace!.totalSteps).toBe(2)
      expect(body.data.trace!.steps).toHaveLength(2)
    })

    // Test 2
    it('omits trace field when no traceStore is configured', async () => {
      const cfg = buildConfigWithoutTraceStore()
      const app2 = createForgeApp(cfg)
      await cfg.agentStore.save({
        id: 'agent-notrace',
        name: 'NoTrace',
        instructions: 'x',
        modelTier: 'chat',
      })
      const run = await cfg.runStore.create({ agentId: 'agent-notrace', input: 'x' })

      const res = await app2.request(`/api/runs/${run.id}/trace`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { trace?: unknown } }
      expect(body.data.trace).toBeUndefined()
    })
  })

  describe('DrizzleRunTraceStore round-trips via getTrace', () => {
    let db: FakeDb
    let store: DrizzleRunTraceStore

    beforeEach(() => {
      db = new FakeDb()
      store = new DrizzleRunTraceStore(db)
    })

    // Test 3
    it('startTrace + getTrace round-trips runId and agentId', async () => {
      await store.startTrace('run-rt1', 'agent-rt1')
      const trace = await store.getTrace('run-rt1')
      expect(trace).not.toBeNull()
      expect(trace!.runId).toBe('run-rt1')
      expect(trace!.agentId).toBe('agent-rt1')
      expect(trace!.totalSteps).toBe(0)
      expect(trace!.steps).toEqual([])
    })

    // Test 4
    it('addStep auto-increments stepIndex across sequential calls', async () => {
      await store.startTrace('run-rt2', 'agent-rt2')
      await store.addStep('run-rt2', { timestamp: 1, type: 'user_input', content: 'a' })
      await store.addStep('run-rt2', { timestamp: 2, type: 'llm_response', content: 'b' })
      await store.addStep('run-rt2', { timestamp: 3, type: 'output', content: 'c' })

      const trace = await store.getTrace('run-rt2')
      expect(trace).not.toBeNull()
      expect(trace!.totalSteps).toBe(3)
      expect(trace!.steps.map((s) => s.stepIndex)).toEqual([0, 1, 2])
    })

    // Test 5
    it('completeTrace + getTrace round-trips completedAt timestamp', async () => {
      await store.startTrace('run-rt3', 'agent-rt3')
      const before = Date.now()
      await store.completeTrace('run-rt3')
      const after = Date.now()

      const trace = await store.getTrace('run-rt3')
      expect(trace).not.toBeNull()
      expect(typeof trace!.completedAt).toBe('number')
      expect(trace!.completedAt!).toBeGreaterThanOrEqual(before)
      expect(trace!.completedAt!).toBeLessThanOrEqual(after)
    })

    // Test 6 — regression test: the route awaits the Promise returned by an
    // async traceStore. If the route forgot to await (as was the original bug
    // in run-trace.ts), getTrace() would return a Promise that is truthy even
    // for a missing trace, and !trace would never trigger the 404 branch.
    it('regression: route awaits async getTrace and returns 404 when trace is absent', async () => {
      const cfg: ForgeServerConfig = {
        runStore: new InMemoryRunStore(),
        agentStore: new InMemoryAgentStore(),
        eventBus: createEventBus(),
        modelRegistry: new ModelRegistry(),
        traceStore: store as unknown as InMemoryRunTraceStore,
      }
      const app = createForgeApp(cfg)

      await cfg.agentStore.save({
        id: 'agent-async',
        name: 'Async',
        instructions: 'x',
        modelTier: 'chat',
      })
      const run = await cfg.runStore.create({ agentId: 'agent-async', input: 'x' })

      // No trace was started for this run — the route MUST await the
      // (async) getTrace call and resolve `null` before producing 404.
      const res = await app.request(`/api/runs/${run.id}/messages`)
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('NOT_FOUND')
    })
  })
})
