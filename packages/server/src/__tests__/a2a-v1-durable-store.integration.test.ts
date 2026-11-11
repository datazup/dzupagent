import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCard, ListTasksRequest, type Message, SendMessageRequest, Task, TaskState, TaskStatusUpdateEvent } from '@a2a-js/sdk'
import { AgentEvent, ServerCallContext, type AgentExecutor, type TaskStore } from '@a2a-js/sdk/server'
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client'
import { serve, type ServerType } from '@hono/node-server'
import { request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { setTimeout as drainTimeout } from 'node:timers/promises'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Client as PgClient } from 'pg'
import type * as PgModule from 'pg'
import type * as TestcontainersModule from 'testcontainers'
import { InMemoryRunStore, InMemoryAgentStore, ModelRegistry, createEventBus } from '@dzupagent/core'
import { createForgeApp } from '../app.js'
import { type DrizzleA2AV1TaskStore, createDrizzleA2AV1TaskStore } from '../a2a/v1/drizzle-task-store.js'
import { VerifiedA2AUser, dzupOwnerResolver } from '../a2a/v1/identity.js'
import { createA2AV1Handler } from '../a2a/v1/request-handler.js'
import type { DrizzleStoreDatabase } from '../persistence/drizzle-store-types.js'
import { requireIntegration } from './helpers/require-integration.js'

let tc: typeof TestcontainersModule | undefined
let available = false
try { tc = await import('testcontainers') } catch { /* capability gate below */ }
try {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  await promisify(execFile)('docker', ['info'], { timeout: 5000 })
  available = true
} catch { /* capability gate below */ }
const gate = requireIntegration({
  name: 'A2A v1 durable TaskStore real Postgres',
  available: tc !== undefined && available,
  reason: tc === undefined ? 'testcontainers is not installed' : 'Docker is unavailable',
})

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

  it('G1.15 totalSize counts stored matching rows, including a malformed row the page drops', async () => {
    // Documented behaviour (A2A-MINORS M2-b): totalSize is the SQL count of stored rows matching the scope and filters.
    // Counting only decodable rows would require decoding the whole scoped set and undo the SQL bound on list();
    // a malformed row is an integrity anomaly that is logged, and an honest total of stored rows is the safer number.
    const h = get()
    const stamps = ['2026-10-10T10:00:01.000Z', '2026-10-10T10:00:02.000Z', '2026-10-10T10:00:03.000Z']
    const tasks = ['count-a', 'count-b', 'count-c'].map((id, i) => fixture(id, 'TASK_STATE_WORKING', 'count-context', stamps[i]!))
    for (const task of tasks) await h.store.save(task, alice)
    expect(await h.rows()).toHaveLength(3)
    const params = listing({ contextId: 'count-context', pageSize: 100 })
    expect((await h.store.list(params, alice)).tasks.map((task) => task.id)).toEqual(['count-c', 'count-b', 'count-a'])
    h.logs.length = 0
    await h.corrupt('count-b', { ...Task.toJSON(tasks[1]!) as object, status: { state: 'fixture-malformed-detail' } })
    const page = await h.store.list(params, alice)
    expect(page.tasks.map((task) => task.id)).toEqual(['count-c', 'count-a'])
    expect(page.totalSize).toBe(3)
    expect(h.logs.filter((entry) => entry.operation === 'a2a.v1.store.malformed-row')).toHaveLength(1)
  })

}
// END conformance cases.

/** HTTP helper follows the official-client M1 fixture; requests stay on loopback. */
const nodeHttpFetch: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Fixture HTTP only')
  const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer())
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(url, { method: request.method, headers: Object.fromEntries(request.headers) }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry))
          else if (value !== undefined) headers.set(name, value)
        }
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500, headers }))
      })
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('Fixture HTTP timeout')))
    if (body) req.write(body)
    req.end()
  })
}

describe.skipIf(gate.shouldSkip)('A2A v1 durable store real Postgres and official SDK client', () => {
  let container: TestcontainersModule.StartedTestContainer | undefined
  let pg: typeof PgModule
  let primary: PgClient
  let replica: PgClient
  let connection: { host: string; port: number; user: string; password: string; database: string }
  let harness: Harness
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined

  beforeAll(async () => {
    const containerModule = tc!
    container = await new containerModule.GenericContainer('postgres:18')
      .withExposedPorts(5432)
      .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'testdb' })
      .withWaitStrategy(tc!.Wait.forAll([
        tc!.Wait.forListeningPorts(), tc!.Wait.forLogMessage(/database system is ready to accept connections/, 2),
      ]))
      .start()
    connection = { host: container.getHost(), port: container.getMappedPort(5432), user: 'test', password: 'test', database: 'testdb' }
    pg = await import('pg')
    primary = new pg.Client(connection)
    replica = new pg.Client(connection)
    await primary.connect()
    await replica.connect()
    const migration = readFileSync(new URL('../../drizzle/0021_a2a_v1_tasks.sql', import.meta.url), 'utf8')
    await primary.query(migration)
    await primary.query(migration) // additive migration is also idempotent
  }, 120_000)

  afterAll(async () => {
    await replica?.end()
    await primary?.end()
    await container?.stop()
  }, 30_000)

  beforeEach(async () => {
    await primary.query('TRUNCATE a2a_v1_tasks')
    const db = drizzle(primary) as unknown as DrizzleStoreDatabase
    const otherDb = drizzle(replica) as unknown as DrizzleStoreDatabase
    const logs: LogEntry[] = []
    const newStore = () => createDrizzleA2AV1TaskStore(db, { logger: (entry) => logs.push(entry) })
    harness = {
      store: newStore(), newStore, logs,
      rows: async () => (await primary.query(
        'SELECT tenant_id AS "tenantId", owner_key AS "ownerKey", id, context_id AS "contextId", state, status_timestamp AS "statusTimestamp", task, created_at AS "createdAt", updated_at AS "updatedAt" FROM a2a_v1_tasks ORDER BY tenant_id, owner_key, id'
      )).rows as Array<Record<string, unknown>>,
      corrupt: async (id, task) => {
        await primary.query('UPDATE a2a_v1_tasks SET task = $1::jsonb WHERE id = $2', [JSON.stringify(task), id])
      },
      relocateTenant: async (id, tenantId) => {
        await primary.query('UPDATE a2a_v1_tasks SET tenant_id = $1 WHERE id = $2', [tenantId, id])
      },
      fault: async (operation) => {
        if (operation === 'save') {
          await primary.query(`CREATE FUNCTION a2a_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'fixture-db-driver-detail'; END; $$`)
          await primary.query('CREATE TRIGGER a2a_fixture_fail BEFORE INSERT OR UPDATE ON a2a_v1_tasks FOR EACH ROW EXECUTE FUNCTION a2a_fixture_fail()')
          return async () => {
            await primary.query('DROP TRIGGER a2a_fixture_fail ON a2a_v1_tasks')
            await primary.query('DROP FUNCTION a2a_fixture_fail()')
          }
        }
        await primary.query('ALTER TABLE a2a_v1_tasks RENAME TO a2a_v1_tasks_unavailable')
        return async () => { await primary.query('ALTER TABLE a2a_v1_tasks_unavailable RENAME TO a2a_v1_tasks') }
      },
      race: async (first, second) => {
        const rival = createDrizzleA2AV1TaskStore(otherDb, { logger: (entry) => logs.push(entry) })
        const pid = Number((await replica.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        await primary.query('BEGIN')
        let contender: Promise<void> | undefined
        try {
          await harness.store.save(first, alice)
          contender = rival.save(second, alice)
          // Observe the real row lock before releasing the first terminal write.
          await vi.waitFor(async () => {
            const blocked = await primary.query('SELECT pg_blocking_pids($1) AS blockers', [pid])
            expect(blocked.rows[0].blockers.length).toBeGreaterThan(0)
          }, { timeout: 5000, interval: 10 })
          await primary.query('COMMIT')
          await contender
        } finally {
          await primary.query('ROLLBACK')
          await contender
        }
      },
    }
  })
  afterEach(async () => {
    await runtime?.close()
    runtime = undefined
    vi.restoreAllMocks()
  })
  registerCases(() => harness)

  async function startRuntime(options: { wrapStore?: (store: DrizzleA2AV1TaskStore) => TaskStore; drainTimeoutMs?: number } = {}) {
    const dbClient = new pg.Client(connection)
    await dbClient.connect()
    let store: DrizzleA2AV1TaskStore | undefined = createDrizzleA2AV1TaskStore(drizzle(dbClient) as unknown as DrizzleStoreDatabase)
    let app: ReturnType<typeof createForgeApp> | undefined
    let server: ServerType
    let base = ''
    const executed: string[] = []
    // Every store operation the SDK starts, so teardown waits for real pending SDK processing instead of event-loop turns.
    const inflight = new Set<Promise<unknown>>()
    const storeFailures: unknown[] = []
    const track = <T,>(operation: Promise<T>): Promise<T> => {
      inflight.add(operation)
      operation.then(() => { inflight.delete(operation) }, (error: unknown) => { inflight.delete(operation); storeFailures.push(error) })
      return operation
    }
    const durable: TaskStore = options.wrapStore ? options.wrapStore(store!) : store!
    const trackedStore: TaskStore = {
      load: (id, context) => track(durable.load(id, context)),
      save: (task, context) => track(durable.save(task, context)),
      list: (params, context) => track(durable.list(params, context)),
    }
    const canceled: string[] = []
    const gates = new Map<string, { release: () => void; ended: Promise<void> }>()
    const executor: AgentExecutor = {
      async execute(context, bus) {
        executed.push(context.userMessage.messageId)
        const content = context.userMessage.parts[0]?.content
        const finish = content?.$case === 'text' && content.value === 'finish'
        const immediate = context.request.configuration?.returnImmediately === true
        // SDK 1.3.0 keeps the bus open for INPUT_REQUIRED, so a blocking send would never resolve; input-required tasks are created with returnImmediately.
        const holds = immediate && ['working', 'poke', 'serialize'].includes(content?.$case === 'text' ? content.value : '')
        const text = content?.$case === 'text' ? content.value : ''
        const workingLike = immediate && ['working', 'poke', 'serialize', 'throw'].includes(text)
        const state = finish ? 'TASK_STATE_COMPLETED' : workingLike ? 'TASK_STATE_WORKING' : 'TASK_STATE_INPUT_REQUIRED'
        const task = fixture(context.taskId, state, context.contextId)
        task.history = context.task?.history ?? [context.userMessage]
        task.metadata = { ...task.metadata, executions: executed.length }
        let release: () => void = () => {}
        let end: () => void = () => {}
        const wait = new Promise<void>((resolve) => { release = resolve })
        const ended = new Promise<void>((resolve) => { end = resolve })
        if (holds) gates.set(context.taskId, { release, ended })
        bus.publish(AgentEvent.task(task))
        try {
          if (holds) await wait
          if (text === 'poke') {
            bus.publish(AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON({ taskId: context.taskId, contextId: context.contextId, status: { state: 'TASK_STATE_WORKING' } })))
          }
          if (text === 'serialize') {
            const update = TaskStatusUpdateEvent.fromJSON({ taskId: context.taskId, contextId: context.contextId, status: { state: 'TASK_STATE_WORKING' } })
            update.metadata = { unsupported: BigInt(1) }
            bus.publish(AgentEvent.statusUpdate(update))
          }
          if (text === 'throw') { await Promise.resolve(); throw new Error('fixture-executor-secret-detail') }
        } finally { end() }
      },
      async cancelTask(taskId, bus) {
        canceled.push(taskId)
        const task = await store!.load(taskId, alice)
        if (!task) throw new Error('Missing fixture task')
        bus.publish(AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON({
          taskId, contextId: task.contextId, status: { state: 'TASK_STATE_CANCELED', timestamp: '2026-10-10T12:00:00Z' },
        })))
        gates.get(taskId)?.release()
      },
    }
    await new Promise<void>((resolve) => {
      server = serve({ fetch: (request) => app!.fetch(request), port: 0, hostname: '127.0.0.1' }, (info) => {
        base = `http://127.0.0.1:${info.port}`
        app = createForgeApp({
          runStore: new InMemoryRunStore(), agentStore: new InMemoryAgentStore(),
          modelRegistry: new ModelRegistry(), eventBus: createEventBus(),
          auth: { mode: 'api-key', validateKey: async (label) => ({
            alice: { id: 'alice-fixture', tenantId: 'tenant-fixture', role: 'admin' },
            bob: { id: 'bob-fixture', tenantId: 'tenant-fixture', role: 'admin' },
            otherTenant: { id: 'alice-fixture', tenantId: 'other-tenant', role: 'admin' },
          })[label as 'alice' | 'bob' | 'otherTenant'] ?? null },
          a2a: {
            agentCardConfig: { name: 'durable-sdk-fixture', description: 'Durability fixture', baseUrl: base, version: '1', authType: 'bearer', agents: [] },
            v1: { executor, taskStore: trackedStore },
          },
        })
        resolve()
      })
    })
    const clientFor = async (label = 'alice') => {
      const fetchImpl: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init)
        request.headers.set('Authorization', `Bearer ${label}`)
        return nodeHttpFetch(request)
      }
      return new ClientFactory({
        transports: [new JsonRpcTransportFactory({ fetchImpl })],
        cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
      }).createFromUrl(base)
    }
    let closed = false
    const api = {
      clientFor, executed, canceled, storeFailures, expectedFailures: 0, dbClient, track,
      serverListening: () => server.listening,
      release: (id: string) => gates.get(id)!.release(),
      ended: (id: string) => gates.get(id)!.ended,
      close: async () => {
        if (closed) return
        closed = true
        // End the fixture execution without publishing a new state; this leaves
        // the same working payload a process loss would leave in Postgres.
        for (const gate of gates.values()) gate.release()
        await Promise.all([...gates.values()].map((gate) => gate.ended))
        // Drain: wait until no store operation is in flight across two consecutive event-loop turns.
        // A drain failure is reported only after the server and the DB connection are closed (finally below).
        let drainFailure: unknown
        try {
          const quiet = (async () => {
            for (let calm = 0; calm < 2;) {
              if (inflight.size) { await Promise.allSettled([...inflight]); calm = 0 } else {
                await new Promise<void>((resolve) => setImmediate(resolve))
                if (!inflight.size) calm += 1
              }
            }
          })()
          await Promise.race([quiet, drainTimeout(options.drainTimeoutMs ?? 10_000, undefined, { ref: false }).then(() => { throw new Error('Runtime drain timeout') })])
        } catch (error) {
          drainFailure = error
        }
        try {
          await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        } finally {
          app = undefined
          store = undefined
          await dbClient.end()
        }
        if (drainFailure !== undefined) throw drainFailure
        if (storeFailures.length !== api.expectedFailures) {
          throw new Error(`Unexpected background store failures: ${storeFailures.length} (expected ${api.expectedFailures})`)
        }
      },
    }
    return api
  }

  const send = (text = 'input', values: Record<string, unknown> = {}) => SendMessageRequest.fromJSON({
    message: { messageId: 'sdk-message-fixture', role: 'ROLE_USER', parts: [{ text, mediaType: 'text/plain' }] },
    ...values,
  })
  const taskResult = (value: Task | Message): Task => {
    expect('id' in value).toBe(true)
    if (!('id' in value)) throw new Error('Expected SDK Task')
    expect(value.id.length).toBeGreaterThan(0)
    return value
  }

  it('G2.01 returnImmediately Task survives destruction of app store and connection', async () => {
    expect(fixture().history.length).toBeGreaterThan(0)
    runtime = await startRuntime()
    const client = await runtime.clientFor()
    const sent = taskResult(await client.sendMessage(send('working', { configuration: { returnImmediately: true } })))
    expect(sent.status!.state).toBe(TaskState.TASK_STATE_WORKING)
    const before = await client.getTask({ id: sent.id, tenant: '' })
    expect(before).toEqual(sent)
    expect(before.artifacts.length).toBeGreaterThan(0)
    await runtime.close()
    runtime = await startRuntime()
    expect(await (await runtime.clientFor()).getTask({ id: sent.id, tenant: '' })).toEqual(before)
    expect(runtime.executed).toHaveLength(0)
  })

  it('G2.02 persisted input-required Task accepts follow-up SendMessage after restart and completes', async () => {
    expect(send().message!.parts.length).toBeGreaterThan(0)
    runtime = await startRuntime()
    const task = taskResult(await (await runtime.clientFor()).sendMessage(send('input', { configuration: { returnImmediately: true } })))
    expect(task.status!.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED)
    await runtime.close()
    runtime = await startRuntime()
    const followup = send('finish')
    followup.message!.taskId = task.id
    followup.message!.contextId = task.contextId
    followup.message!.messageId = 'followup-message'
    const completed = taskResult(await (await runtime.clientFor()).sendMessage(followup))
    expect(completed.id).toBe(task.id)
    expect(completed.status!.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(completed.history.map((message) => message.messageId)).toEqual(['sdk-message-fixture', 'followup-message'])
    expect(await harness.newStore().load(task.id, alice)).toEqual(completed)
  })

  it('G2.03 cancel orphaned persisted working Task after restart persists CANCELED through the SDK synthetic path', async () => {
    expect(fixture().status!.timestamp!.length).toBeGreaterThan(0)
    runtime = await startRuntime()
    const task = taskResult(await (await runtime.clientFor()).sendMessage(send('working', { configuration: { returnImmediately: true } })))
    expect(task.status!.state).toBe(TaskState.TASK_STATE_WORKING)
    await runtime.close()
    runtime = await startRuntime()
    const client = await runtime.clientFor()
    expect((await client.getTask({ id: task.id, tenant: '' })).status!.state).toBe(TaskState.TASK_STATE_WORKING)
    for (const label of ['bob', 'otherTenant']) {
      await expect((await runtime.clientFor(label)).cancelTask({ id: task.id, tenant: '', metadata: undefined })).rejects.toMatchObject({ envelopeCode: -32001 })
    }
    expect((await harness.newStore().load(task.id, alice))!.status!.state).toBe(TaskState.TASK_STATE_WORKING)
    const canceled = await client.cancelTask({ id: task.id, tenant: '', metadata: undefined })
    expect(canceled.status!.state).toBe(TaskState.TASK_STATE_CANCELED)
    expect((await harness.newStore().load(task.id, alice))!.status!.state).toBe(TaskState.TASK_STATE_CANCELED)
    // Admission addendum (G2 cancel clause): after a restart the execution's event bus is gone, so the SDK persists a synthetic
    // CANCELED task itself and executor.cancelTask is only called for a live in-process execution.
    const cancelPart = canceled.status!.message!.parts[0]?.content
    expect(cancelPart?.$case === 'text' ? cancelPart.value : undefined).toBe('Task cancellation requested by user.')
    expect(runtime.canceled).toEqual([])
    await expect(client.cancelTask({ id: task.id, tenant: '', metadata: undefined })).rejects.toMatchObject({ envelopeCode: -32002 })
  })

  it('G2.04 cross-owner and cross-tenant reads cancels and follow-ups remain -32001 after restart', async () => {
    expect(fixture().contextId.length).toBeGreaterThan(0)
    runtime = await startRuntime()
    const task = taskResult(await (await runtime.clientFor()).sendMessage(send('input', { configuration: { returnImmediately: true } })))
    expect(task.status!.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED)
    await runtime.close()
    runtime = await startRuntime()
    for (const label of ['bob', 'otherTenant']) {
      const foreign = await runtime.clientFor(label)
      await expect(foreign.getTask({ id: task.id, tenant: '' })).rejects.toMatchObject({ envelopeCode: -32001 })
      await expect(foreign.cancelTask({ id: task.id, tenant: '', metadata: undefined })).rejects.toMatchObject({ envelopeCode: -32001 })
      const followup = send('finish')
      followup.message!.taskId = task.id
      await expect(foreign.sendMessage(followup)).rejects.toMatchObject({ envelopeCode: -32001 })
    }
    expect(await (await runtime.clientFor()).getTask({ id: task.id, tenant: '' })).toEqual(task)
    expect(runtime.executed).toHaveLength(0)
    expect(runtime.canceled).toHaveLength(0)
  })

  it('G2.05 duplicate SendMessage messageId executes again without corrupting Task or history order', async () => {
    expect(send().message!.messageId.length).toBeGreaterThan(0)
    runtime = await startRuntime()
    const task = taskResult(await (await runtime.clientFor()).sendMessage(send('input', { configuration: { returnImmediately: true } })))
    expect(task.history.map((message) => message.messageId)).toEqual(['sdk-message-fixture'])
    await runtime.close()
    runtime = await startRuntime()
    const duplicate = send('input', { configuration: { returnImmediately: true } })
    duplicate.message!.taskId = task.id
    duplicate.message!.contextId = task.contextId
    const repeated = taskResult(await (await runtime.clientFor()).sendMessage(duplicate))
    expect(runtime.executed).toEqual(['sdk-message-fixture'])
    expect(repeated.id).toBe(task.id)
    expect(repeated.contextId).toBe(task.contextId)
    expect(repeated.status!.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED)
    expect(repeated.history.slice(0, task.history.length)).toEqual(task.history)
    expect(repeated.history.map((message) => message.messageId)).toEqual(['sdk-message-fixture', 'sdk-message-fixture'])
    expect(repeated.artifacts).toEqual(task.artifacts)
    expect(await harness.newStore().load(task.id, alice)).toEqual(repeated)
    const finish = send('finish')
    finish.message!.taskId = task.id
    finish.message!.messageId = 'finish-message'
    const completed = taskResult(await (await runtime.clientFor()).sendMessage(finish))
    expect(completed.history.map((message) => message.messageId)).toEqual(['sdk-message-fixture', 'sdk-message-fixture', 'finish-message'])
    expect(completed.status!.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(await harness.newStore().load(task.id, alice)).toEqual(completed)
    expect(await harness.rows()).toHaveLength(1)
  })
  describe('M1 regression with the durable store on real Postgres', () => {
    it('M2-a close() still closes the server and the DB connection when the drain times out, then reports it', async () => {
      expect(send().message!.parts.length).toBeGreaterThan(0)
      runtime = await startRuntime({ drainTimeoutMs: 100 })
      const open = runtime
      expect(open.serverListening()).toBe(true)
      // A store operation that never settles keeps the drain from completing.
      void open.track(new Promise<never>(() => {})).catch(() => {})
      await expect(open.close()).rejects.toThrow('Runtime drain timeout')
      expect(open.serverListening()).toBe(false)
      await expect(open.dbClient.query('SELECT 1')).rejects.toThrow()
      runtime = undefined
    })

    const generic = 'Internal server error'
    const persisted = (id: string) => harness.newStore().load(id, alice)
    const stateOf = async (id: string) => (await persisted(id))?.status?.state
    const toText = (value: unknown) => JSON.stringify(value)

    it('M1.01 live in-process CancelTask calls the executor then persists CANCELED and repeats as -32002', async () => {
      expect(send().message!.parts.length).toBeGreaterThan(0)
      runtime = await startRuntime()
      const client = await runtime.clientFor()
      const task = taskResult(await client.sendMessage(send('working', { configuration: { returnImmediately: true } })))
      expect(task.status!.state).toBe(TaskState.TASK_STATE_WORKING)
      expect(await stateOf(task.id)).toBe(TaskState.TASK_STATE_WORKING)
      const canceled = await client.cancelTask({ id: task.id, tenant: '', metadata: undefined })
      expect(canceled.status!.state).toBe(TaskState.TASK_STATE_CANCELED)
      expect(runtime.canceled).toEqual([task.id])
      await vi.waitFor(async () => { expect(await stateOf(task.id)).toBe(TaskState.TASK_STATE_CANCELED) }, { timeout: 3000, interval: 25 })
      await expect(client.cancelTask({ id: task.id, tenant: '', metadata: undefined })).rejects.toMatchObject({ envelopeCode: -32002 })
      expect(runtime.canceled).toEqual([task.id])
    })

    it('M1.02 an executor failure after returnImmediately persists only the generic failure message', async () => {
      expect(send().message!.parts.length).toBeGreaterThan(0)
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      runtime = await startRuntime()
      const client = await runtime.clientFor()
      const task = taskResult(await client.sendMessage(send('throw', { configuration: { returnImmediately: true } })))
      await vi.waitFor(async () => { expect(await stateOf(task.id)).toBe(TaskState.TASK_STATE_FAILED) }, { timeout: 3000, interval: 25 })
      const stored = (await persisted(task.id))!
      expect(toText(stored)).not.toContain('fixture-executor-secret-detail')
      expect(toText(stored)).toContain(generic)
      expect(JSON.stringify(stored.status!.message)).toContain(generic)
      const viaHttp = toText(await client.getTask({ id: task.id, tenant: '' }))
      expect(viaHttp).not.toContain('fixture-executor-secret-detail')
      expect(JSON.stringify(logged.mock.calls)).toContain('a2a.v1.execute')
    })

    it('M1.03 a transient background DB failure after returnImmediately persists FAILED with the generic message', async () => {
      expect(send().message!.parts.length).toBeGreaterThan(0)
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      let failNextSave = false
      runtime = await startRuntime({
        wrapStore: (inner) => ({
          load: (id, context) => inner.load(id, context),
          save: async (task, context) => {
            if (failNextSave) { failNextSave = false; throw new Error('fixture-db-driver-detail') }
            return inner.save(task, context)
          },
          list: (params, context) => inner.list(params, context),
        }),
      })
      runtime.expectedFailures = 1
      const client = await runtime.clientFor()
      const task = taskResult(await client.sendMessage(send('poke', { configuration: { returnImmediately: true } })))
      expect(task.status!.state).toBe(TaskState.TASK_STATE_WORKING)
      failNextSave = true
      runtime.release(task.id)
      await vi.waitFor(async () => { expect(await stateOf(task.id)).toBe(TaskState.TASK_STATE_FAILED) }, { timeout: 3000, interval: 25 })
      await runtime.ended(task.id)
      const stored = (await persisted(task.id))!
      expect(toText(stored)).not.toContain('fixture-db-driver-detail')
      expect(toText(stored)).toContain(generic)
      expect(stored.history.length).toBeGreaterThan(1)
      expect(toText(await client.getTask({ id: task.id, tenant: '' }))).not.toContain('fixture-db-driver-detail')
      expect(JSON.stringify(logged.mock.calls)).toContain('a2a.v1.task-store')
      expect(await harness.rows()).toHaveLength(1)
    })

    it('M1.04 a background serialization failure after returnImmediately persists FAILED with the generic message', async () => {
      expect(send().message!.parts.length).toBeGreaterThan(0)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      runtime = await startRuntime()
      runtime.expectedFailures = 1
      const client = await runtime.clientFor()
      const task = taskResult(await client.sendMessage(send('serialize', { configuration: { returnImmediately: true } })))
      expect(task.status!.state).toBe(TaskState.TASK_STATE_WORKING)
      runtime.release(task.id)
      await vi.waitFor(async () => { expect(await stateOf(task.id)).toBe(TaskState.TASK_STATE_FAILED) }, { timeout: 3000, interval: 25 })
      await runtime.ended(task.id)
      const stored = (await persisted(task.id))!
      expect(toText(stored)).toContain(generic)
      expect(toText(stored)).not.toContain('unsupported')
      expect(stored.history.length).toBeGreaterThan(1)
      expect(await harness.rows()).toHaveLength(1)
    })
  })

})
