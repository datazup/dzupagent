/**
 * Tests for DrizzleA2ATaskStore using a chainable mock Drizzle client.
 *
 * We simulate the small subset of the Drizzle fluent API that the store uses
 * (select / insert / update with .where / .orderBy / .returning) via a Proxy
 * that records operations and yields configured terminal values.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DrizzleA2ATaskStore } from '../a2a/drizzle-a2a-task-store.js'
import type { A2ATask } from '../a2a/task-handler.js'

// ---------------------------------------------------------------------------
// Chainable mock builder (mirrors the one used by postgres-stores.test.ts but
// with separate select-call sequencing for the store's multi-query methods).
// ---------------------------------------------------------------------------

interface CallLog { op: string; fn: string; args: unknown[] }

function makeChain(terminal: unknown, onCall: (fn: string, args: unknown[]) => void): Record<string, unknown> {
  const handler: ProxyHandler<() => unknown> = {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve(terminal).then(onFulfilled)
      }
      return (...args: unknown[]) => {
        onCall(prop, args)
        return makeChain(terminal, onCall)
      }
    },
  }
  return new Proxy(function proxyFn() {}, handler)
}

/**
 * Build a mock db where select() draws sequentially from the provided rows
 * arrays. Each call to `db.select()` consumes the next array; when the queue
 * is empty it returns an empty array.
 *
 * insert / update return the first queued array in their respective queues.
 */
interface MockDbConfig {
  selectSequence?: unknown[][]
  insertSequence?: unknown[][]
  updateSequence?: unknown[][]
  log?: CallLog[]
}

function buildMockDb(cfg: MockDbConfig = {}): Record<string, unknown> {
  const log = cfg.log ?? []
  const selQueue = [...(cfg.selectSequence ?? [])]
  const insQueue = [...(cfg.insertSequence ?? [])]
  const updQueue = [...(cfg.updateSequence ?? [])]

  const make = (op: string, rows: unknown[]) => {
    const onCall = (fn: string, args: unknown[]): void => {
      log.push({ op, fn, args })
    }
    return makeChain(rows, onCall)
  }

  return {
    select: vi.fn(() => make('select', selQueue.shift() ?? [])),
    insert: vi.fn(() => make('insert', insQueue.shift() ?? [])),
    update: vi.fn(() => make('update', updQueue.shift() ?? [])),
    _log: log,
  }
}

// ---------------------------------------------------------------------------
// Row factory helpers
// ---------------------------------------------------------------------------

function makeTaskRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 't1',
    agentName: 'test-agent',
    state: 'submitted',
    input: 'hello',
    output: null,
    error: null,
    metadata: null,
    pushNotificationConfig: null,
    artifacts: [],
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  }
}

function makeMessageRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    taskId: 't1',
    role: 'user',
    parts: [{ type: 'text', text: 'hi' }],
    createdAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DrizzleA2ATaskStore', () => {
  beforeEach(() => { vi.useFakeTimers().setSystemTime(new Date('2026-04-18T00:00:00Z')) })
  afterEach(() => { vi.useRealTimers() })

  describe('create()', () => {
    it('inserts a task row and returns a hydrated A2ATask', async () => {
      const row = makeTaskRow()
      const db = buildMockDb({ insertSequence: [[row]] })
      const store = new DrizzleA2ATaskStore(db)

      const task = await store.create({
        agentName: 'test-agent',
        state: 'submitted',
        input: 'hello',
      })

      expect(db.insert).toHaveBeenCalledTimes(1)
      expect(task.agentName).toBe('test-agent')
      expect(task.state).toBe('submitted')
      expect(task.messages).toEqual([])
      expect(task.artifacts).toEqual([])
      expect(task.id).toBeTruthy()
    })

    it('passes a generated uuid to the insert call', async () => {
      const log: CallLog[] = []
      const row = makeTaskRow()
      const db = buildMockDb({ insertSequence: [[row]], log })
      const store = new DrizzleA2ATaskStore(db)
      await store.create({ agentName: 'a', state: 'submitted', input: 'x' })
      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const inserted = valuesCall!.args[0] as Record<string, unknown>
      expect(typeof inserted['id']).toBe('string')
      expect((inserted['id'] as string).length).toBeGreaterThan(10)
    })

    it('serialises createdAt/updatedAt as ISO strings', async () => {
      const row = makeTaskRow()
      const db = buildMockDb({ insertSequence: [[row]] })
      const store = new DrizzleA2ATaskStore(db)
      const task = await store.create({ agentName: 'a', state: 'submitted', input: 'x' })
      expect(typeof task.createdAt).toBe('string')
      expect(typeof task.updatedAt).toBe('string')
    })

    it('propagates output, error, metadata, pushNotificationConfig when provided', async () => {
      const row = makeTaskRow({
        output: { r: 1 },
        error: 'nope',
        metadata: { k: 'v' },
        pushNotificationConfig: { url: 'https://hook' },
      })
      const db = buildMockDb({ insertSequence: [[row]] })
      const store = new DrizzleA2ATaskStore(db)

      const task = await store.create({
        agentName: 'a', state: 'submitted', input: 'x',
        output: { r: 1 }, error: 'nope', metadata: { k: 'v' },
        pushNotificationConfig: { url: 'https://hook' },
      })

      expect(task.output).toEqual({ r: 1 })
      expect(task.error).toBe('nope')
      expect(task.metadata).toEqual({ k: 'v' })
      expect(task.pushNotificationConfig).toEqual({ url: 'https://hook' })
    })
  })

  describe('get()', () => {
    it('returns null when task row is not found', async () => {
      const db = buildMockDb({ selectSequence: [[]] })
      const store = new DrizzleA2ATaskStore(db)
      expect(await store.get('missing')).toBeNull()
    })

    it('returns task with attached messages', async () => {
      const db = buildMockDb({
        selectSequence: [
          [makeTaskRow()],
          [makeMessageRow({ role: 'user' }), makeMessageRow({ id: 2, role: 'agent' })],
        ],
      })
      const store = new DrizzleA2ATaskStore(db)

      const task = await store.get('t1')

      expect(task).not.toBeNull()
      expect(task!.messages).toHaveLength(2)
      expect(task!.messages[0]!.role).toBe('user')
      expect(task!.messages[1]!.role).toBe('agent')
    })

    it('returns empty messages array when none exist', async () => {
      const db = buildMockDb({ selectSequence: [[makeTaskRow()], []] })
      const store = new DrizzleA2ATaskStore(db)
      const task = await store.get('t1')
      expect(task!.messages).toEqual([])
    })
  })

  describe('update()', () => {
    it('returns null when task does not exist', async () => {
      const db = buildMockDb({ updateSequence: [[]] })
      const store = new DrizzleA2ATaskStore(db)
      expect(await store.update('missing', { state: 'working' })).toBeNull()
    })

    it('updates state and returns hydrated task', async () => {
      const db = buildMockDb({
        updateSequence: [[makeTaskRow({ state: 'working' })]],
        selectSequence: [[]], // messages query
      })
      const store = new DrizzleA2ATaskStore(db)

      const task = await store.update('t1', { state: 'working' })

      expect(task).not.toBeNull()
      expect(task!.state).toBe('working')
    })

    it('propagates output, error, metadata partial updates', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({
        updateSequence: [[makeTaskRow()]],
        selectSequence: [[]],
        log,
      })
      const store = new DrizzleA2ATaskStore(db)

      await store.update('t1', { output: 'done', error: 'err', metadata: { x: 1 } })

      const setCall = log.find((l) => l.op === 'update' && l.fn === 'set')
      const values = setCall!.args[0] as Record<string, unknown>
      expect(values['output']).toBe('done')
      expect(values['error']).toBe('err')
      expect(values['metadata']).toEqual({ x: 1 })
    })

    it('always updates updatedAt timestamp', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({
        updateSequence: [[makeTaskRow()]],
        selectSequence: [[]],
        log,
      })
      const store = new DrizzleA2ATaskStore(db)

      await store.update('t1', {})

      const setCall = log.find((l) => l.op === 'update' && l.fn === 'set')
      const values = setCall!.args[0] as Record<string, unknown>
      expect(values['updatedAt']).toBeInstanceOf(Date)
    })

    it('triggers push notification on state=completed via fetch', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true })
      vi.stubGlobal('fetch', fetchMock)

      const db = buildMockDb({
        updateSequence: [[makeTaskRow({
          state: 'completed',
          pushNotificationConfig: { url: 'https://hook', token: 'tok' },
        })]],
        selectSequence: [[]],
      })
      const store = new DrizzleA2ATaskStore(db)

      await store.update('t1', { state: 'completed' })

      // deliverPushNotification is fire-and-forget (void); let the microtask flush
      await Promise.resolve()
      await Promise.resolve()

      expect(fetchMock).toHaveBeenCalledWith('https://hook', expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer tok',
          'Content-Type': 'application/json',
        }),
      }))

      vi.unstubAllGlobals()
    })

    it('triggers push notification on state=failed', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true })
      vi.stubGlobal('fetch', fetchMock)

      const db = buildMockDb({
        updateSequence: [[makeTaskRow({
          state: 'failed',
          pushNotificationConfig: { url: 'https://hook' },
        })]],
        selectSequence: [[]],
      })
      const store = new DrizzleA2ATaskStore(db)

      await store.update('t1', { state: 'failed' })

      await Promise.resolve()
      await Promise.resolve()

      expect(fetchMock).toHaveBeenCalled()

      vi.unstubAllGlobals()
    })

    it('does not trigger push notification for non-terminal states', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const db = buildMockDb({
        updateSequence: [[makeTaskRow({
          state: 'working',
          pushNotificationConfig: { url: 'https://hook' },
        })]],
        selectSequence: [[]],
      })
      const store = new DrizzleA2ATaskStore(db)

      await store.update('t1', { state: 'working' })
      await Promise.resolve()

      expect(fetchMock).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    it('swallows fetch errors from the push notification', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
      vi.stubGlobal('fetch', fetchMock)

      const db = buildMockDb({
        updateSequence: [[makeTaskRow({
          state: 'completed',
          pushNotificationConfig: { url: 'https://hook' },
        })]],
        selectSequence: [[]],
      })
      const store = new DrizzleA2ATaskStore(db)

      await expect(store.update('t1', { state: 'completed' })).resolves.toBeDefined()

      vi.unstubAllGlobals()
    })
  })

  describe('list()', () => {
    it('returns [] when no rows match', async () => {
      const db = buildMockDb({ selectSequence: [[]] })
      const store = new DrizzleA2ATaskStore(db)
      expect(await store.list()).toEqual([])
    })

    it('fetches messages for each task', async () => {
      const db = buildMockDb({
        selectSequence: [
          [makeTaskRow({ id: 't1' }), makeTaskRow({ id: 't2' })],
          [makeMessageRow({ taskId: 't1' })],
          [makeMessageRow({ taskId: 't2', id: 2 })],
        ],
      })
      const store = new DrizzleA2ATaskStore(db)

      const tasks = await store.list()

      expect(tasks).toHaveLength(2)
      expect(tasks[0]!.messages).toHaveLength(1)
      expect(tasks[1]!.messages).toHaveLength(1)
    })

    it('applies agentName filter', async () => {
      const db = buildMockDb({
        selectSequence: [
          [makeTaskRow({ agentName: 'alpha' })],
          [],
        ],
      })
      const store = new DrizzleA2ATaskStore(db)

      const tasks = await store.list({ agentName: 'alpha' })
      expect(tasks).toHaveLength(1)
      expect(tasks[0]!.agentName).toBe('alpha')
    })

    it('applies state filter', async () => {
      const db = buildMockDb({
        selectSequence: [
          [makeTaskRow({ state: 'completed' })],
          [],
        ],
      })
      const store = new DrizzleA2ATaskStore(db)
      const tasks = await store.list({ state: 'completed' })
      expect(tasks[0]!.state).toBe('completed')
    })

    it('applies both filters together', async () => {
      const db = buildMockDb({
        selectSequence: [
          [makeTaskRow({ agentName: 'a', state: 'failed' })],
          [],
        ],
      })
      const store = new DrizzleA2ATaskStore(db)
      const tasks = await store.list({ agentName: 'a', state: 'failed' })
      expect(tasks).toHaveLength(1)
    })
  })

  describe('appendMessage()', () => {
    it('returns null when the task does not exist', async () => {
      // First get() call returns no task
      const db = buildMockDb({ selectSequence: [[]] })
      const store = new DrizzleA2ATaskStore(db)

      const task = await store.appendMessage('missing', {
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
      })
      expect(task).toBeNull()
    })

    it('inserts the message, bumps updatedAt, and returns the hydrated task', async () => {
      const db = buildMockDb({
        // get() for existence check: task + messages
        // then after append, get() is called again: task + messages
        selectSequence: [
          [makeTaskRow()],              // existence check task row
          [],                            // existence check messages
          [makeTaskRow()],              // final get() task row
          [makeMessageRow()],            // final get() messages
        ],
        insertSequence: [[{ id: 1 }]],
        updateSequence: [[makeTaskRow()]],
      })
      const store = new DrizzleA2ATaskStore(db)

      const task = await store.appendMessage('t1', {
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
      })

      expect(task).not.toBeNull()
      expect(db.insert).toHaveBeenCalledTimes(1)
      expect(db.update).toHaveBeenCalledTimes(1)
      expect(task!.messages).toHaveLength(1)
    })
  })

  describe('addArtifact()', () => {
    it('returns null when task does not exist', async () => {
      const db = buildMockDb({ selectSequence: [[]] })
      const store = new DrizzleA2ATaskStore(db)
      expect(await store.addArtifact('missing', { parts: [] })).toBeNull()
    })

    it('appends an artifact with auto-incremented index', async () => {
      // First get() returns task with 1 existing artifact, so new one should have index=1
      const existing: A2ATask = {
        id: 't1', agentName: 'a', state: 'working', input: 'x',
        createdAt: 'd', updatedAt: 'd', messages: [], artifacts: [{ parts: [], index: 0 }],
      }
      const db = buildMockDb({
        selectSequence: [
          // get() call 1: task row must have 1 artifact in it for the logic
          [makeTaskRow({ artifacts: [{ parts: [], index: 0 }] })],
          [],
          // second get() after update()
          [makeTaskRow({ artifacts: [{ parts: [], index: 0 }, { parts: [{ type: 'file' }], index: 1 }] })],
          [],
        ],
        updateSequence: [[]],
      })
      const store = new DrizzleA2ATaskStore(db)
      void existing

      const task = await store.addArtifact('t1', { parts: [{ type: 'file' }] })

      expect(task).not.toBeNull()
      expect(db.update).toHaveBeenCalledTimes(1)
      expect(task!.artifacts).toHaveLength(2)
    })
  })

  describe('setPushConfig()', () => {
    it('returns null when no row is updated', async () => {
      const db = buildMockDb({ updateSequence: [[]] })
      const store = new DrizzleA2ATaskStore(db)
      expect(await store.setPushConfig('missing', { url: 'https://x' })).toBeNull()
    })

    it('returns hydrated task with messages when update succeeds', async () => {
      const db = buildMockDb({
        updateSequence: [[makeTaskRow({
          pushNotificationConfig: { url: 'https://x' },
        })]],
        selectSequence: [[makeMessageRow()]],
      })
      const store = new DrizzleA2ATaskStore(db)

      const task = await store.setPushConfig('t1', { url: 'https://x' })

      expect(task).not.toBeNull()
      expect(task!.pushNotificationConfig).toEqual({ url: 'https://x' })
      expect(task!.messages).toHaveLength(1)
    })

    it('writes the config via update().set()', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({
        updateSequence: [[makeTaskRow()]],
        selectSequence: [[]],
        log,
      })
      const store = new DrizzleA2ATaskStore(db)

      await store.setPushConfig('t1', { url: 'https://hook', token: 't' })

      const setCall = log.find((l) => l.op === 'update' && l.fn === 'set')
      const values = setCall!.args[0] as Record<string, unknown>
      expect(values['pushNotificationConfig']).toEqual({ url: 'https://hook', token: 't' })
    })
  })

  describe('rowToTask() mapping', () => {
    it('treats null/undefined optional fields as absent', async () => {
      const row = makeTaskRow({
        output: null,
        error: null,
        metadata: null,
        pushNotificationConfig: null,
        artifacts: null,  // should fall back to []
      })
      const db = buildMockDb({
        selectSequence: [[row], []],
      })
      const store = new DrizzleA2ATaskStore(db)

      const task = await store.get('t1')

      expect(task!.output).toBeUndefined()
      expect(task!.error).toBeUndefined()
      expect(task!.metadata).toBeUndefined()
      expect(task!.pushNotificationConfig).toBeUndefined()
      expect(task!.artifacts).toEqual([])
    })

    it('preserves artifacts array from the row', async () => {
      const row = makeTaskRow({
        artifacts: [{ parts: [{ type: 'text', text: 'art' }], index: 0 }],
      })
      const db = buildMockDb({ selectSequence: [[row], []] })
      const store = new DrizzleA2ATaskStore(db)

      const task = await store.get('t1')
      expect(task!.artifacts).toHaveLength(1)
    })
  })
})
