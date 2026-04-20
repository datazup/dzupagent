/**
 * Tests for DrizzleMailboxStore using a chainable mock Drizzle client.
 *
 * We simulate the Drizzle fluent API subset used by the store (insert/select/
 * update/delete with chained .values / .from / .where / .set / .orderBy /
 * .limit) via the same Proxy-chain pattern used by drizzle-a2a-task-store.test.ts.
 *
 * No live database, no network, deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DrizzleMailboxStore } from '../persistence/drizzle-mailbox-store.js'
import type { MailMessage, MailboxQuery } from '@dzupagent/agent'

// ---------------------------------------------------------------------------
// Proxy-based chainable mock builder
// ---------------------------------------------------------------------------

interface CallLog { op: string; fn: string; args: unknown[] }

function makeChain(
  terminal: unknown,
  onCall: (fn: string, args: unknown[]) => void,
): Record<string, unknown> {
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

interface MockDbConfig {
  /** Rows returned by db.select() chains — each call consumes one entry. */
  selectSequence?: unknown[][]
  /** Terminal value returned by db.insert() chains (usually void/undefined). */
  insertTerminal?: unknown
  /** Terminal value returned by db.update() chains (usually void/undefined). */
  updateTerminal?: unknown
  /** Terminal value returned by db.delete() chains — typically { rowCount: N }. */
  deleteTerminal?: unknown
  /** Shared call log populated by all operations. */
  log?: CallLog[]
}

function buildMockDb(cfg: MockDbConfig = {}): Record<string, unknown> {
  const log = cfg.log ?? []
  const selQueue = [...(cfg.selectSequence ?? [])]

  const make = (op: string, terminal: unknown) => {
    const onCall = (fn: string, args: unknown[]): void => {
      log.push({ op, fn, args })
    }
    return makeChain(terminal, onCall)
  }

  return {
    select: vi.fn(() => make('select', selQueue.shift() ?? [])),
    insert: vi.fn(() => make('insert', cfg.insertTerminal ?? undefined)),
    update: vi.fn(() => make('update', cfg.updateTerminal ?? undefined)),
    delete: vi.fn(() => make('delete', cfg.deleteTerminal ?? { rowCount: 0 })),
    _log: log,
  }
}

// ---------------------------------------------------------------------------
// Row factory helpers
// ---------------------------------------------------------------------------

type MailboxRowOverrides = Partial<{
  id: string
  fromAgent: string
  toAgent: string
  subject: string
  body: Record<string, unknown>
  createdAt: number
  readAt: number | null
  ttlSeconds: number | null
}>

function makeMailboxRow(overrides: MailboxRowOverrides = {}) {
  return {
    id: 'msg-1',
    fromAgent: 'agent-alpha',
    toAgent: 'agent-beta',
    subject: 'Hello',
    body: { text: 'world' },
    createdAt: 1_700_000_000_000,
    readAt: null,
    ttlSeconds: null,
    ...overrides,
  }
}

function makeMailMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'msg-1',
    from: 'agent-alpha',
    to: 'agent-beta',
    subject: 'Hello',
    body: { text: 'world' },
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DrizzleMailboxStore', () => {
  beforeEach(() => {
    vi.useFakeTimers().setSystemTime(new Date('2026-04-19T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // -------------------------------------------------------------------------
  // save()
  // -------------------------------------------------------------------------

  describe('save()', () => {
    it('calls db.insert() exactly once', async () => {
      const db = buildMockDb()
      const store = new DrizzleMailboxStore(db)
      await store.save(makeMailMessage())
      expect(db.insert).toHaveBeenCalledTimes(1)
    })

    it('uses the provided message.id when present', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({ log })
      const store = new DrizzleMailboxStore(db)

      await store.save(makeMailMessage({ id: 'explicit-id-123' }))

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const row = valuesCall!.args[0] as Record<string, unknown>
      expect(row['id']).toBe('explicit-id-123')
    })

    it('generates a UUID when message.id is absent', async () => {
      const fakeUUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      vi.stubGlobal('crypto', { randomUUID: vi.fn(() => fakeUUID) })

      const log: CallLog[] = []
      const db = buildMockDb({ log })
      const store = new DrizzleMailboxStore(db)

      const msg = makeMailMessage()
      // Cast to strip readonly so we can delete the field
      delete (msg as Record<string, unknown>)['id']

      await store.save({ ...msg, id: '' })

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const row = valuesCall!.args[0] as Record<string, unknown>
      expect(row['id']).toBe(fakeUUID)
    })

    it('generates a UUID when message.id is an empty string', async () => {
      const fakeUUID = 'generated-uuid'
      vi.stubGlobal('crypto', { randomUUID: vi.fn(() => fakeUUID) })

      const log: CallLog[] = []
      const db = buildMockDb({ log })
      const store = new DrizzleMailboxStore(db)
      await store.save(makeMailMessage({ id: '' }))

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const row = valuesCall!.args[0] as Record<string, unknown>
      expect(row['id']).toBe(fakeUUID)
    })

    it('maps message.from to fromAgent column', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({ log })
      const store = new DrizzleMailboxStore(db)
      await store.save(makeMailMessage({ from: 'sender-007' }))

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const row = valuesCall!.args[0] as Record<string, unknown>
      expect(row['fromAgent']).toBe('sender-007')
    })

    it('maps message.to to toAgent column', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({ log })
      const store = new DrizzleMailboxStore(db)
      await store.save(makeMailMessage({ to: 'recipient-999' }))

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const row = valuesCall!.args[0] as Record<string, unknown>
      expect(row['toAgent']).toBe('recipient-999')
    })

    it('maps message.ttl to ttlSeconds column', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({ log })
      const store = new DrizzleMailboxStore(db)
      await store.save(makeMailMessage({ ttl: 300 }))

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const row = valuesCall!.args[0] as Record<string, unknown>
      expect(row['ttlSeconds']).toBe(300)
    })

    it('stores null for ttlSeconds when ttl is absent', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({ log })
      const store = new DrizzleMailboxStore(db)
      const msg = makeMailMessage()
      delete (msg as Record<string, unknown>)['ttl']
      await store.save(msg)

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const row = valuesCall!.args[0] as Record<string, unknown>
      expect(row['ttlSeconds']).toBeNull()
    })

    it('stores null for readAt by default', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({ log })
      const store = new DrizzleMailboxStore(db)
      await store.save(makeMailMessage())

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const row = valuesCall!.args[0] as Record<string, unknown>
      expect(row['readAt']).toBeNull()
    })

    it('stores provided readAt value', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({ log })
      const store = new DrizzleMailboxStore(db)
      await store.save(makeMailMessage({ readAt: 1_700_000_001_000 }))

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const row = valuesCall!.args[0] as Record<string, unknown>
      expect(row['readAt']).toBe(1_700_000_001_000)
    })

    it('stores subject and body correctly', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({ log })
      const store = new DrizzleMailboxStore(db)
      await store.save(makeMailMessage({ subject: 'Task update', body: { status: 'done' } }))

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const row = valuesCall!.args[0] as Record<string, unknown>
      expect(row['subject']).toBe('Task update')
      expect(row['body']).toEqual({ status: 'done' })
    })

    it('stores createdAt from the message', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({ log })
      const store = new DrizzleMailboxStore(db)
      await store.save(makeMailMessage({ createdAt: 1_234_567_890_000 }))

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const row = valuesCall!.args[0] as Record<string, unknown>
      expect(row['createdAt']).toBe(1_234_567_890_000)
    })
  })

  // -------------------------------------------------------------------------
  // findByRecipient()
  // -------------------------------------------------------------------------

  describe('findByRecipient()', () => {
    it('calls db.select() exactly once', async () => {
      const db = buildMockDb({ selectSequence: [[]] })
      const store = new DrizzleMailboxStore(db)
      await store.findByRecipient('agent-beta')
      expect(db.select).toHaveBeenCalledTimes(1)
    })

    it('returns empty array when no rows match', async () => {
      const db = buildMockDb({ selectSequence: [[]] })
      const store = new DrizzleMailboxStore(db)
      const result = await store.findByRecipient('agent-beta')
      expect(result).toEqual([])
    })

    it('maps a single row to a MailMessage correctly', async () => {
      const row = makeMailboxRow()
      const db = buildMockDb({ selectSequence: [[row]] })
      const store = new DrizzleMailboxStore(db)

      const messages = await store.findByRecipient('agent-beta')

      expect(messages).toHaveLength(1)
      expect(messages[0]!.id).toBe('msg-1')
      expect(messages[0]!.from).toBe('agent-alpha')
      expect(messages[0]!.to).toBe('agent-beta')
      expect(messages[0]!.subject).toBe('Hello')
      expect(messages[0]!.body).toEqual({ text: 'world' })
      expect(messages[0]!.createdAt).toBe(1_700_000_000_000)
    })

    it('maps null readAt to undefined on the returned message', async () => {
      const row = makeMailboxRow({ readAt: null })
      const db = buildMockDb({ selectSequence: [[row]] })
      const store = new DrizzleMailboxStore(db)

      const messages = await store.findByRecipient('agent-beta')
      expect(messages[0]!.readAt).toBeUndefined()
    })

    it('maps a numeric readAt value through to the returned message', async () => {
      const row = makeMailboxRow({ readAt: 1_700_000_500_000 })
      const db = buildMockDb({ selectSequence: [[row]] })
      const store = new DrizzleMailboxStore(db)

      const messages = await store.findByRecipient('agent-beta')
      expect(messages[0]!.readAt).toBe(1_700_000_500_000)
    })

    it('maps null ttlSeconds to undefined ttl on the returned message', async () => {
      const row = makeMailboxRow({ ttlSeconds: null })
      const db = buildMockDb({ selectSequence: [[row]] })
      const store = new DrizzleMailboxStore(db)

      const messages = await store.findByRecipient('agent-beta')
      expect(messages[0]!.ttl).toBeUndefined()
    })

    it('maps a numeric ttlSeconds to ttl on the returned message', async () => {
      const row = makeMailboxRow({ ttlSeconds: 600 })
      const db = buildMockDb({ selectSequence: [[row]] })
      const store = new DrizzleMailboxStore(db)

      const messages = await store.findByRecipient('agent-beta')
      expect(messages[0]!.ttl).toBe(600)
    })

    it('returns multiple rows as multiple MailMessages', async () => {
      const rows = [
        makeMailboxRow({ id: 'msg-1', subject: 'First' }),
        makeMailboxRow({ id: 'msg-2', subject: 'Second' }),
        makeMailboxRow({ id: 'msg-3', subject: 'Third' }),
      ]
      const db = buildMockDb({ selectSequence: [rows] })
      const store = new DrizzleMailboxStore(db)

      const messages = await store.findByRecipient('agent-beta')
      expect(messages).toHaveLength(3)
      expect(messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3'])
    })

    it('uses unreadOnly=true by default (no explicit query)', async () => {
      // The store internally uses `isNull(agentMailbox.readAt)` when unreadOnly=true.
      // We verify this indirectly by confirming rows are returned (the mock does not
      // actually filter, but we check the .where() chain is invoked — the log captures it).
      const log: CallLog[] = []
      const db = buildMockDb({ selectSequence: [[]], log })
      const store = new DrizzleMailboxStore(db)

      await store.findByRecipient('agent-beta')

      const whereCalls = log.filter((l) => l.op === 'select' && l.fn === 'where')
      expect(whereCalls.length).toBeGreaterThan(0)
    })

    it('accepts unreadOnly=false without throwing', async () => {
      const db = buildMockDb({ selectSequence: [[makeMailboxRow({ readAt: 1_700_001_000_000 })]] })
      const store = new DrizzleMailboxStore(db)

      const query: MailboxQuery = { unreadOnly: false }
      const messages = await store.findByRecipient('agent-beta', query)

      // Store returns all provided rows regardless of mock filtering
      expect(messages).toHaveLength(1)
    })

    it('accepts since filter without throwing', async () => {
      const db = buildMockDb({ selectSequence: [[makeMailboxRow()]] })
      const store = new DrizzleMailboxStore(db)

      const query: MailboxQuery = { since: 1_699_000_000_000, unreadOnly: false }
      const messages = await store.findByRecipient('agent-beta', query)

      expect(messages).toHaveLength(1)
    })

    it('calls .limit() in the chain', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({ selectSequence: [[]], log })
      const store = new DrizzleMailboxStore(db)

      await store.findByRecipient('agent-beta', { limit: 5 })

      const limitCalls = log.filter((l) => l.op === 'select' && l.fn === 'limit')
      expect(limitCalls.length).toBeGreaterThan(0)
    })

    it('calls .orderBy() in the chain', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({ selectSequence: [[]], log })
      const store = new DrizzleMailboxStore(db)

      await store.findByRecipient('agent-beta')

      const orderByCalls = log.filter((l) => l.op === 'select' && l.fn === 'orderBy')
      expect(orderByCalls.length).toBeGreaterThan(0)
    })

    it('defaults limit to 10 when not provided', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({ selectSequence: [[]], log })
      const store = new DrizzleMailboxStore(db)

      await store.findByRecipient('agent-beta')

      const limitCall = log.find((l) => l.op === 'select' && l.fn === 'limit')
      expect(limitCall).toBeDefined()
      expect(limitCall!.args[0]).toBe(10)
    })

    it('uses provided limit value', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({ selectSequence: [[]], log })
      const store = new DrizzleMailboxStore(db)

      await store.findByRecipient('agent-beta', { limit: 25 })

      const limitCall = log.find((l) => l.op === 'select' && l.fn === 'limit')
      expect(limitCall!.args[0]).toBe(25)
    })
  })

  // -------------------------------------------------------------------------
  // markRead()
  // -------------------------------------------------------------------------

  describe('markRead()', () => {
    it('calls db.update() exactly once', async () => {
      const db = buildMockDb()
      const store = new DrizzleMailboxStore(db)
      await store.markRead('msg-42')
      expect(db.update).toHaveBeenCalledTimes(1)
    })

    it('sets readAt to the current timestamp', async () => {
      const now = new Date('2026-04-19T00:00:00Z').getTime() // 1_745_020_800_000
      const log: CallLog[] = []
      const db = buildMockDb({ log })
      const store = new DrizzleMailboxStore(db)

      await store.markRead('msg-42')

      const setCall = log.find((l) => l.op === 'update' && l.fn === 'set')
      expect(setCall).toBeDefined()
      const values = setCall!.args[0] as Record<string, unknown>
      expect(values['readAt']).toBe(now)
    })

    it('calls .where() to scope the update to the message ID', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({ log })
      const store = new DrizzleMailboxStore(db)

      await store.markRead('msg-99')

      const whereCalls = log.filter((l) => l.op === 'update' && l.fn === 'where')
      expect(whereCalls.length).toBeGreaterThan(0)
    })

    it('resolves without error for any message ID', async () => {
      const db = buildMockDb()
      const store = new DrizzleMailboxStore(db)
      await expect(store.markRead('any-id')).resolves.toBeUndefined()
    })

    it('does not call insert or select', async () => {
      const db = buildMockDb()
      const store = new DrizzleMailboxStore(db)
      await store.markRead('msg-1')
      expect(db.insert).not.toHaveBeenCalled()
      expect(db.select).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // deleteExpired()
  // -------------------------------------------------------------------------

  describe('deleteExpired()', () => {
    it('calls db.delete() exactly once', async () => {
      const db = buildMockDb({ deleteTerminal: { rowCount: 0 } })
      const store = new DrizzleMailboxStore(db)
      await store.deleteExpired()
      expect(db.delete).toHaveBeenCalledTimes(1)
    })

    it('returns the rowCount from the delete result', async () => {
      const db = buildMockDb({ deleteTerminal: { rowCount: 7 } })
      const store = new DrizzleMailboxStore(db)
      const count = await store.deleteExpired()
      expect(count).toBe(7)
    })

    it('returns 0 when rowCount is 0', async () => {
      const db = buildMockDb({ deleteTerminal: { rowCount: 0 } })
      const store = new DrizzleMailboxStore(db)
      expect(await store.deleteExpired()).toBe(0)
    })

    it('returns 0 when rowCount is absent from the result', async () => {
      const db = buildMockDb({ deleteTerminal: {} })
      const store = new DrizzleMailboxStore(db)
      const count = await store.deleteExpired()
      expect(count).toBe(0)
    })

    it('returns 0 when delete result is undefined', async () => {
      const db = buildMockDb({ deleteTerminal: undefined })
      const store = new DrizzleMailboxStore(db)
      const count = await store.deleteExpired()
      expect(count).toBe(0)
    })

    it('calls .where() to target only expired rows', async () => {
      const log: CallLog[] = []
      const db = buildMockDb({ deleteTerminal: { rowCount: 2 }, log })
      const store = new DrizzleMailboxStore(db)
      await store.deleteExpired()

      const whereCalls = log.filter((l) => l.op === 'delete' && l.fn === 'where')
      expect(whereCalls.length).toBeGreaterThan(0)
    })

    it('does not call insert, select, or update', async () => {
      const db = buildMockDb({ deleteTerminal: { rowCount: 0 } })
      const store = new DrizzleMailboxStore(db)
      await store.deleteExpired()
      expect(db.insert).not.toHaveBeenCalled()
      expect(db.select).not.toHaveBeenCalled()
      expect(db.update).not.toHaveBeenCalled()
    })

    it('handles large rowCounts correctly', async () => {
      const db = buildMockDb({ deleteTerminal: { rowCount: 100_000 } })
      const store = new DrizzleMailboxStore(db)
      expect(await store.deleteExpired()).toBe(100_000)
    })
  })

  // -------------------------------------------------------------------------
  // rowToMessage() mapping — tested indirectly via findByRecipient()
  // -------------------------------------------------------------------------

  describe('rowToMessage() mapping (via findByRecipient)', () => {
    it('copies id unchanged', async () => {
      const db = buildMockDb({ selectSequence: [[makeMailboxRow({ id: 'unique-id' })]] })
      const store = new DrizzleMailboxStore(db)
      const [msg] = await store.findByRecipient('agent-beta')
      expect(msg!.id).toBe('unique-id')
    })

    it('maps fromAgent -> from', async () => {
      const db = buildMockDb({ selectSequence: [[makeMailboxRow({ fromAgent: 'origin-agent' })]] })
      const store = new DrizzleMailboxStore(db)
      const [msg] = await store.findByRecipient('agent-beta')
      expect(msg!.from).toBe('origin-agent')
    })

    it('maps toAgent -> to', async () => {
      const db = buildMockDb({ selectSequence: [[makeMailboxRow({ toAgent: 'dest-agent' })]] })
      const store = new DrizzleMailboxStore(db)
      const [msg] = await store.findByRecipient('dest-agent')
      expect(msg!.to).toBe('dest-agent')
    })

    it('maps ttlSeconds -> ttl', async () => {
      const db = buildMockDb({ selectSequence: [[makeMailboxRow({ ttlSeconds: 3600 })]] })
      const store = new DrizzleMailboxStore(db)
      const [msg] = await store.findByRecipient('agent-beta')
      expect(msg!.ttl).toBe(3600)
    })

    it('maps null ttlSeconds -> undefined ttl', async () => {
      const db = buildMockDb({ selectSequence: [[makeMailboxRow({ ttlSeconds: null })]] })
      const store = new DrizzleMailboxStore(db)
      const [msg] = await store.findByRecipient('agent-beta')
      expect(msg!.ttl).toBeUndefined()
    })

    it('maps null readAt -> undefined readAt', async () => {
      const db = buildMockDb({ selectSequence: [[makeMailboxRow({ readAt: null })]] })
      const store = new DrizzleMailboxStore(db)
      const [msg] = await store.findByRecipient('agent-beta')
      expect(msg!.readAt).toBeUndefined()
    })

    it('maps numeric readAt -> readAt', async () => {
      const ts = 1_745_020_800_000
      const db = buildMockDb({ selectSequence: [[makeMailboxRow({ readAt: ts })]] })
      const store = new DrizzleMailboxStore(db)
      const [msg] = await store.findByRecipient('agent-beta')
      expect(msg!.readAt).toBe(ts)
    })

    it('preserves body object reference structure', async () => {
      const body = { nested: { value: 42 }, arr: [1, 2, 3] }
      const db = buildMockDb({ selectSequence: [[makeMailboxRow({ body })]] })
      const store = new DrizzleMailboxStore(db)
      const [msg] = await store.findByRecipient('agent-beta')
      expect(msg!.body).toEqual(body)
    })
  })
})
