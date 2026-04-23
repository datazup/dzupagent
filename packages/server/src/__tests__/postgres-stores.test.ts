/**
 * Tests for PostgresRunStore, PostgresAgentStore, and DrizzleVectorStore
 * using a hand-rolled chainable mock of the Drizzle PostgresJsDatabase fluent
 * API. No real database connection is required.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  PostgresRunStore,
  PostgresAgentStore,
  DrizzleVectorStore,
} from '../persistence/postgres-stores.js'
import type { AgentExecutionSpec, LogEntry } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Chainable Drizzle mock
// ---------------------------------------------------------------------------

/**
 * Build a chainable mock object whose every accessor returns itself or a
 * user-provided terminal value. Supports await-on-chain (thenable) so we can
 * resolve queries like `db.select().from(t).where(...).limit(1)`.
 */
interface Terminal<T> {
  thenValue: T
}

function isTerminal<T>(v: unknown): v is Terminal<T> {
  return typeof v === 'object' && v !== null && 'thenValue' in (v as object)
}

function makeChain(terminal: unknown, onCall?: (fnName: string, args: unknown[]) => void): object {
  const seen: Record<string, unknown> = {}
  const handler: ProxyHandler<() => unknown> = {
    get(_target, prop: string) {
      if (prop === 'then') {
        // Make awaitable: resolve the terminal value
        const t = isTerminal(terminal) ? terminal.thenValue : terminal
        return (onFulfilled: (v: unknown) => unknown) => Promise.resolve(t).then(onFulfilled)
      }
      if (prop in seen) return seen[prop]
      const fn = (...args: unknown[]): unknown => {
        onCall?.(prop, args)
        return makeChain(terminal, onCall)
      }
      seen[prop] = fn
      return fn
    },
    apply() {
      return makeChain(terminal, onCall)
    },
  }
  return new Proxy(function proxyFn() {}, handler)
}

/**
 * Build a mock DB where each top-level operation (select/insert/update/delete)
 * returns a chain that ultimately resolves to the given rows array.
 * Calls are recorded into `log`.
 */
function buildMockDb(options: {
  selectRows?: unknown[]
  insertRows?: unknown[]
  updateRows?: unknown[]
  deleteRows?: unknown[]
  log?: Array<{ op: string; fn: string; args: unknown[] }>
} = {}): object {
  const log = options.log ?? []

  const makeOp = (op: string, rows: unknown[]) => {
    const onCall = (fn: string, args: unknown[]): void => {
      log.push({ op, fn, args })
    }
    return makeChain(rows, onCall)
  }

  return {
    select: vi.fn(() => makeOp('select', options.selectRows ?? [])),
    selectDistinct: vi.fn(() => makeOp('selectDistinct', options.selectRows ?? [])),
    insert: vi.fn(() => makeOp('insert', options.insertRows ?? [])),
    update: vi.fn(() => makeOp('update', options.updateRows ?? [])),
    delete: vi.fn(() => makeOp('delete', options.deleteRows ?? [])),
  }
}

// ---------------------------------------------------------------------------
// PostgresRunStore
// ---------------------------------------------------------------------------

describe('PostgresRunStore', () => {
  describe('create()', () => {
    it('inserts a run with status=queued and returns a mapped Run', async () => {
      const mockRow = {
        id: 'run-1',
        agentId: 'agent-1',
        status: 'queued',
        input: { q: 'hello' },
        output: null,
        plan: null,
        tokenUsageInput: 0,
        tokenUsageOutput: 0,
        costCents: null,
        error: null,
        metadata: {},
        startedAt: new Date('2026-04-01'),
        completedAt: null,
      }
      const db = buildMockDb({ insertRows: [mockRow] })
      const store = new PostgresRunStore(db)

      const run = await store.create({ agentId: 'agent-1', input: { q: 'hello' } })

      expect(db.insert).toHaveBeenCalledTimes(1)
      expect(run.id).toBe('run-1')
      expect(run.agentId).toBe('agent-1')
      expect(run.status).toBe('queued')
      expect(run.input).toEqual({ q: 'hello' })
    })

    it('defaults metadata to empty object when omitted', async () => {
      const mockRow = {
        id: 'run-2',
        agentId: 'agent-2',
        status: 'queued',
        input: 'raw input',
        output: null,
        plan: null,
        tokenUsageInput: null,
        tokenUsageOutput: null,
        costCents: null,
        error: null,
        metadata: {},
        startedAt: new Date(),
        completedAt: null,
      }
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ insertRows: [mockRow], log })
      const store = new PostgresRunStore(db)

      await store.create({ agentId: 'agent-2', input: 'raw input' })

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      expect(valuesCall).toBeDefined()
      const values = valuesCall!.args[0] as Record<string, unknown>
      expect(values['metadata']).toEqual({})
      expect(values['status']).toBe('queued')
    })

    it('forwards provided metadata into insert values', async () => {
      const mockRow = {
        id: 'run-3', agentId: 'a', status: 'queued', input: null,
        output: null, plan: null, tokenUsageInput: 0, tokenUsageOutput: 0,
        costCents: null, error: null, metadata: { foo: 'bar' },
        startedAt: new Date(), completedAt: null,
      }
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ insertRows: [mockRow], log })
      const store = new PostgresRunStore(db)

      await store.create({ agentId: 'a', input: null, metadata: { foo: 'bar' } })

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const values = valuesCall!.args[0] as Record<string, unknown>
      expect(values['metadata']).toEqual({ foo: 'bar' })
    })
  })

  describe('update()', () => {
    it('issues no update when no fields are provided', async () => {
      const db = buildMockDb()
      const store = new PostgresRunStore(db)

      await store.update('run-1', {})

      expect(db.update).not.toHaveBeenCalled()
    })

    it('updates status field only when provided', async () => {
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ log })
      const store = new PostgresRunStore(db)

      await store.update('run-1', { status: 'completed' })

      expect(db.update).toHaveBeenCalledTimes(1)
      const setCall = log.find((l) => l.op === 'update' && l.fn === 'set')
      expect(setCall).toBeDefined()
      expect(setCall!.args[0]).toEqual({ status: 'completed' })
    })

    it('splits tokenUsage into tokenUsageInput + tokenUsageOutput', async () => {
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ log })
      const store = new PostgresRunStore(db)

      await store.update('run-1', { tokenUsage: { input: 100, output: 50 } })

      const setCall = log.find((l) => l.op === 'update' && l.fn === 'set')
      const values = setCall!.args[0] as Record<string, unknown>
      expect(values['tokenUsageInput']).toBe(100)
      expect(values['tokenUsageOutput']).toBe(50)
    })

    it('propagates error, plan, output, costCents, completedAt, metadata', async () => {
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ log })
      const store = new PostgresRunStore(db)
      const completedAt = new Date('2026-04-02')

      await store.update('run-9', {
        error: 'boom',
        plan: { steps: [] },
        output: 'done',
        costCents: 42,
        completedAt,
        metadata: { retries: 3 },
      })

      const setCall = log.find((l) => l.op === 'update' && l.fn === 'set')
      const values = setCall!.args[0] as Record<string, unknown>
      expect(values['error']).toBe('boom')
      expect(values['plan']).toEqual({ steps: [] })
      expect(values['output']).toBe('done')
      expect(values['costCents']).toBe(42)
      expect(values['completedAt']).toBe(completedAt)
      expect(values['metadata']).toEqual({ retries: 3 })
    })
  })

  describe('get()', () => {
    it('returns a mapped Run when the row exists', async () => {
      const row = {
        id: 'run-7', agentId: 'agent-7', status: 'completed',
        input: { q: 'x' }, output: { y: 1 }, plan: null,
        tokenUsageInput: 10, tokenUsageOutput: 5, costCents: 12,
        error: null, metadata: { k: 'v' },
        startedAt: new Date('2026-04-01'),
        completedAt: new Date('2026-04-02'),
      }
      const db = buildMockDb({ selectRows: [row] })
      const store = new PostgresRunStore(db)

      const run = await store.get('run-7')

      expect(run).not.toBeNull()
      expect(run!.id).toBe('run-7')
      expect(run!.output).toEqual({ y: 1 })
      expect(run!.tokenUsage).toEqual({ input: 10, output: 5 })
      expect(run!.costCents).toBe(12)
    })

    it('returns null when no row is found', async () => {
      const db = buildMockDb({ selectRows: [] })
      const store = new PostgresRunStore(db)

      const run = await store.get('missing')

      expect(run).toBeNull()
    })

    it('omits tokenUsage when both counters are zero', async () => {
      const row = {
        id: 'r', agentId: 'a', status: 'queued', input: null, output: null,
        plan: null, tokenUsageInput: 0, tokenUsageOutput: 0, costCents: null,
        error: null, metadata: null, startedAt: new Date(), completedAt: null,
      }
      const db = buildMockDb({ selectRows: [row] })
      const store = new PostgresRunStore(db)

      const run = await store.get('r')

      expect(run!.tokenUsage).toBeUndefined()
    })
  })

  describe('list()', () => {
    it('returns an empty array when no rows exist', async () => {
      const db = buildMockDb({ selectRows: [] })
      const store = new PostgresRunStore(db)

      const runs = await store.list()

      expect(runs).toEqual([])
    })

    it('maps each row to a Run', async () => {
      const rows = [
        { id: 'a', agentId: 'ag', status: 'completed', input: null, output: null, plan: null, tokenUsageInput: 0, tokenUsageOutput: 0, costCents: null, error: null, metadata: null, startedAt: new Date(), completedAt: null },
        { id: 'b', agentId: 'ag', status: 'failed', input: null, output: null, plan: null, tokenUsageInput: 0, tokenUsageOutput: 0, costCents: null, error: 'boom', metadata: null, startedAt: new Date(), completedAt: null },
      ]
      const db = buildMockDb({ selectRows: rows })
      const store = new PostgresRunStore(db)

      const runs = await store.list()

      expect(runs).toHaveLength(2)
      expect(runs[0]!.id).toBe('a')
      expect(runs[1]!.error).toBe('boom')
    })

    it('applies limit and offset from filter', async () => {
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ selectRows: [], log })
      const store = new PostgresRunStore(db)

      await store.list({ limit: 5, offset: 10 })

      const limitCall = log.find((l) => l.op === 'select' && l.fn === 'limit')
      const offsetCall = log.find((l) => l.op === 'select' && l.fn === 'offset')
      expect(limitCall!.args[0]).toBe(5)
      expect(offsetCall!.args[0]).toBe(10)
    })

    it('defaults to limit=50 offset=0 when not provided', async () => {
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ selectRows: [], log })
      const store = new PostgresRunStore(db)

      await store.list()

      const limitCall = log.find((l) => l.op === 'select' && l.fn === 'limit')
      const offsetCall = log.find((l) => l.op === 'select' && l.fn === 'offset')
      expect(limitCall!.args[0]).toBe(50)
      expect(offsetCall!.args[0]).toBe(0)
    })

    it('applies agentId and status filters via where clause', async () => {
      const db = buildMockDb({ selectRows: [] })
      const store = new PostgresRunStore(db)

      await store.list({ agentId: 'a1', status: 'running' })

      // where was called — we can't easily inspect SQL shape but call must succeed
      expect(db.select).toHaveBeenCalled()
    })
  })

  describe('addLog()', () => {
    it('inserts a single log entry', async () => {
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ log })
      const store = new PostgresRunStore(db)
      const entry: LogEntry = { level: 'info', message: 'hi' }

      await store.addLog('r1', entry)

      expect(db.insert).toHaveBeenCalledTimes(1)
      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      expect(valuesCall).toBeDefined()
      const values = valuesCall!.args[0] as Record<string, unknown>
      expect(values['runId']).toBe('r1')
      expect(values['level']).toBe('info')
      expect(values['message']).toBe('hi')
      expect(values['phase']).toBeNull()
    })

    it('uses provided timestamp and phase when supplied', async () => {
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ log })
      const store = new PostgresRunStore(db)
      const ts = new Date('2026-01-01')

      await store.addLog('r1', { level: 'error', message: 'boom', phase: 'plan', timestamp: ts })

      const values = (log.find((l) => l.op === 'insert' && l.fn === 'values')!.args[0]) as Record<string, unknown>
      expect(values['phase']).toBe('plan')
      expect(values['timestamp']).toBe(ts)
    })
  })

  describe('addLogs()', () => {
    it('no-ops when the input array is empty', async () => {
      const db = buildMockDb()
      const store = new PostgresRunStore(db)

      await store.addLogs('r1', [])

      expect(db.insert).not.toHaveBeenCalled()
    })

    it('inserts all entries in a single call', async () => {
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ log })
      const store = new PostgresRunStore(db)

      await store.addLogs('r1', [
        { level: 'info', message: 'a' },
        { level: 'warn', message: 'b' },
      ])

      expect(db.insert).toHaveBeenCalledTimes(1)
      const values = (log.find((l) => l.op === 'insert' && l.fn === 'values')!.args[0]) as Array<Record<string, unknown>>
      expect(values).toHaveLength(2)
      expect(values[0]!['level']).toBe('info')
      expect(values[1]!['level']).toBe('warn')
    })
  })

  describe('getLogs()', () => {
    it('returns an empty array when no logs exist', async () => {
      const db = buildMockDb({ selectRows: [] })
      const store = new PostgresRunStore(db)

      expect(await store.getLogs('r1')).toEqual([])
    })

    it('maps rows to LogEntry shape', async () => {
      const now = new Date()
      const db = buildMockDb({
        selectRows: [
          { level: 'info', phase: 'plan', message: 'ok', data: { k: 1 }, timestamp: now },
          { level: 'error', phase: null, message: 'bad', data: null, timestamp: now },
        ],
      })
      const store = new PostgresRunStore(db)

      const logs = await store.getLogs('r1')

      expect(logs).toHaveLength(2)
      expect(logs[0]!.phase).toBe('plan')
      expect(logs[1]!.phase).toBeUndefined()
      expect(logs[1]!.data).toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------------------
// PostgresAgentStore
// ---------------------------------------------------------------------------

describe('PostgresAgentStore', () => {
  const baseAgent: AgentExecutionSpec = {
    id: 'a1',
    name: 'Test Agent',
    instructions: 'Do things',
    modelTier: 'chat',
  }

  describe('save()', () => {
    it('inserts a new agent when no row exists', async () => {
      const db = buildMockDb({ selectRows: [] })
      const store = new PostgresAgentStore(db)

      await store.save(baseAgent)

      expect(db.insert).toHaveBeenCalledTimes(1)
      expect(db.update).not.toHaveBeenCalled()
    })

    it('updates an existing agent with incremented version', async () => {
      const existing = {
        id: 'a1', name: 'Old', description: null, instructions: 'X',
        modelTier: 'chat', tools: [], guardrails: null, approval: 'auto',
        version: 3, active: true, metadata: {},
        createdAt: new Date(), updatedAt: new Date(),
      }
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ selectRows: [existing], log })
      const store = new PostgresAgentStore(db)

      await store.save(baseAgent)

      expect(db.update).toHaveBeenCalledTimes(1)
      const setCall = log.find((l) => l.op === 'update' && l.fn === 'set')
      const values = setCall!.args[0] as Record<string, unknown>
      expect(values['version']).toBe(4)
    })

    it('defaults tools, metadata, approval, active when omitted in input', async () => {
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ selectRows: [], log })
      const store = new PostgresAgentStore(db)

      await store.save(baseAgent)

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const values = valuesCall!.args[0] as Record<string, unknown>
      expect(values['tools']).toEqual([])
      expect(values['approval']).toBe('auto')
      expect(values['active']).toBe(true)
      expect(values['metadata']).toEqual({})
      expect(values['guardrails']).toBeNull()
    })

    it('increments version from undefined to 1 on update', async () => {
      const existing = {
        id: 'a1', name: 'x', description: null, instructions: 'y',
        modelTier: 'chat', tools: [], guardrails: null, approval: 'auto',
        version: null, active: true, metadata: {},
        createdAt: new Date(), updatedAt: new Date(),
      }
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ selectRows: [existing], log })
      const store = new PostgresAgentStore(db)

      await store.save(baseAgent)

      const setCall = log.find((l) => l.op === 'update' && l.fn === 'set')
      const values = setCall!.args[0] as Record<string, unknown>
      expect(values['version']).toBe(1)
    })
  })

  describe('get()', () => {
    it('returns a mapped AgentExecutionSpec', async () => {
      const row = {
        id: 'a1', name: 'A', description: 'D', instructions: 'I',
        modelTier: 'chat', tools: ['echo'], guardrails: { max: 1 },
        approval: 'required', version: 2, active: true, metadata: { owner: 'o' },
        createdAt: new Date(), updatedAt: new Date(),
      }
      const db = buildMockDb({ selectRows: [row] })
      const store = new PostgresAgentStore(db)

      const agent = await store.get('a1')

      expect(agent).not.toBeNull()
      expect(agent!.id).toBe('a1')
      expect(agent!.tools).toEqual(['echo'])
      expect(agent!.guardrails).toEqual({ max: 1 })
      expect(agent!.approval).toBe('required')
    })

    it('returns null when no row is found', async () => {
      const db = buildMockDb({ selectRows: [] })
      const store = new PostgresAgentStore(db)

      expect(await store.get('missing')).toBeNull()
    })
  })

  describe('list()', () => {
    it('defaults limit to 100', async () => {
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ selectRows: [], log })
      const store = new PostgresAgentStore(db)

      await store.list()

      const limitCall = log.find((l) => l.op === 'select' && l.fn === 'limit')
      expect(limitCall!.args[0]).toBe(100)
    })

    it('respects filter.limit and filter.active', async () => {
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ selectRows: [], log })
      const store = new PostgresAgentStore(db)

      await store.list({ limit: 5, active: false })

      const limitCall = log.find((l) => l.op === 'select' && l.fn === 'limit')
      expect(limitCall!.args[0]).toBe(5)
    })

    it('returns mapped agents', async () => {
      const row = {
        id: 'a', name: 'n', description: null, instructions: 'i',
        modelTier: 'chat', tools: null, guardrails: null,
        approval: 'auto', version: 1, active: true, metadata: null,
        createdAt: new Date(), updatedAt: new Date(),
      }
      const db = buildMockDb({ selectRows: [row] })
      const store = new PostgresAgentStore(db)

      const agents = await store.list()

      expect(agents).toHaveLength(1)
      expect(agents[0]!.id).toBe('a')
    })
  })

  describe('delete()', () => {
    it('performs a soft delete by setting active=false', async () => {
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ log })
      const store = new PostgresAgentStore(db)

      await store.delete('a1')

      expect(db.update).toHaveBeenCalledTimes(1)
      const setCall = log.find((l) => l.op === 'update' && l.fn === 'set')
      const values = setCall!.args[0] as Record<string, unknown>
      expect(values['active']).toBe(false)
      expect(values['updatedAt']).toBeInstanceOf(Date)
    })
  })
})

// ---------------------------------------------------------------------------
// DrizzleVectorStore
// ---------------------------------------------------------------------------

describe('DrizzleVectorStore', () => {
  describe('upsert()', () => {
    it('no-ops on empty entries array', async () => {
      const db = buildMockDb()
      const store = new DrizzleVectorStore(db)

      await store.upsert('col', [])

      expect(db.insert).not.toHaveBeenCalled()
    })

    it('calls insert once per entry', async () => {
      const db = buildMockDb()
      const store = new DrizzleVectorStore(db)

      await store.upsert('col', [
        { key: 'k1', embedding: [1, 2, 3], text: 'a' },
        { key: 'k2', embedding: [4, 5, 6], text: 'b' },
      ])

      expect(db.insert).toHaveBeenCalledTimes(2)
    })

    it('defaults metadata to empty object and text to null when omitted', async () => {
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ log })
      const store = new DrizzleVectorStore(db)

      await store.upsert('col', [{ key: 'k1', embedding: [1, 2] }])

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const values = valuesCall!.args[0] as Record<string, unknown>
      expect(values['metadata']).toEqual({})
      expect(values['text']).toBeNull()
    })
  })

  describe('search()', () => {
    it('returns mapped results with distance normalised to number', async () => {
      const rows = [
        { key: 'k1', distance: '0.12', embedding: [1, 2], metadata: { a: 1 }, text: 'hi' },
        { key: 'k2', distance: '0.5', embedding: [3, 4], metadata: null, text: null },
      ]
      const db = buildMockDb({ selectRows: rows })
      const store = new DrizzleVectorStore(db)

      const results = await store.search('col', { queryVector: [1, 2] })

      expect(results).toHaveLength(2)
      expect(typeof results[0]!.distance).toBe('number')
      expect(results[0]!.distance).toBeCloseTo(0.12)
      expect(results[1]!.metadata).toEqual({})
      expect(results[1]!.text).toBeNull()
    })

    it('defaults limit to 10 and metric to cosine', async () => {
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ selectRows: [], log })
      const store = new DrizzleVectorStore(db)

      await store.search('col', { queryVector: [0] })

      const limitCall = log.find((l) => l.op === 'select' && l.fn === 'limit')
      expect(limitCall!.args[0]).toBe(10)
    })

    it('accepts l2 and inner_product metrics without throwing', async () => {
      const db = buildMockDb({ selectRows: [] })
      const store = new DrizzleVectorStore(db)

      await expect(store.search('col', { queryVector: [0], metric: 'l2' })).resolves.toBeDefined()
      await expect(store.search('col', { queryVector: [0], metric: 'inner_product' })).resolves.toBeDefined()
    })

    it('passes explicit limit through', async () => {
      const log: Array<{ op: string; fn: string; args: unknown[] }> = []
      const db = buildMockDb({ selectRows: [], log })
      const store = new DrizzleVectorStore(db)

      await store.search('col', { queryVector: [0], limit: 3 })

      const limitCall = log.find((l) => l.op === 'select' && l.fn === 'limit')
      expect(limitCall!.args[0]).toBe(3)
    })
  })

  describe('delete()', () => {
    it('issues a delete where collection+key match', async () => {
      const db = buildMockDb()
      const store = new DrizzleVectorStore(db)

      await store.delete('col', 'k1')

      expect(db.delete).toHaveBeenCalledTimes(1)
    })
  })

  describe('deleteCollection()', () => {
    it('issues a delete for the whole collection', async () => {
      const db = buildMockDb()
      const store = new DrizzleVectorStore(db)

      await store.deleteCollection('col')

      expect(db.delete).toHaveBeenCalledTimes(1)
    })
  })

  describe('listCollections()', () => {
    it('returns distinct collection names in order', async () => {
      const db = buildMockDb({ selectRows: [{ collection: 'a' }, { collection: 'b' }] })
      const store = new DrizzleVectorStore(db)

      const names = await store.listCollections()

      expect(names).toEqual(['a', 'b'])
    })

    it('returns empty array when no collections exist', async () => {
      const db = buildMockDb({ selectRows: [] })
      const store = new DrizzleVectorStore(db)

      expect(await store.listCollections()).toEqual([])
    })
  })

  describe('count()', () => {
    it('returns the count value from the first row', async () => {
      const db = buildMockDb({ selectRows: [{ count: 42 }] })
      const store = new DrizzleVectorStore(db)

      expect(await store.count('col')).toBe(42)
    })

    it('returns 0 when query returns no rows', async () => {
      const db = buildMockDb({ selectRows: [] })
      const store = new DrizzleVectorStore(db)

      expect(await store.count('col')).toBe(0)
    })
  })
})

// Used as a compile-time check that mocks resemble the fluent API.
describe('mock chain plumbing', () => {
  it('is awaitable with the provided terminal value', async () => {
    const db = buildMockDb({ selectRows: [{ foo: 1 }] })

    // Simulate the chain shape — should resolve to the terminal rows.
    const result = await db.select().from({}).where({})
    expect(result).toEqual([{ foo: 1 }])
  })

  it('records chained operation names', async () => {
    const log: Array<{ op: string; fn: string; args: unknown[] }> = []
    const db = buildMockDb({ insertRows: [], log })

    await db.insert({}).values({ a: 1 }).returning()

    expect(log.map((l) => l.fn)).toEqual(['values', 'returning'])
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })
})
