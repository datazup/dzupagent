import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCard, ListTasksRequest, Task, TaskState } from '@a2a-js/sdk'
import { ServerCallContext, type AgentExecutor } from '@a2a-js/sdk/server'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { type DrizzleA2AV1TaskStore, createDrizzleA2AV1TaskStore } from '../v1/drizzle-task-store.js'
import { VerifiedA2AUser, dzupOwnerResolver } from '../v1/identity.js'
import { createA2AV1Handler } from '../v1/request-handler.js'
import type { DrizzleStoreDatabase } from '../../persistence/drizzle-store-types.js'

interface FakeSelect {
  from(): FakeSelect
  where(condition: SQL): FakeSelect
  limit(maximum: number): FakeSelect
  orderBy(...expressions: SQL[]): FakeSelect
  then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown): Promise<unknown>
}

/**
 * In-test FAKE of the narrow Drizzle surface, not a database integration test.
 * It compiles the real SQL predicates with PgDialect and interprets the small
 * boolean expression subset used here. It never invents an owner/tenant filter
 * or terminal policy: removing those SQL clauses changes the fake's behavior.
 */
class FakeDatabase {
  rows: Array<Record<string, unknown>> = []
  /** One entry per select: whether it was the count query, its LIMIT and how many rows it returned. */
  selects: Array<{ counting: boolean; limit: number; returned: number }> = []
  failure: 'save' | 'load' | 'list' | undefined
  readonly dialect = new PgDialect()

  private matches(condition: SQL | undefined, row: Record<string, unknown>, incoming = row): boolean {
    if (!condition) return true
    const query = this.dialect.sqlToQuery(condition)
    const tokens = query.sql.match(/"[^"]+"\."[^"]+"|excluded\.task|\$\d+|not\s+in|is\s+null|and|or|[()=,><]/gi) ?? []
    let at = 0
    const value = (): unknown => {
      const token = tokens[at++]!
      if (token.startsWith('$')) return query.params[Number(token.slice(1)) - 1]
      if (token === 'excluded.task') return incoming.task
      const column = token.split('.')[1]!.replaceAll('"', '')
      const key = column.replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase())
      return row[key]
    }
    const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
    const atom = (): boolean => {
      if (tokens[at] === '(') {
        at++
        const result = disjunction()
        if (tokens[at++] !== ')') throw new Error('Fake SQL: missing close parenthesis')
        return result
      }
      const left = value()
      const operator = tokens[at++]!.toLowerCase().replace(/\s+/g, ' ')
      if (operator === 'is null') return left === null
      if (operator === 'not in') {
        if (tokens[at++] !== '(') throw new Error('Fake SQL: missing list')
        const values = [value()]
        while (tokens[at] === ',') { at++; values.push(value()) }
        if (tokens[at++] !== ')') throw new Error('Fake SQL: missing list end')
        return !values.some((entry) => equal(entry, left))
      }
      const right = value()
      if (operator === '=') return equal(left, right)
      if (operator === '>') return left instanceof Date && left.getTime() > new Date(String(right)).getTime()
      if (operator === '<') return left instanceof Date ? left.getTime() < new Date(String(right)).getTime() : typeof left === 'string' && left < String(right)
      throw new Error(`Fake SQL: unsupported operator ${operator}`)
    }
    const conjunction = (): boolean => {
      let result = atom()
      while (tokens[at]?.toLowerCase() === 'and') { at++; const next = atom(); result = result && next }
      return result
    }
    const disjunction = (): boolean => {
      let result = conjunction()
      while (tokens[at]?.toLowerCase() === 'or') { at++; const next = conjunction(); result = result || next }
      return result
    }
    const result = disjunction()
    if (at !== tokens.length) throw new Error('Fake SQL: unconsumed expression')
    return result
  }

  select(selection?: unknown): FakeSelect {
    const counting = selection !== undefined
    let condition: SQL | undefined
    let maximum = Infinity
    const ordering: SQL[] = []
    const query: FakeSelect = {
      from: () => query,
      where: (next: SQL) => { condition = next; return query },
      limit: (next: number) => { maximum = next; return query },
      orderBy: (...next: SQL[]) => { ordering.push(...next); return query },
      then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve().then(() => {
        if (this.failure === (maximum === 1 ? 'load' : 'list')) throw new Error('fixture-db-driver-detail')
        const rows = this.rows.filter((row) => this.matches(condition, row))
        if (counting) { this.selects.push({ counting, limit: Infinity, returned: 1 }); return [{ total: rows.length }] }
        if (ordering.length) rows.sort((a, b) => {
          for (const expression of ordering) {
            const text = this.dialect.sqlToQuery(expression).sql
            const key = text.includes('status_timestamp') ? 'statusTimestamp' : 'id'
            const left = a[key] instanceof Date ? (a[key] as Date).getTime() : a[key]
            const right = b[key] instanceof Date ? (b[key] as Date).getTime() : b[key]
            if (left === right) continue
            if (left === null) return text.includes('nulls last') ? 1 : -1
            if (right === null) return text.includes('nulls last') ? -1 : 1
            return (String(left) < String(right) ? -1 : 1) * (text.includes('desc') ? -1 : 1)
          }
          return 0
        })
        const bounded = rows.slice(0, maximum)
        this.selects.push({ counting, limit: maximum, returned: bounded.length })
        return structuredClone(bounded)
      }).then(resolve, reject),
    }
    return query
  }

  insert() {
    return { values: (values: Record<string, unknown>) => ({
      onConflictDoUpdate: (config: { target: Array<{ name: string }>; set: Record<string, unknown>; setWhere?: SQL }) => ({
        returning: async () => {
          if (this.failure === 'save') throw new Error('fixture-db-driver-detail')
          const keys = config.target.map((column) => column.name.replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase()))
          const existing = this.rows.find((row) => keys.every((key) => row[key] === values[key]))
          if (existing && !this.matches(config.setWhere, existing, values)) return []
          if (existing) {
            const unchanged = JSON.stringify(existing.task) === JSON.stringify(values.task)
            for (const [key, value] of Object.entries(config.set)) {
              existing[key] = key === 'updatedAt' ? (unchanged ? existing.updatedAt : values.updatedAt) : structuredClone(value)
            }
          } else this.rows.push({ createdAt: new Date(), ...structuredClone(values) })
          return [{ id: values.id }]
        },
      }),
    }) }
  }
}

// BEGIN conformance cases: kept identical in the real-Postgres integration file.
type LogEntry = { level: 'error' | 'warn'; operation: string }
interface Harness {
  store: DrizzleA2AV1TaskStore
  newStore(): DrizzleA2AV1TaskStore
  rows(): Promise<Array<Record<string, unknown>>>
  corrupt(id: string, task: unknown): Promise<void>
  relocateTenant(id: string, tenantId: string): Promise<void>
  fault(operation: 'save' | 'load' | 'list'): Promise<() => Promise<void>>
  race(first: Task, second: Task): Promise<void>
  logs: LogEntry[]
}

const scope = (tenantId = 'tenant-fixture', ownerId = 'alice-fixture') => new ServerCallContext({
  tenant: tenantId, user: new VerifiedA2AUser({ tenantId, ownerId }), requestedVersion: '1.0',
})
const alice = scope()
const bob = scope('tenant-fixture', 'bob-fixture')
const otherTenant = scope('other-tenant', 'alice-fixture')
const fixture = (id = 'task-fixture', state = 'TASK_STATE_WORKING', contextId = 'context-fixture', timestamp: string | null = '2026-10-10T10:11:12.345Z') => Task.fromJSON({
  id, contextId,
  status: {
    state, ...(timestamp === null ? {} : { timestamp }),
    message: { messageId: 'status-message', role: 'ROLE_AGENT', parts: [{ text: 'status fixture', mediaType: 'text/plain' }] },
  },
  history: [
    { messageId: 'user-1', role: 'ROLE_USER', taskId: id, contextId, parts: [{ text: 'first input', mediaType: 'text/plain' }], metadata: { turn: 1 } },
    { messageId: 'agent-1', role: 'ROLE_AGENT', taskId: id, contextId, parts: [{ text: 'first reply', mediaType: 'text/plain' }], extensions: ['urn:fixture:history'] },
  ],
  artifacts: [{ artifactId: 'artifact-1', name: 'output', description: 'artifact fixture', parts: [{ text: 'artifact text', mediaType: 'text/plain' }], metadata: { artifact: true }, extensions: ['urn:fixture:artifact'] }],
  metadata: { nested: { nonDefault: 42, values: [false, 'fixture'] }, ownerId: 'untrusted-content-owner' },
})
const listing = (values: Record<string, unknown> = {}) => ListTasksRequest.fromJSON({ includeArtifacts: true, ...values })
const idleExecutor: AgentExecutor = { async execute() {}, async cancelTask() {} }
async function rpc(store: DrizzleA2AV1TaskStore, method: string, params: unknown, context = alice) {
  const v1 = createA2AV1Handler({
    taskStore: store, executor: idleExecutor,
    agentCard: AgentCard.fromJSON({ name: 'durable-fixture', defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'] }),
  })
  const result = await v1.handler.handle({ jsonrpc: '2.0', id: 'fixture', method, params }, context)
  if (Symbol.asyncIterator in result) throw new Error('Unexpected fixture stream')
  return { body: result as { error?: { code: number; message: string } }, text: JSON.stringify(result) }
}

function registerCases(get: () => Harness) {
  it('G1.01 full Task round-trip preserves history artifacts status message and metadata', async () => {
    expect(fixture().history.length).toBeGreaterThan(0)
    const h = get()
    const task = fixture()
    await h.store.save(task, alice)
    expect(await h.store.load(task.id, alice)).toEqual(task)
    expect(await h.rows()).toHaveLength(1)
  })

  it('G1.02 a new store instance loads the task saved before restart', async () => {
    expect(fixture().artifacts.length).toBeGreaterThan(0)
    const h = get()
    const task = fixture()
    await h.store.save(task, alice)
    const next = h.newStore()
    expect(next).not.toBe(h.store)
    expect(await next.load(task.id, alice)).toEqual(task)
  })

  it('G1.03 cross-owner load in the same tenant is not found', async () => {
    expect(dzupOwnerResolver(alice).length).toBeGreaterThan(0)
    const h = get()
    const task = fixture()
    await h.store.save(task, alice)
    expect(await h.rows()).toHaveLength(1)
    expect(await h.store.load(task.id, alice)).toEqual(task)
    expect(await h.store.load(task.id, bob)).toBeUndefined()
  })

  it('G1.04 cross-tenant load is not found even with identical owner-key text', async () => {
    expect(alice.tenant!.length).toBeGreaterThan(0)
    const h = get()
    const task = fixture()
    await h.store.save(task, alice)
    expect(await h.store.load(task.id, otherTenant)).toBeUndefined()
    // Deliberate fixture relocation independently exercises the tenant SQL
    // predicate. Resolver keys normally include the tenant already; testing
    // only normal contexts would not detect removal of that SQL predicate.
    await h.relocateTenant(task.id, 'relocated-tenant')
    expect(await h.rows()).toMatchObject([{ tenantId: 'relocated-tenant', ownerKey: dzupOwnerResolver(alice) }])
    expect(await h.store.load(task.id, alice)).toBeUndefined()
  })

  it('G1.05 cross-owner save of the same id creates a separate row', async () => {
    expect(fixture().contextId.length).toBeGreaterThan(0)
    const h = get()
    const original = fixture()
    const separate = fixture(original.id, 'TASK_STATE_INPUT_REQUIRED', 'bob-context')
    await h.store.save(original, alice)
    await h.store.save(separate, bob)
    expect(await h.rows()).toHaveLength(2)
    expect(await h.store.load(original.id, alice)).toEqual(original)
    expect(await h.store.load(original.id, bob)).toEqual(separate)
  })

  it('G1.06 list scopes orders filters paginates and caps pages at 100', async () => {
    expect(fixture().status!.timestamp!.length).toBeGreaterThan(0)
    const h = get()
    // Timestamps deliberately conflict with id order (order-a is newest, order-z oldest) and include equal and absent
    // timestamps, so reversing or removing the status_timestamp ordering changes the result.
    const at = (clock: string) => `2026-10-10T${clock}Z`
    const ordered: Array<[string, string | null]> = [
      ['order-z', at('11:00:00.000')], ['order-a', at('13:00:00.000')], ['order-e1', at('10:30:00.000')],
      ['order-m', at('12:00:00.000')], ['order-null-a', null], ['order-e2', at('10:30:00.000')], ['order-null-b', null],
    ]
    for (const [id, time] of ordered) await h.store.save(fixture(id, 'TASK_STATE_WORKING', 'context-fixture', time), alice)
    await h.store.save(fixture('foreign-owner'), bob)
    await h.store.save(fixture('foreign-tenant'), otherTenant)
    await h.store.save(fixture('different-status', 'TASK_STATE_INPUT_REQUIRED'), alice)
    await h.store.save(fixture('different-context', 'TASK_STATE_WORKING', 'unmatched-context'), alice)
    const expectedOrder = ['order-a', 'order-m', 'order-z', 'order-e2', 'order-e1', 'order-null-b', 'order-null-a']
    expect(new Set(expectedOrder).size).toBe(ordered.length)
    const params = listing({ contextId: 'context-fixture', status: 'TASK_STATE_WORKING', pageSize: 2 })
    const seen: string[] = []
    let token = ''
    let pages = 0
    do {
      const page = await (pages % 2 ? h.newStore() : h.store).list(token ? { ...params, pageToken: token } : params, alice)
      expect(page.totalSize).toBe(ordered.length)
      expect(page.tasks.length).toBeGreaterThan(0)
      seen.push(...page.tasks.map((task) => task.id))
      token = page.nextPageToken
      pages += 1
    } while (token && pages < 10)
    // Pages cross the distinct, equal and absent timestamp boundaries: [a,m] [z,e2] [e1,null-b] [null-a].
    expect(seen).toEqual(expectedOrder)
    expect(pages).toBe(4)
    const page = await h.store.list(params, alice)
    expect(page.tasks.map((task) => task.id)).toEqual(['order-a', 'order-m'])
    expect(page.nextPageToken.length).toBeGreaterThan(0)
    expect(page.tasks[0]!.artifacts.length).toBeGreaterThan(0)
    expect((await h.store.list({ ...params, includeArtifacts: false }, alice)).tasks[0]!.artifacts).toEqual([])
    const after = await h.store.list({ ...params, pageSize: 100, statusTimestampAfter: '2026-10-09T00:00:00Z' }, alice)
    expect(after.totalSize).toBe(5) // absent timestamps never satisfy statusTimestampAfter
    const newest = await h.store.list({ ...params, pageSize: 100, statusTimestampAfter: '2026-10-10T12:30:00Z' }, alice)
    expect(newest.tasks.map((task) => task.id)).toEqual(['order-a'])
    expect((await h.store.list(listing({ statusTimestampAfter: '2026-10-11T00:00:00Z' }), alice)).tasks).toEqual([])
    for (let i = 0; i < 101; i++) await h.store.save(fixture(`cap-${i}`, 'TASK_STATE_WORKING', 'cap-context'), alice)
    const capped = await h.store.list(listing({ contextId: 'cap-context', pageSize: 999 }), alice)
    expect(capped.tasks).toHaveLength(100)
    expect(capped.pageSize).toBe(100)
    expect(capped.totalSize).toBe(101)
    expect(capped.nextPageToken.length).toBeGreaterThan(0)
    await expect(h.store.list({ ...params, pageToken: 'malformed' }, alice)).rejects.toThrow('Internal server error')
  })

  it('G1.07 terminal tasks reject later state changes and changed terminal payloads', async () => {
    expect(fixture().history.length).toBeGreaterThan(0)
    const h = get()
    for (const state of ['TASK_STATE_CANCELED', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_REJECTED']) {
      const terminal = fixture(state, state)
      await h.store.save(terminal, alice)
      expect(await h.store.load(terminal.id, alice)).toEqual(terminal)
      await h.store.save(fixture(terminal.id), alice)
      await h.store.save({ ...terminal, metadata: { late: true } }, alice)
      expect(await h.store.load(terminal.id, alice)).toEqual(terminal)
    }
    expect(h.logs.filter((entry) => entry.operation === 'a2a.v1.store.terminal-write')).toHaveLength(8)
  })

  it('G1.08 cancel versus completion concurrent writes deterministically keep the first terminal write', async () => {
    expect(fixture().id.length).toBeGreaterThan(0)
    const h = get()
    for (const states of [['TASK_STATE_CANCELED', 'TASK_STATE_COMPLETED'], ['TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED']]) {
      const task = fixture(`race-${states[0]}`)
      await h.store.save(task, alice)
      expect((await h.store.load(task.id, alice))!.status!.state).toBe(TaskState.TASK_STATE_WORKING)
      const first = fixture(task.id, states[0]!)
      const second = fixture(task.id, states[1]!)
      await h.race(first, second)
      expect(await h.newStore().load(task.id, alice)).toEqual(first)
    }
    expect(h.logs.filter((entry) => entry.operation === 'a2a.v1.store.terminal-write')).toHaveLength(2)
  })

  it('G1.09 identical re-save is idempotent with one unchanged row and payload', async () => {
    expect(Object.keys(fixture().metadata!).length).toBeGreaterThan(0)
    const h = get()
    const task = fixture('retry', 'TASK_STATE_COMPLETED')
    await h.store.save(task, alice)
    const before = await h.rows()
    expect(before).toHaveLength(1)
    await h.newStore().save(task, alice)
    expect(await h.rows()).toEqual(before)
    expect(await h.store.load(task.id, alice)).toEqual(task)
    expect(h.logs).toHaveLength(0)
  })

  it('G1.10 payloads over one MiB and serialization failures are refused safely without writes', async () => {
    expect(fixture().history.length).toBeGreaterThan(0)
    const h = get()
    const task = fixture()
    task.metadata = { huge: 'é'.repeat(600_000) }
    expect(Buffer.byteLength(JSON.stringify(Task.toJSON(task)))).toBeGreaterThan(1024 * 1024)
    await expect(h.store.save(task, alice)).rejects.toThrow('Internal server error')
    expect(await h.rows()).toHaveLength(0)
    task.metadata = { unsupported: BigInt(1) }
    await expect(h.store.save(task, alice)).rejects.toThrow('Internal server error')
    expect(await h.rows()).toHaveLength(0)
    expect(h.logs.map((entry) => entry.operation)).toEqual(['a2a.v1.store.serialization', 'a2a.v1.store.serialization'])
  })

  it('G1.11 malformed stored rows are not found and logged without exposing row text', async () => {
    expect(fixture().artifacts.length).toBeGreaterThan(0)
    const h = get()
    const task = fixture()
    await h.store.save(task, alice)
    expect(await h.store.load(task.id, alice)).toEqual(task)
    for (const malformed of [
      { ...Task.toJSON(task) as object, status: { state: 'fixture-malformed-detail' } },
      { ...Task.toJSON(task) as object, history: [{ messageId: 'bad', parts: 'fixture-malformed-detail' }] },
      { ...Task.toJSON(task) as object, id: 'mismatched-payload-id' },
    ]) {
      await h.corrupt(task.id, malformed)
      expect(await h.store.load(task.id, alice)).toBeUndefined()
      const response = await rpc(h.store, 'GetTask', { id: task.id })
      expect(response.body.error?.code).toBe(-32001)
      expect(response.text).not.toContain('fixture-malformed-detail')
    }
    expect(h.logs.filter((entry) => entry.operation === 'a2a.v1.store.malformed-row')).toHaveLength(6)
  })

  it('G1.12 save load and list DB failures pass the M1 wrapper as generic -32603 errors', async () => {
    expect(fixture().id.length).toBeGreaterThan(0)
    const h = get()
    const task = fixture()
    await h.store.save(task, alice)
    expect(await h.rows()).toHaveLength(1)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const operation of ['save', 'load', 'list'] as const) {
      const restore = await h.fault(operation)
      try {
        const method = operation === 'save' ? 'CancelTask' : operation === 'load' ? 'GetTask' : 'ListTasks'
        const response = await rpc(h.store, method, operation === 'list' ? {} : { id: task.id })
        expect(response.body.error).toMatchObject({ code: -32603, message: 'Internal server error' })
        expect(response.text).not.toContain('fixture-db-driver-detail')
        expect(response.text).not.toContain('a2a_v1_tasks')
      } finally { await restore() }
    }
    expect(logged.mock.calls.length).toBeGreaterThan(0)
    expect(JSON.stringify(logged.mock.calls)).toContain('a2a.v1.task-store')
    expect(await h.store.load(task.id, alice)).toEqual(task)
  })

  it('G1.13 JSON tuple owner keys do not collide across delimiter-containing identities', async () => {
    expect(fixture().contextId.length).toBeGreaterThan(0)
    const h = get()
    const left = scope('a|b', 'c')
    const right = scope('a', 'b|c')
    expect(dzupOwnerResolver(left)).not.toBe(dzupOwnerResolver(right))
    const a = fixture('tuple-task', 'TASK_STATE_WORKING', 'left-context')
    const b = fixture('tuple-task', 'TASK_STATE_INPUT_REQUIRED', 'right-context')
    await h.store.save(a, left)
    await h.store.save(b, right)
    expect(await h.rows()).toHaveLength(2)
    expect(await h.store.load(a.id, left)).toEqual(a)
    expect(await h.store.load(b.id, right)).toEqual(b)
  })
}
// END conformance cases.

describe('DrizzleA2AV1TaskStore conformance against an in-test fake', () => {
  let harness: Harness
  let fakeDb: FakeDatabase
  beforeEach(() => {
    const fake = new FakeDatabase()
    fakeDb = fake
    const db = fake as unknown as DrizzleStoreDatabase
    const logs: LogEntry[] = []
    const newStore = () => createDrizzleA2AV1TaskStore(db, { logger: (entry) => logs.push(entry) })
    harness = {
      store: newStore(), newStore, logs,
      rows: async () => structuredClone(fake.rows),
      corrupt: async (id, task) => { fake.rows.find((row) => row.id === id)!.task = structuredClone(task) },
      relocateTenant: async (id, tenantId) => { fake.rows.find((row) => row.id === id)!.tenantId = tenantId },
      fault: async (operation) => { fake.failure = operation; return async () => { fake.failure = undefined } },
      race: async (first, second) => { await Promise.all([harness.store.save(first, alice), newStore().save(second, alice)]) },
    }
  })
  afterEach(() => vi.restoreAllMocks())
  registerCases(() => harness)

  it('G1.14 list bounds row retrieval in SQL and never materialises the whole scoped set', async () => {
    const total = 30
    for (let i = 0; i < total; i++) await harness.store.save(fixture(`bounded-${String(i).padStart(2, '0')}`, 'TASK_STATE_WORKING', 'bounded-context', `2026-10-10T10:00:${String(i).padStart(2, '0')}.000Z`), alice)
    expect(fakeDb.rows).toHaveLength(total)
    fakeDb.selects.length = 0
    const params = listing({ contextId: 'bounded-context', pageSize: 2 })
    let token = ''
    let pages = 0
    const seen: string[] = []
    do {
      const page = await harness.store.list(token ? { ...params, pageToken: token } : params, alice)
      seen.push(...page.tasks.map((task) => task.id))
      expect(page.totalSize).toBe(total)
      token = page.nextPageToken
      pages += 1
    } while (token && pages < total)
    expect(seen).toHaveLength(total)
    expect(new Set(seen).size).toBe(total)
    const pageQueries = fakeDb.selects.filter((entry) => !entry.counting)
    expect(pageQueries).toHaveLength(pages)
    // Each page query carries LIMIT pageSize + 1 and never returns the full scoped set.
    for (const query of pageQueries) {
      expect(query.limit).toBe(3)
      expect(query.returned).toBeLessThanOrEqual(3)
    }
    expect(fakeDb.selects.filter((entry) => entry.counting)).toHaveLength(pages)
  })
})
