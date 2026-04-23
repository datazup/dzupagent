/**
 * Unit tests for PostgresRunStore covering all 7 RunStore interface methods.
 *
 * Mocks the Drizzle PostgresJsDatabase fluent API with vi.fn() so tests run
 * without any real database connection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PostgresRunStore } from '../postgres-stores.js'
import type { LogEntry } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Chainable Drizzle mock (compact, local to this file)
// ---------------------------------------------------------------------------

interface CallLogEntry {
  op: string
  fn: string
  args: unknown[]
}

function makeChain(terminal: unknown, op: string, log: CallLogEntry[]): object {
  const cache: Record<string, unknown> = {}
  const handler: ProxyHandler<() => unknown> = {
    get(_target, prop: string) {
      if (prop === 'then') {
        return (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve(terminal).then(onFulfilled)
      }
      if (prop in cache) return cache[prop]
      const fn = (...args: unknown[]): unknown => {
        log.push({ op, fn: prop, args })
        return makeChain(terminal, op, log)
      }
      cache[prop] = fn
      return fn
    },
  }
  return new Proxy(function noop() {}, handler)
}

interface MockDbOptions {
  selectRows?: unknown[]
  insertRows?: unknown[]
  updateRows?: unknown[]
  deleteRows?: unknown[]
  log?: CallLogEntry[]
}

function buildMockDb(options: MockDbOptions = {}): {
  select: ReturnType<typeof vi.fn>
  insert: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  log: CallLogEntry[]
} {
  const log = options.log ?? []
  return {
    select: vi.fn(() => makeChain(options.selectRows ?? [], 'select', log)),
    insert: vi.fn(() => makeChain(options.insertRows ?? [], 'insert', log)),
    update: vi.fn(() => makeChain(options.updateRows ?? [], 'update', log)),
    delete: vi.fn(() => makeChain(options.deleteRows ?? [], 'delete', log)),
    log,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostgresRunStore (persistence/__tests__)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -------- create --------

  describe('create()', () => {
    it('inserts a row with agentId, status=queued, and returns a mapped Run', async () => {
      const row = {
        id: 'run-A',
        agentId: 'agent-A',
        status: 'queued',
        input: { ask: 'ping' },
        output: null,
        plan: null,
        tokenUsageInput: 0,
        tokenUsageOutput: 0,
        costCents: null,
        error: null,
        metadata: {},
        startedAt: new Date('2026-04-20T00:00:00Z'),
        completedAt: null,
      }
      const db = buildMockDb({ insertRows: [row] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = new PostgresRunStore(db as any)

      const created = await store.create({ agentId: 'agent-A', input: { ask: 'ping' } })

      expect(db.insert).toHaveBeenCalledTimes(1)
      const valuesCall = db.log.find((l) => l.op === 'insert' && l.fn === 'values')
      expect(valuesCall).toBeDefined()
      const values = valuesCall!.args[0] as Record<string, unknown>
      expect(values['agentId']).toBe('agent-A')
      expect(values['status']).toBe('queued')
      expect(values['input']).toEqual({ ask: 'ping' })
      expect(created.id).toBe('run-A')
      expect(created.status).toBe('queued')
    })

    it('forwards provided metadata into insert values', async () => {
      const row = {
        id: 'r', agentId: 'a', status: 'queued', input: null,
        output: null, plan: null, tokenUsageInput: 0, tokenUsageOutput: 0,
        costCents: null, error: null, metadata: { foo: 'bar' },
        startedAt: new Date(), completedAt: null,
      }
      const db = buildMockDb({ insertRows: [row] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = new PostgresRunStore(db as any)

      await store.create({ agentId: 'a', input: null, metadata: { foo: 'bar' } })

      const valuesCall = db.log.find((l) => l.op === 'insert' && l.fn === 'values')
      const values = valuesCall!.args[0] as Record<string, unknown>
      expect(values['metadata']).toEqual({ foo: 'bar' })
    })
  })

  // -------- update --------

  describe('update()', () => {
    it('is a no-op when no fields are supplied', async () => {
      const db = buildMockDb()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = new PostgresRunStore(db as any)

      await store.update('run-1', {})

      expect(db.update).not.toHaveBeenCalled()
    })

    it('splits tokenUsage into two columns and forwards other fields', async () => {
      const db = buildMockDb()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = new PostgresRunStore(db as any)
      const completedAt = new Date('2026-04-20T12:00:00Z')

      await store.update('run-2', {
        status: 'completed',
        output: { answer: 42 },
        tokenUsage: { input: 300, output: 120 },
        costCents: 5,
        completedAt,
      })

      expect(db.update).toHaveBeenCalledTimes(1)
      const setCall = db.log.find((l) => l.op === 'update' && l.fn === 'set')
      expect(setCall).toBeDefined()
      const values = setCall!.args[0] as Record<string, unknown>
      expect(values['status']).toBe('completed')
      expect(values['output']).toEqual({ answer: 42 })
      expect(values['tokenUsageInput']).toBe(300)
      expect(values['tokenUsageOutput']).toBe(120)
      expect(values['costCents']).toBe(5)
      expect(values['completedAt']).toBe(completedAt)
    })
  })

  // -------- get --------

  describe('get()', () => {
    it('returns a mapped Run when a row is found', async () => {
      const row = {
        id: 'run-G', agentId: 'agent-G', status: 'completed',
        input: { q: 1 }, output: { r: 2 }, plan: null,
        tokenUsageInput: 11, tokenUsageOutput: 22, costCents: 7,
        error: null, metadata: { tag: 'x' },
        startedAt: new Date(), completedAt: new Date(),
      }
      const db = buildMockDb({ selectRows: [row] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = new PostgresRunStore(db as any)

      const run = await store.get('run-G')

      expect(db.select).toHaveBeenCalledTimes(1)
      expect(run).not.toBeNull()
      expect(run!.id).toBe('run-G')
      expect(run!.tokenUsage).toEqual({ input: 11, output: 22 })
      expect(run!.metadata).toEqual({ tag: 'x' })
    })

    it('returns null when no row matches', async () => {
      const db = buildMockDb({ selectRows: [] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = new PostgresRunStore(db as any)

      expect(await store.get('missing')).toBeNull()
    })
  })

  // -------- list --------

  describe('list()', () => {
    it('applies default limit=50 and offset=0 when filter is omitted', async () => {
      const db = buildMockDb({ selectRows: [] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = new PostgresRunStore(db as any)

      const runs = await store.list()

      expect(runs).toEqual([])
      const limitCall = db.log.find((l) => l.op === 'select' && l.fn === 'limit')
      const offsetCall = db.log.find((l) => l.op === 'select' && l.fn === 'offset')
      expect(limitCall!.args[0]).toBe(50)
      expect(offsetCall!.args[0]).toBe(0)
    })

    it('respects filter.agentId, filter.status, filter.limit, filter.offset', async () => {
      const db = buildMockDb({ selectRows: [] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = new PostgresRunStore(db as any)

      await store.list({ agentId: 'a-1', status: 'running', limit: 7, offset: 3 })

      const limitCall = db.log.find((l) => l.op === 'select' && l.fn === 'limit')
      const offsetCall = db.log.find((l) => l.op === 'select' && l.fn === 'offset')
      expect(limitCall!.args[0]).toBe(7)
      expect(offsetCall!.args[0]).toBe(3)
      expect(db.select).toHaveBeenCalledTimes(1)
    })

    it('maps each row through toRun()', async () => {
      const now = new Date()
      const rows = [
        { id: '1', agentId: 'a', status: 'completed', input: null, output: null, plan: null, tokenUsageInput: 0, tokenUsageOutput: 0, costCents: null, error: null, metadata: null, startedAt: now, completedAt: null },
        { id: '2', agentId: 'a', status: 'failed', input: null, output: null, plan: null, tokenUsageInput: 0, tokenUsageOutput: 0, costCents: null, error: 'oops', metadata: null, startedAt: now, completedAt: null },
      ]
      const db = buildMockDb({ selectRows: rows })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = new PostgresRunStore(db as any)

      const runs = await store.list()

      expect(runs).toHaveLength(2)
      expect(runs[0]!.id).toBe('1')
      expect(runs[1]!.error).toBe('oops')
    })
  })

  // -------- addLog --------

  describe('addLog()', () => {
    it('inserts a single log entry with runId, level, message', async () => {
      const db = buildMockDb()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = new PostgresRunStore(db as any)
      const entry: LogEntry = { level: 'info', message: 'started' }

      await store.addLog('run-X', entry)

      expect(db.insert).toHaveBeenCalledTimes(1)
      const valuesCall = db.log.find((l) => l.op === 'insert' && l.fn === 'values')
      const values = valuesCall!.args[0] as Record<string, unknown>
      expect(values['runId']).toBe('run-X')
      expect(values['level']).toBe('info')
      expect(values['message']).toBe('started')
      expect(values['phase']).toBeNull()
    })

    it('uses supplied phase, data, and timestamp when provided', async () => {
      const db = buildMockDb()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = new PostgresRunStore(db as any)
      const ts = new Date('2026-04-20T08:00:00Z')

      await store.addLog('run-X', {
        level: 'error',
        phase: 'tool_call',
        message: 'fail',
        data: { retry: 1 },
        timestamp: ts,
      })

      const valuesCall = db.log.find((l) => l.op === 'insert' && l.fn === 'values')
      const values = valuesCall!.args[0] as Record<string, unknown>
      expect(values['phase']).toBe('tool_call')
      expect(values['data']).toEqual({ retry: 1 })
      expect(values['timestamp']).toBe(ts)
    })
  })

  // -------- addLogs --------

  describe('addLogs()', () => {
    it('no-ops on empty array without invoking insert', async () => {
      const db = buildMockDb()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = new PostgresRunStore(db as any)

      await store.addLogs('run-1', [])

      expect(db.insert).not.toHaveBeenCalled()
    })

    it('inserts all entries in a single batch call', async () => {
      const db = buildMockDb()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = new PostgresRunStore(db as any)

      await store.addLogs('run-1', [
        { level: 'info', message: 'a' },
        { level: 'warn', message: 'b' },
        { level: 'error', message: 'c' },
      ])

      expect(db.insert).toHaveBeenCalledTimes(1)
      const valuesCall = db.log.find((l) => l.op === 'insert' && l.fn === 'values')
      const values = valuesCall!.args[0] as Array<Record<string, unknown>>
      expect(values).toHaveLength(3)
      expect(values[0]!['message']).toBe('a')
      expect(values[1]!['level']).toBe('warn')
      expect(values[2]!['level']).toBe('error')
      // Every row should share the same runId
      for (const v of values) {
        expect(v['runId']).toBe('run-1')
      }
    })
  })

  // -------- getLogs --------

  describe('getLogs()', () => {
    it('returns empty array when no rows exist', async () => {
      const db = buildMockDb({ selectRows: [] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = new PostgresRunStore(db as any)

      expect(await store.getLogs('run-1')).toEqual([])
    })

    it('maps rows to LogEntry with undefined for null phase/data', async () => {
      const ts = new Date()
      const db = buildMockDb({
        selectRows: [
          { level: 'info', phase: 'start', message: 'hello', data: { k: 1 }, timestamp: ts },
          { level: 'error', phase: null, message: 'boom', data: null, timestamp: ts },
        ],
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = new PostgresRunStore(db as any)

      const logs = await store.getLogs('run-1')

      expect(logs).toHaveLength(2)
      expect(logs[0]!.phase).toBe('start')
      expect(logs[0]!.data).toEqual({ k: 1 })
      expect(logs[1]!.phase).toBeUndefined()
      expect(logs[1]!.data).toBeUndefined()
      expect(logs[1]!.timestamp).toBe(ts)
    })
  })
})
