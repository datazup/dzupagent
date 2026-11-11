import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCard, SendMessageRequest, Task, TaskState, TaskStatusUpdateEvent, taskStateToJSON } from '@a2a-js/sdk'
import { AgentEvent, DefaultExecutionEventBusManager, DefaultRequestHandler, ServerCallContext, type AgentExecutor } from '@a2a-js/sdk/server'
import { JsonRpcTaskNotCancelableError } from '@a2a-js/sdk/errors'
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client'
import { serve, type ServerType } from '@hono/node-server'
import { request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Client as PgClient } from 'pg'
import type * as PgModule from 'pg'
import type * as TestcontainersModule from 'testcontainers'
import { InMemoryRunStore, InMemoryAgentStore, ModelRegistry, createEventBus } from '@dzupagent/core'
import { createForgeApp } from '../app.js'
import { createDrizzleA2AV1TaskStore } from '../a2a/v1/drizzle-task-store.js'
import { VerifiedA2AUser, dzupOwnerResolver } from '../a2a/v1/identity.js'
import { createA2AV1Handler } from '../a2a/v1/request-handler.js'
import { A2AV1Recovery, createA2AV1Recovery, type A2AV1RecoveryOptions, type OperationRow, type ScanTimings } from '../a2a/v1/operation-store.js'
import { applyLateResult, recoverOrphanedA2AV1Tasks } from '../a2a/v1/recovery-scanner.js'
import { CANCEL_REFUSED_TEXT, RECOVERY_REQUIRED_TEXT, type A2AExecutionPort } from '../a2a/v1/recovery-port.js'
import type { DrizzleStoreDatabase } from '../persistence/drizzle-store-types.js'
import { requireIntegration } from './helpers/require-integration.js'

// A2A-M3-RECOVERY-20261111-R1 (admission 972a4583): the real-Postgres restart suite. Every database predicate
// (claims, token fence, latest(op), boot fence, claim_kind) is proven here, not by the labelled fakes.
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
  name: 'A2A v1 M3a recovery real Postgres',
  available: tc !== undefined && available,
  reason: tc === undefined ? 'testcontainers is not installed' : 'Docker is unavailable',
})

interface OpRow {
  taskId: string; generation: number; operationKey: string; messageId: string; bootId: string; state: string
  recoveryState: string | null; claimKind: string | null; claimToken: string | null; receipt: string | null; updatedAt: Date | null
}
const digest = (char = 'a') => `sha256:${char.repeat(64)}`
const scope = (tenantId = 'tenant-fixture', ownerId = 'alice-fixture') => new ServerCallContext({
  tenant: tenantId, user: new VerifiedA2AUser({ tenantId, ownerId }), requestedVersion: '1.0',
})
const alice = scope()
const bob = scope('tenant-fixture', 'bob-fixture')
const fixture = (id: string, state = 'TASK_STATE_WORKING', contextId = 'context-fixture') => Task.fromJSON({
  id, contextId,
  status: { state, timestamp: '2026-10-10T10:11:12.345Z', message: { messageId: `status-${id}`, role: 'ROLE_AGENT', parts: [{ text: 'status fixture', mediaType: 'text/plain' }] } },
  history: [{ messageId: `user-${id}`, role: 'ROLE_USER', taskId: id, contextId, parts: [{ text: 'first input', mediaType: 'text/plain' }] }],
})
const card = AgentCard.fromJSON({ name: 'm3a-fixture', defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'] })
const noExecutor: AgentExecutor = { async execute() {}, async cancelTask() {} }
const textOf = (task: Task | undefined) => {
  const content = task?.status?.message?.parts[0]?.content
  return content?.$case === 'text' ? content.value : undefined
}

/** HTTP helper follows the official-client fixture; requests stay on loopback. */
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

describe.skipIf(gate.shouldSkip)('A2A v1 M3a orphan recovery on real Postgres', () => {
  let container: TestcontainersModule.StartedTestContainer | undefined
  let pg: typeof PgModule
  let primary: PgClient
  let connection: { host: string; port: number; user: string; password: string; database: string }
  const servers: ServerType[] = []
  const clients: PgClient[] = []

  const newClient = async () => { const client = new pg.Client(connection); await client.connect(); clients.push(client); return client }
  const dbOf = (client: PgClient) => drizzle(client) as unknown as DrizzleStoreDatabase
  /** A new Recovery instance is a new process boot (new boot_id) over the same database. */
  /** Recovery needs transactions: a pool gives every writer its own connection (a shared Client would interleave statements). */
  let recPool: PgModule.Pool
  let recDb: DrizzleStoreDatabase
  const boot = (opts: Partial<A2AV1RecoveryOptions> = {}) => createA2AV1Recovery(recDb, { logger: () => {}, ...opts })
  const tasks = (opts: { cancelHoldBack?: true } = {}) => createDrizzleA2AV1TaskStore(dbOf(primary), { logger: () => {}, ...opts })
  const ops = async () => (await primary.query(
    `SELECT task_id AS "taskId", generation, operation_key AS "operationKey", message_id AS "messageId", boot_id AS "bootId", state,
            recovery_state AS "recoveryState", claim_kind AS "claimKind", claim_token AS "claimToken",
            recovery_receipt AS "receipt", recovery_updated_at AS "updatedAt" FROM a2a_v1_operations ORDER BY task_id, generation`
  )).rows as OpRow[]
  const op = async (taskId: string, generation = 1) => (await ops()).find((row) => row.taskId === taskId && row.generation === generation)!
  const stored = async (id: string) => tasks().load(id, alice)
  const stateOf = async (id: string) => { const task = await stored(id); return task ? taskStateToJSON(task.status!.state) : undefined }
  const age = async () => { await primary.query(`UPDATE a2a_v1_operations SET created_at = now() - interval '1 hour'`) }
  const expireClaim = async (taskId: string) => { await primary.query(`UPDATE a2a_v1_operations SET recovery_updated_at = now() - interval '1 hour' WHERE task_id = $1`, [taskId]) }
  /** An orphan as a crashed process leaves it: a begun operation and a persisted non-terminal task. */
  const seed = async (recovery: A2AV1Recovery, id: string, state = 'TASK_STATE_WORKING', messageId = `m-${id}`) => {
    const began = await recovery.begin(alice, id, messageId)
    await tasks().save(fixture(id, state), alice)
    return began.operationKey
  }
  const port = (answers: Record<string, unknown> | ((req: { operationKey: string }) => unknown)): A2AExecutionPort & { inspect: ReturnType<typeof vi.fn> } => ({
    inspect: vi.fn(async (request: { operationKey: string }) => {
      const value = await (typeof answers === 'function' ? answers(request) : answers[request.operationKey])
      if (value instanceof Error) throw value
      return value as never
    }),
  })
  const running = { status: 'running', receiptRef: digest('1') }
  const notApplied = { status: 'not_applied', receiptRef: digest('2') }
  const completed = { status: 'terminal', receiptRef: digest('3'), terminal: { state: 'completed', parts: [{ text: 'worker result' }] } }
  const scan = (recovery: A2AV1Recovery, p: A2AExecutionPort | undefined, options: Record<string, number> = {}) =>
    recoverOrphanedA2AV1Tasks(recovery, p, { minAgeMs: 0, ...options })

  beforeAll(async () => {
    container = await new tc!.GenericContainer('postgres:18')
      .withExposedPorts(5432)
      .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'testdb' })
      .withWaitStrategy(tc!.Wait.forAll([
        tc!.Wait.forListeningPorts(), tc!.Wait.forLogMessage(/database system is ready to accept connections/, 2),
      ]))
      .start()
    connection = { host: container.getHost(), port: container.getMappedPort(5432), user: 'test', password: 'test', database: 'testdb' }
    pg = await import('pg')
    primary = await newClient()
    recPool = new pg.Pool({ ...connection, max: 16 })
    recDb = dbOf(recPool as unknown as PgClient)
    for (const file of ['0021_a2a_v1_tasks.sql', '0022_a2a_v1_operations.sql']) {
      const migration = readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8')
      await primary.query(migration)
      await primary.query(migration) // additive and idempotent
    }
  }, 120_000)
  afterAll(async () => { await recPool?.end().catch(() => {}); for (const client of clients) await client.end().catch(() => {}); await container?.stop() }, 30_000)
  beforeEach(async () => { await primary.query('TRUNCATE a2a_v1_tasks, a2a_v1_operations'); vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.restoreAllMocks()
  })

  describe('R8 migration 0022', () => {
    it('is additive: the operations table, the unique indexes, the scanner index and the NULLS LAST index exist, a2a_v1_tasks keeps its 9 columns', async () => {
      const columns = (await primary.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'a2a_v1_tasks'`)).rows[0].n
      expect(columns).toBe(9)
      const names = (await primary.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('a2a_v1_operations','a2a_v1_tasks')`)).rows as Array<{ indexname: string; indexdef: string }>
      for (const name of ['a2a_v1_operations_key_uidx', 'a2a_v1_operations_message_uidx', 'a2a_v1_operations_scan_idx', 'a2a_v1_tasks_scope_status_idx', 'a2a_v1_tasks_scope_status_nl_idx']) {
        expect(names.map((row) => row.indexname)).toContain(name)
      }
      expect(names.find((row) => row.indexname === 'a2a_v1_tasks_scope_status_nl_idx')!.indexdef).toContain('NULLS LAST')
      expect(names.find((row) => row.indexname === 'a2a_v1_operations_key_uidx')!.indexdef).toContain('UNIQUE')
    })

    it('the NULLS LAST index serves the list ordering', async () => {
      for (const [id, ts] of [['n-a', '2026-10-10T10:00:00Z'], ['n-b', null], ['n-c', '2026-10-10T11:00:00Z']] as const) {
        await primary.query(`INSERT INTO a2a_v1_tasks (tenant_id, owner_key, id, context_id, state, status_timestamp, task) VALUES ('t','o',$1,'c','TASK_STATE_WORKING',$2,'{}'::jsonb)`, [id, ts])
      }
      await primary.query('SET enable_seqscan = off')
      try {
        const plan = (await primary.query(`EXPLAIN SELECT id FROM a2a_v1_tasks WHERE tenant_id='t' AND owner_key='o' ORDER BY status_timestamp DESC NULLS LAST, id DESC`)).rows.map((row) => row['QUERY PLAN']).join('\n')
        expect(plan).toContain('a2a_v1_tasks_scope_status_nl_idx')
        const rows = (await primary.query(`SELECT id FROM a2a_v1_tasks WHERE tenant_id='t' AND owner_key='o' ORDER BY status_timestamp DESC NULLS LAST, id DESC`)).rows.map((row) => row.id)
        expect(rows).toEqual(['n-c', 'n-a', 'n-b'])
      } finally { await primary.query('RESET enable_seqscan') }
    })

    it('caps the receipt column at 4 KiB', async () => {
      const recovery = boot()
      await recovery.begin(alice, 'cap-task', 'm1')
      await expect(primary.query(`UPDATE a2a_v1_operations SET recovery_receipt = repeat('x', 4097) WHERE task_id = 'cap-task'`)).rejects.toThrow()
    })
  })

  describe('R1 every orphan resolves to exactly one outcome after a restart', () => {
    it.each([
      ['terminal answer', completed, 'TASK_STATE_COMPLETED', null, 'resolved', 'terminal'],
      ['not_applied answer', notApplied, 'TASK_STATE_FAILED', 'not_applied', 'resolved', 'not_applied'],
      ['running answer', running, 'TASK_STATE_WORKING', 'attached', 'started', 'attached'],
      ['unknown status literal', { status: 'maybe', receiptRef: digest() }, 'TASK_STATE_WORKING', 'recovery_required', 'started', 'recovery_required'],
      ['retired stopped literal', { status: 'stopped', receiptRef: digest() }, 'TASK_STATE_WORKING', 'recovery_required', 'started', 'recovery_required'],
      ['bad digest', { status: 'running', receiptRef: 'sha256:nope' }, 'TASK_STATE_WORKING', 'recovery_required', 'started', 'recovery_required'],
      ['missing receipt', { status: 'running' }, 'TASK_STATE_WORKING', 'recovery_required', 'started', 'recovery_required'],
      ['oversized terminal parts', { status: 'terminal', receiptRef: digest(), terminal: { state: 'completed', parts: [{ text: 'x'.repeat(1024 * 1024 + 1) }] } }, 'TASK_STATE_WORKING', 'recovery_required', 'started', 'recovery_required'],
      ['non-text terminal parts', { status: 'terminal', receiptRef: digest(), terminal: { state: 'completed', parts: [{ data: { a: 1 } }] } }, 'TASK_STATE_WORKING', 'recovery_required', 'started', 'recovery_required'],
      ['thrown port error', new Error('fixture-port-secret'), 'TASK_STATE_WORKING', 'recovery_required', 'started', 'recovery_required'],
    ])('%s', async (_label, answer, taskState, recoveryState, opState, outcome) => {
      const before = boot()
      const key = await seed(before, 'orphan-1')
      const results = await scan(boot(), port({ [key]: answer }))
      expect(results).toEqual([{ operationKey: key, outcome }])
      expect(await stateOf('orphan-1')).toBe(taskState)
      expect(await op('orphan-1')).toMatchObject({ recoveryState, state: opState })
      expect(JSON.stringify(await stored('orphan-1'))).not.toContain('fixture-port-secret')
    })

    it('a failure after the claim (a terminal result that cannot be stored) still ends recovery_required, never silently unflagged', async () => {
      const key = await seed(boot(), 'big-1')
      const oversized = { status: 'terminal', receiptRef: digest(), terminal: { state: 'completed', parts: [{ text: 'x'.repeat(1024 * 1024) }] } }
      expect(await scan(boot(), port({ [key]: oversized }))).toEqual([{ operationKey: key, outcome: 'recovery_required' }])
      expect(await op('big-1')).toMatchObject({ recoveryState: 'recovery_required', state: 'started' })
      expect(await stateOf('big-1')).toBe('TASK_STATE_WORKING')
      // The row is visible (recovery_required) and is not a candidate again.
      const again = port({})
      expect(await scan(boot(), again)).toEqual([])
      expect(again.inspect).not.toHaveBeenCalled()
    })

    it('a timed-out inspect is unknown and the orphan is flagged recovery_required', async () => {
      const key = await seed(boot(), 'slow-1')
      const slow: A2AExecutionPort = { inspect: () => new Promise(() => {}) }
      expect(await scan(boot(), slow, { inspectTimeoutMs: 50 })).toEqual([{ operationKey: key, outcome: 'recovery_required' }])
      expect(await op('slow-1')).toMatchObject({ recoveryState: 'recovery_required', state: 'started' })
    })

    it('D10: with no port configured every orphan is recovery_required (never a guess)', async () => {
      const key = await seed(boot(), 'noport-1')
      expect(await scan(boot(), undefined)).toEqual([{ operationKey: key, outcome: 'recovery_required' }])
      expect(await stateOf('noport-1')).toBe('TASK_STATE_WORKING')
    })

    it('terminal answer stores the worker parts as the status message and the guard keeps the task final', async () => {
      const key = await seed(boot(), 'term-1')
      await scan(boot(), port({ [key]: completed }))
      expect(textOf(await stored('term-1'))).toBe('worker result')
    })

    it('a second pass changes nothing and a task that is not scanned stays untouched', async () => {
      const keyA = await seed(boot(), 'again-1')
      const first = port({ [keyA]: running })
      const recovery = boot()
      expect(await scan(recovery, first)).toHaveLength(1)
      const second = port({})
      expect(await scan(boot(), second)).toEqual([])
      expect(second.inspect).not.toHaveBeenCalled()
    })

    it('completed, input-required, auth-required and superseded-generation operations are never scanned', async () => {
      const writer = boot()
      await seed(writer, 'done-1', 'TASK_STATE_COMPLETED')
      await seed(writer, 'input-1', 'TASK_STATE_INPUT_REQUIRED')
      await seed(writer, 'auth-1', 'TASK_STATE_AUTH_REQUIRED')
      await seed(writer, 'super-1', 'TASK_STATE_WORKING', 'first')
      const latestKey = (await writer.begin(alice, 'super-1', 'second')).operationKey
      const before = await ops()
      const p = port({ [latestKey]: running })
      const results = await scan(boot(), p)
      expect(results).toEqual([{ operationKey: latestKey, outcome: 'attached' }])
      expect(p.inspect).toHaveBeenCalledTimes(1)
      const after = await ops()
      for (const row of after.filter((entry) => entry.operationKey !== latestKey)) {
        expect(row).toEqual(before.find((entry) => entry.operationKey === row.operationKey))
      }
    })

    it('a never-claimed started operation of a terminal task stays inert and is never scanned', async () => {
      await seed(boot(), 'inert-1', 'TASK_STATE_COMPLETED')
      const p = port({})
      expect(await scan(boot(), p)).toEqual([])
      expect(p.inspect).not.toHaveBeenCalled()
      expect(await op('inert-1')).toMatchObject({ state: 'started', recoveryState: null })
    })

    it('an orphan with no task row is resolved on the operation row alone and no task is fabricated', async () => {
      const key = (await boot().begin(alice, 'ghost-1', 'm1')).operationKey
      expect(await scan(boot(), port({ [key]: notApplied }))).toEqual([{ operationKey: key, outcome: 'not_applied' }])
      expect(await stored('ghost-1')).toBeUndefined()
      expect(await op('ghost-1')).toMatchObject({ state: 'resolved', recoveryState: 'not_applied' })
      const key2 = (await boot().begin(alice, 'ghost-2', 'm1')).operationKey
      expect(await scan(boot(), port({ [key2]: running }))).toEqual([{ operationKey: key2, outcome: 'attached' }])
      expect(await stored('ghost-2')).toBeUndefined() // attached with no task row exists only as the stored receipt
    })

    it('a just-begun operation younger than minAgeMs is not claimed and the live process never claims its own work', async () => {
      const live = boot()
      const key = await seed(live, 'young-1')
      const p = port({ [key]: running })
      expect(await recoverOrphanedA2AV1Tasks(live, p, { minAgeMs: 0 })).toEqual([]) // own boot: never an orphan
      const other = boot()
      expect(await recoverOrphanedA2AV1Tasks(other, p, { minAgeMs: 60_000 })).toEqual([]) // other boot but younger than minAgeMs
      expect(p.inspect).not.toHaveBeenCalled()
      await age()
      expect(await recoverOrphanedA2AV1Tasks(other, p)).toEqual([{ operationKey: key, outcome: 'attached' }])
    })
  })

  describe('R2 the scanner and the late-result path never start work', () => {
    it('two concurrent scanners resolve each orphan once and an executor is never called', async () => {
      const execute = vi.fn(async () => {})
      createA2AV1Handler({ agentCard: card, executor: { execute, async cancelTask() {} }, taskStore: tasks(), recovery: boot() })
      const keys = [await seed(boot(), 'race-1'), await seed(boot(), 'race-2'), await seed(boot(), 'race-3')]
      const p = port(async () => { await sleep(20); return notApplied })
      const [a, b] = await Promise.all([scan(boot(), p), scan(boot(), p)])
      expect(p.inspect).toHaveBeenCalledTimes(3)
      expect([...a, ...b].map((entry) => entry.operationKey).sort()).toEqual([...keys].sort())
      expect(execute).not.toHaveBeenCalled()
      for (const id of ['race-1', 'race-2', 'race-3']) expect(await stateOf(id)).toBe('TASK_STATE_FAILED')
    })
  })

  describe('R3 late results', () => {
    it('after not_applied the result is only recorded as {digest,state,byteLength}; the task stays FAILED; a second record is refused', async () => {
      const recovery = boot()
      const key = await seed(recovery, 'late-1')
      await scan(boot(), port({ [key]: notApplied }))
      const big = { state: 'completed' as const, parts: [{ text: 'z'.repeat(1024 * 1024) }] }
      expect(await applyLateResult(recovery, key, big)).toBe('recorded')
      const row = await op('late-1')
      expect(row.receipt!.length).toBeLessThan(4096)
      expect(JSON.parse(row.receipt!)).toEqual({ digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), state: 'completed', byteLength: 1024 * 1024 })
      expect(row.receipt).not.toContain('zzzz')
      expect(await stateOf('late-1')).toBe('TASK_STATE_FAILED')
      const receipt = row.receipt
      expect(await applyLateResult(recovery, key, { state: 'failed', parts: [{ text: 'other' }] })).toBe('refused')
      expect((await op('late-1')).receipt).toBe(receipt) // first record wins
    })

    it('an attached task and a recovery_required task apply a late terminal result through the guard under a fresh claim', async () => {
      const keyA = await seed(boot(), 'late-a')
      const keyR = await seed(boot(), 'late-r')
      const scanner = boot()
      await scan(scanner, port({ [keyA]: running, [keyR]: { status: 'maybe', receiptRef: digest() } }))
      const caller = boot()
      expect(await applyLateResult(caller, keyA, { state: 'completed', parts: [{ text: 'late done' }] })).toBe('applied')
      expect(await applyLateResult(caller, keyR, { state: 'failed', parts: [{ text: 'late failed' }] })).toBe('applied')
      expect(await stateOf('late-a')).toBe('TASK_STATE_COMPLETED')
      expect(textOf(await stored('late-a'))).toBe('late done')
      expect(await stateOf('late-r')).toBe('TASK_STATE_FAILED')
      expect(await op('late-a')).toMatchObject({ state: 'resolved', recoveryState: null, bootId: caller.bootId })
    })

    it('a late result for an attached row whose task is already terminal resolves the row and returns applied_noop', async () => {
      const key = await seed(boot(), 'late-t')
      await scan(boot(), port({ [key]: running }))
      await tasks().save(fixture('late-t', 'TASK_STATE_COMPLETED'), alice) // a live completion won
      expect(await applyLateResult(boot(), key, { state: 'failed', parts: [{ text: 'too late' }] })).toBe('applied_noop')
      expect(await stateOf('late-t')).toBe('TASK_STATE_COMPLETED')
      expect(textOf(await stored('late-t'))).toBe('status fixture')
      expect(await op('late-t')).toMatchObject({ state: 'resolved', recoveryState: null })
    })

    it('a late result with no task row resolves the operation only and never creates a task', async () => {
      const key = (await boot().begin(alice, 'late-g', 'm1')).operationKey
      await scan(boot(), port({ [key]: running }))
      expect(await applyLateResult(boot(), key, { state: 'completed', parts: [{ text: 'x' }] })).toBe('applied')
      expect(await stored('late-g')).toBeUndefined()
      expect(await op('late-g')).toMatchObject({ state: 'resolved' })
    })

    it('a generation superseded between the late claim and the task write returns stale, applies nothing and resolves the old generation', async () => {
      class Interleaving extends A2AV1Recovery {
        override async claimLate(row: OperationRow, token: string, timings: ScanTimings) {
          const claimed = await super.claimLate(row, token, timings)
          await new A2AV1Recovery(this.db, { logger: () => {} }).begin(alice, row.taskId, 'follow-up') // a follow-up arrives in between
          return claimed
        }
      }
      const key = await seed(boot(), 'late-f')
      await scan(boot(), port({ [key]: running }))
      const result = await applyLateResult(new Interleaving(recDb, { logger: () => {} }), key, { state: 'completed', parts: [{ text: 'x' }] })
      expect(result).toBe('stale')
      expect(await stateOf('late-f')).toBe('TASK_STATE_WORKING')
      expect(await op('late-f', 1)).toMatchObject({ state: 'resolved' })
      expect(await op('late-f', 2)).toMatchObject({ state: 'started', recoveryState: null })
    })

    it('stale, busy and refused results', async () => {
      const recovery = boot()
      const first = await seed(recovery, 'late-s', 'TASK_STATE_WORKING', 'm1')
      await recovery.begin(alice, 'late-s', 'm2')
      expect(await applyLateResult(recovery, first, { state: 'completed', parts: [{ text: 'x' }] })).toBe('stale')
      const keyB = await seed(recovery, 'late-b')
      expect(await applyLateResult(recovery, keyB, { state: 'completed', parts: [{ text: 'x' }] })).toBe('refused') // started, nothing to apply to
      await scan(boot(), port({ [keyB]: running }))
      await primary.query(`UPDATE a2a_v1_operations SET recovery_state='recovering', claim_kind='late', claim_token='held', recovery_updated_at = now() WHERE task_id='late-b'`)
      expect(await applyLateResult(boot(), keyB, { state: 'completed', parts: [{ text: 'x' }] })).toBe('busy')
      await primary.query(`UPDATE a2a_v1_operations SET claim_kind='scan' WHERE task_id='late-b'`)
      expect(await applyLateResult(boot(), keyB, { state: 'completed', parts: [{ text: 'x' }] })).toBe('refused') // an unexpired scan claim is refused, not busy
      expect(await applyLateResult(boot(), keyB, { state: 'completed', parts: [] } as never)).toBe('refused') // invalid result
    })
  })

  describe('R10 interleavings driven from the writer and predicate table', () => {
    it('scanner claim vs a live completion: the guard keeps COMPLETED, no FAILED over it, the operation is resolved', async () => {
      const key = await seed(boot(), 'live-1')
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const p = port(async () => { await gate; return notApplied })
      const scanning = scan(boot(), p)
      await vi.waitFor(() => expect(p.inspect).toHaveBeenCalled())
      await tasks().save(fixture('live-1', 'TASK_STATE_COMPLETED'), alice)
      release()
      expect(await scanning).toEqual([{ operationKey: key, outcome: 'superseded' }])
      expect(await stateOf('live-1')).toBe('TASK_STATE_COMPLETED')
      expect(await op('live-1')).toMatchObject({ state: 'resolved' })
    })

    it('a stale-token scanner is fenced: an expired claim is reclaimed and the first scanner changes neither task nor operation', async () => {
      const key = await seed(boot(), 'stale-1')
      let release!: () => void
      const hold = new Promise<void>((resolve) => { release = resolve })
      const slow = port(async () => { await hold; return notApplied })
      const first = scan(boot(), slow)
      await vi.waitFor(() => expect(slow.inspect).toHaveBeenCalled())
      await expireClaim('stale-1')
      const second = await scan(boot(), port({ [key]: completed }))
      expect(second).toEqual([{ operationKey: key, outcome: 'terminal' }])
      release()
      expect(await first).toEqual([{ operationKey: key, outcome: 'stale' }])
      expect(await stateOf('stale-1')).toBe('TASK_STATE_COMPLETED')
      expect(await op('stale-1')).toMatchObject({ state: 'resolved' })
    })

    it('a stale scanner that resumes while the reclaiming scanner still holds the claim changes neither the task nor the operation row', async () => {
      const key = await seed(boot(), 'overlap-1')
      let releaseFirst!: () => void
      let releaseSecond!: () => void
      const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve })
      const holdSecond = new Promise<void>((resolve) => { releaseSecond = resolve })
      const first = port(async () => { await holdFirst; return notApplied })
      const second = port(async () => { await holdSecond; return completed })
      const firstScan = scan(boot(), first)
      await vi.waitFor(() => expect(first.inspect).toHaveBeenCalled())
      await expireClaim('overlap-1')
      const secondScan = scan(boot(), second)
      await vi.waitFor(() => expect(second.inspect).toHaveBeenCalled())
      const held = await op('overlap-1')
      releaseFirst()
      expect(await firstScan).toEqual([{ operationKey: key, outcome: 'stale' }])
      expect(await op('overlap-1')).toMatchObject({ state: 'started', recoveryState: 'recovering', claimToken: held.claimToken })
      expect(await stateOf('overlap-1')).toBe('TASK_STATE_WORKING')
      releaseSecond()
      expect(await secondScan).toEqual([{ operationKey: key, outcome: 'terminal' }])
      expect(await stateOf('overlap-1')).toBe('TASK_STATE_COMPLETED')
    })

    it('an expired scan claim is reclaimed by a scanner of the same boot', async () => {
      const recovery = boot()
      const key = await seed(boot(), 'same-1')
      await primary.query(`UPDATE a2a_v1_operations SET recovery_state='recovering', claim_kind='scan', claim_token='dead', boot_id=$1, recovery_updated_at = now() - interval '1 hour' WHERE task_id='same-1'`, [recovery.bootId])
      expect(await scan(recovery, port({ [key]: running }))).toEqual([{ operationKey: key, outcome: 'attached' }])
    })

    it('P_FINISH: a crash between the terminal task write and the operation write is finished after the TTL, without an inspect or a second task write', async () => {
      const key = await seed(boot(), 'fin-1')
      await tasks().save(fixture('fin-1', 'TASK_STATE_COMPLETED'), alice)
      await primary.query(`UPDATE a2a_v1_operations SET recovery_state='recovering', claim_kind='scan', claim_token='dead', recovery_updated_at = now() WHERE task_id='fin-1'`)
      const p = port({})
      expect(await scan(boot(), p)).toEqual([]) // claim not expired yet
      await expireClaim('fin-1')
      const updatedBefore = (await primary.query(`SELECT updated_at FROM a2a_v1_tasks WHERE id='fin-1'`)).rows[0].updated_at
      expect(await scan(boot(), p)).toEqual([{ operationKey: key, outcome: 'finished' }])
      expect(p.inspect).not.toHaveBeenCalled()
      expect(await op('fin-1')).toMatchObject({ state: 'resolved' })
      expect((await primary.query(`SELECT updated_at FROM a2a_v1_tasks WHERE id='fin-1'`)).rows[0].updated_at).toEqual(updatedBefore)
    })

    it('a scanner claim on generation n followed by generation n+1 refuses the scanner task write (latest(op)) and resolves n', async () => {
      const writer = boot()
      const key1 = await seed(writer, 'gen-1', 'TASK_STATE_WORKING', 'm1')
      let release!: () => void
      const hold = new Promise<void>((resolve) => { release = resolve })
      const slow = port(async () => { await hold; return notApplied })
      const scanner = boot()
      const scanning = scan(scanner, slow)
      await vi.waitFor(() => expect(slow.inspect).toHaveBeenCalled())
      const second = await scanner.begin(alice, 'gen-1', 'm2') // a follow-up (served by the scanner boot) creates generation 2
      expect(second.generation).toBe(2)
      release()
      expect(await scanning).toEqual([{ operationKey: key1, outcome: 'superseded' }])
      expect(await stateOf('gen-1')).toBe('TASK_STATE_WORKING')
      expect(await op('gen-1', 1)).toMatchObject({ state: 'resolved' })
      expect(await op('gen-1', 2)).toMatchObject({ state: 'started', recoveryState: null })
    })

    it('a crashed late-apply claim (kind late) is never reclaimed by a scanner; recovery_required is not overwritten; a later applyLateResult reclaims it and stamps its boot', async () => {
      const key = await seed(boot(), 'crash-1')
      await scan(boot(), port({ [key]: { status: 'maybe', receiptRef: digest() } }))
      expect(await op('crash-1')).toMatchObject({ recoveryState: 'recovery_required' })
      // The task write of the late apply fails after the claim: the claim is left behind.
      await primary.query(`CREATE FUNCTION a2a_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-db-detail'; END; $$`)
      await primary.query('CREATE TRIGGER a2a_fixture_fail BEFORE UPDATE ON a2a_v1_tasks FOR EACH ROW EXECUTE FUNCTION a2a_fixture_fail()')
      const bootB = boot()
      try {
        await expect(applyLateResult(bootB, key, { state: 'completed', parts: [{ text: 'x' }] })).rejects.toThrow('Internal server error')
      } finally {
        await primary.query('DROP TRIGGER a2a_fixture_fail ON a2a_v1_tasks')
        await primary.query('DROP FUNCTION a2a_fixture_fail()')
      }
      expect(await op('crash-1')).toMatchObject({ recoveryState: 'recovering', claimKind: 'late', bootId: bootB.bootId })
      await expireClaim('crash-1')
      const p = port({ [key]: notApplied })
      expect(await scan(boot(), p)).toEqual([]) // boot C: the scanner never reclaims a late claim
      expect(p.inspect).not.toHaveBeenCalled()
      expect(await stateOf('crash-1')).toBe('TASK_STATE_WORKING') // not overwritten with FAILED
      const bootC = boot()
      expect(await applyLateResult(bootC, key, { state: 'completed', parts: [{ text: 'recovered' }] })).toBe('applied')
      expect(await stateOf('crash-1')).toBe('TASK_STATE_COMPLETED')
    })

    it('a repeated messageId retry vs a scanner claim has exactly two outcomes', async () => {
      // Outcome 1: the retry wins. The row is stamped with the retry boot, so the scanner of that boot never sees an orphan.
      const retrier = boot()
      const key = await seed(boot(), 'retry-1', 'TASK_STATE_WORKING', 'same-message')
      const kept = await retrier.begin(alice, 'retry-1', 'same-message')
      expect(kept.operationKey).toBe(key)
      expect((await op('retry-1')).bootId).toBe(retrier.bootId)
      const p1 = port({ [key]: notApplied })
      expect(await scan(retrier, p1)).toEqual([])
      expect(p1.inspect).not.toHaveBeenCalled()
      // Outcome 2: the claim wins. The retry is refused and the executor is not invoked.
      const key2 = await seed(boot(), 'retry-2', 'TASK_STATE_WORKING', 'same-message')
      await scan(boot(), port({ [key2]: running }))
      await expect(boot().begin(alice, 'retry-2', 'same-message')).rejects.toThrow()
      const execute = vi.fn(async () => {})
      const recovery = boot()
      const stateBefore = await stateOf('retry-2')
      const operationBefore = await op('retry-2')
      const v1 = createA2AV1Handler({ agentCard: card, executor: { execute, async cancelTask() {} }, taskStore: tasks(), recovery })
      const response = await v1.handler.handle({
        jsonrpc: '2.0', id: 'retry', method: 'SendMessage',
        params: SendMessageRequest.toJSON(SendMessageRequest.fromJSON({ message: { messageId: 'same-message', taskId: 'retry-2', contextId: 'context-fixture', role: 'ROLE_USER', parts: [{ text: 'again', mediaType: 'text/plain' }] }, configuration: { returnImmediately: true } })),
      }, alice)
      expect(execute).not.toHaveBeenCalled()
      expect(JSON.stringify(response)).not.toContain('A2A v1 operation refused')
      expect(JSON.stringify(response)).toContain('Internal server error')
      // The refused retry must not let the SDK persist a synthetic FAILED over the recovered task (review finding).
      expect((response as { result?: unknown }).result).toBeUndefined()
      expect(await stateOf('retry-2')).toBe(stateBefore)
      expect(stateBefore).toBe('TASK_STATE_WORKING')
      expect(await op('retry-2')).toEqual(operationBefore)
      expect(operationBefore.recoveryState).toBe('attached')
    })

    it('a claim landing between the retry pre-check and begin never lets the SDK persist a synthetic FAILED', async () => {
      class LatePrecheck extends A2AV1Recovery {
        override async retryUnderRecovery() { return false } // the pre-check ran before the claim committed
      }
      const key = await seed(boot(), 'window-1', 'TASK_STATE_WORKING', 'same-message')
      await scan(boot(), port({ [key]: running }))
      const before = await op('window-1')
      const execute = vi.fn(async () => {})
      const v1 = createA2AV1Handler({ agentCard: card, executor: { execute, async cancelTask() {} }, taskStore: tasks(), recovery: new LatePrecheck(recDb, { logger: () => {} }) })
      await v1.handler.handle({
        jsonrpc: '2.0', id: 'window', method: 'SendMessage',
        params: SendMessageRequest.toJSON(SendMessageRequest.fromJSON({ message: { messageId: 'same-message', taskId: 'window-1', contextId: 'context-fixture', role: 'ROLE_USER', parts: [{ text: 'again', mediaType: 'text/plain' }] }, configuration: { returnImmediately: true } })),
      }, alice)
      await vi.waitFor(async () => { expect(await stateOf('window-1')).toBe('TASK_STATE_WORKING') })
      expect(execute).not.toHaveBeenCalled()
      expect(await stateOf('window-1')).toBe('TASK_STATE_WORKING')
      expect(await op('window-1')).toEqual(before)
    })

    it('the republish path settles a blocking SendMessage without a hang and without a state change', async () => {
      class LatePrecheck extends A2AV1Recovery {
        override async retryUnderRecovery() { return false }
      }
      const key = await seed(boot(), 'window-2', 'TASK_STATE_WORKING', 'same-message')
      await scan(boot(), port({ [key]: running }))
      const before = await op('window-2')
      const execute = vi.fn(async () => {})
      const v1 = createA2AV1Handler({ agentCard: card, executor: { execute, async cancelTask() {} }, taskStore: tasks(), recovery: new LatePrecheck(recDb, { logger: () => {} }) })
      const params = SendMessageRequest.toJSON(SendMessageRequest.fromJSON({ message: { messageId: 'same-message', taskId: 'window-2', contextId: 'context-fixture', role: 'ROLE_USER', parts: [{ text: 'again', mediaType: 'text/plain' }] } }))
      const blocking = await v1.handler.handle({ jsonrpc: '2.0', id: 'b', method: 'SendMessage', params }, alice)
      expect(Symbol.asyncIterator in blocking).toBe(false)
      expect(execute).not.toHaveBeenCalled()
      expect(await stateOf('window-2')).toBe('TASK_STATE_WORKING')
      expect(await op('window-2')).toEqual(before)
    })

    it('a concurrent retry and scan race never double-resolves: either the retry or the claim wins', async () => {
      for (let i = 0; i < 8; i += 1) {
        const id = `race-r-${i}`
        const key = await seed(boot(), id, 'TASK_STATE_WORKING', 'dup')
        const racer = boot()
        const p = port({ [key]: running })
        const [begun, results] = await Promise.allSettled([racer.begin(alice, id, 'dup'), scan(racer, p)])
        const row = await op(id)
        if (begun.status === 'fulfilled') {
          // The retry stamped the boot first (or the scanner skipped it): the row is not claimed by this boot.
          expect(row.bootId).toBe(racer.bootId)
          expect(row.recoveryState === null || row.recoveryState === 'recovering' || row.recoveryState === 'attached').toBe(true)
        } else {
          expect(row.recoveryState).not.toBeNull()
        }
        expect(results.status).toBe('fulfilled')
      }
    })
  })

  describe('F1 per-task serialization of every recovery writer (independent connections)', () => {
    const waiting = async (...events: string[]) => Number((await primary.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock' AND wait_event = ANY($1)
         AND (query ILIKE '%a2a_v1_%' OR query ILIKE '%pg_advisory_xact_lock%')`, [events]
    )).rows[0].n)
    const holders: PgClient[] = []
    // A failed assertion must never leave a lock held: the next test's TRUNCATE would wait for it forever.
    afterEach(async () => { for (const holder of holders.splice(0)) await holder.query('ROLLBACK').catch(() => {}) })
    const until = (check: () => Promise<void> | void) => vi.waitFor(check, { timeout: 15_000, interval: 50 })
    /** A second connection that holds the task row lock, so a recovery write blocks mid-transaction. */
    const holdTaskRow = async (taskId: string) => {
      const holder = await newClient()
      holders.push(holder)
      await holder.query('BEGIN')
      await holder.query('SELECT 1 FROM a2a_v1_tasks WHERE id = $1 FOR UPDATE', [taskId])
      return async () => { await holder.query('COMMIT') }
    }

    it('scanner: a replacement claim and a new generation cannot commit while the claim owner is writing; the owner changes the task exactly once', async () => {
      const key = await seed(boot(), 'ser-1')
      let releaseInspect!: () => void
      const inspecting = new Promise<void>((resolve) => { releaseInspect = resolve })
      const portA = port(async () => { await inspecting; return notApplied })
      const scanA = scan(boot(), portA)
      await until(() => expect(portA.inspect).toHaveBeenCalled())
      const release = await holdTaskRow('ser-1')
      releaseInspect() // A's commit transaction now takes the per-task lock and blocks on the task row
      await until(async () => expect(await waiting('tuple', 'transactionid')).toBeGreaterThan(0))
      await expireClaim('ser-1') // B may legitimately replace A's now-expired claim
      let replacementSettled = false
      let generationSettled = false
      const portB = port({ [key]: completed })
      const scanB = scan(boot(), portB).then((result) => { replacementSettled = true; return result })
      const nextGeneration = boot().begin(alice, 'ser-1', 'm2').then((result) => { generationSettled = true; return result })
      await until(async () => expect(await waiting('advisory')).toBeGreaterThanOrEqual(2)) // both queue behind A's lock
      expect(replacementSettled).toBe(false)
      expect(generationSettled).toBe(false)
      await release()
      expect(await scanA).toEqual([{ operationKey: key, outcome: 'not_applied' }]) // A still owned the claim when it wrote
      expect(await scanB).toEqual([]) // B then sees a resolved operation and claims nothing
      expect(portB.inspect).not.toHaveBeenCalled()
      expect((await nextGeneration).generation).toBe(2)
      expect(await stateOf('ser-1')).toBe('TASK_STATE_FAILED')
      expect(textOf(await stored('ser-1'))).toBe('Task was not started; resubmit')
    })

    it('late result: a replacement late claim and a new generation cannot commit while the claim owner is writing', async () => {
      const key = await seed(boot(), 'ser-2')
      await scan(boot(), port({ [key]: running }))
      const release = await holdTaskRow('ser-2')
      const lateA = applyLateResult(boot(), key, { state: 'completed', parts: [{ text: 'from A' }] })
      await until(async () => expect(await waiting('tuple', 'transactionid')).toBeGreaterThan(0))
      await expireClaim('ser-2')
      let replacementSettled = false
      let generationSettled = false
      const lateB = applyLateResult(boot(), key, { state: 'failed', parts: [{ text: 'from B' }] }).then((result) => { replacementSettled = true; return result })
      const nextGeneration = boot().begin(alice, 'ser-2', 'm2').then((result) => { generationSettled = true; return result })
      await until(async () => expect(await waiting('advisory')).toBeGreaterThanOrEqual(2))
      expect(replacementSettled).toBe(false)
      expect(generationSettled).toBe(false)
      await release()
      expect(await lateA).toBe('applied')
      expect(await lateB).toBe('refused') // the row was resolved by A before B's claim could run
      expect((await nextGeneration).generation).toBe(2)
      expect(await stateOf('ser-2')).toBe('TASK_STATE_COMPLETED')
      expect(textOf(await stored('ser-2'))).toBe('from A')
    })

    it('repeated-messageId re-stamp and the scanner claim are serialized by the same lock', async () => {
      const writer = boot()
      await seed(writer, 'ser-3', 'TASK_STATE_WORKING', 'same-message')
      await age()
      // Hold the per-task lock from another connection: both the retry and the claim must queue behind it.
      const holder = await newClient()
      holders.push(holder)
      await holder.query('BEGIN')
      const key = `a2a:v1:recovery:${JSON.stringify(['tenant-fixture', JSON.stringify(['tenant-fixture', 'alice-fixture']), 'ser-3'])}`
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 4121955))', [key])
      let retrySettled = false
      let claimSettled = false
      const other = boot()
      const retry = other.begin(alice, 'ser-3', 'same-message').then((result) => { retrySettled = true; return result })
      const claim = recoverOrphanedA2AV1Tasks(other, port({}), { minAgeMs: 0 }).then((result) => { claimSettled = true; return result })
      await until(async () => expect(await waiting('advisory')).toBeGreaterThanOrEqual(1))
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(retrySettled).toBe(false)
      expect(claimSettled).toBe(false)
      await holder.query('COMMIT')
      await retry
      await claim
    })
  })

  describe('F1 recovery requires a connection pool', () => {
    it('refuses a database over a single shared client (advisory locks are re-entrant within one session) and accepts a pool', () => {
      expect(() => createA2AV1Recovery(dbOf(primary))).toThrow('requires a connection pool')
      expect(() => createA2AV1Recovery(recDb)).not.toThrow()
    })
  })

  describe('F2 every accepted part field and the collection size are bounded before any copy or hash', () => {
    it.each([
      ['an oversized mediaType', [{ text: 'x', mediaType: 'm'.repeat(300) }]],
      ['too many empty parts', Array.from({ length: 1000 }, () => ({ text: '' }))],
      ['an unknown metadata field', [{ text: 'x', metadata: { big: 'y'.repeat(2000) } }]],
      ['a filename field', [{ text: 'x', filename: 'f.txt' }]],
    ])('a record-only late result with %s is refused and records nothing', async (_label, parts) => {
      const recovery = boot()
      const key = await seed(recovery, 'bound-1')
      await scan(boot(), port({ [key]: notApplied })) // a not_applied row takes the record-only branch
      expect(await applyLateResult(recovery, key, { state: 'completed', parts: parts as never })).toBe('refused')
      expect((await op('bound-1')).receipt).toBeNull()
      // The admitted 1 MiB text case still records.
      expect(await applyLateResult(recovery, key, { state: 'completed', parts: [{ text: 'z'.repeat(1024 * 1024) }] })).toBe('recorded')
    })
  })

  describe('R2 the recovery modules cannot start work (structural)', () => {
    it('recovery-port, recovery-scanner and operation-store never reference an executor', () => {
      for (const file of ['recovery-port.ts', 'recovery-scanner.ts', 'operation-store.ts']) {
        const source = readFileSync(new URL(`../a2a/v1/${file}`, import.meta.url), 'utf8')
        expect(source.length).toBeGreaterThan(0)
        expect(source).not.toMatch(/AgentExecutor|\.execute\(|import[^;\n]*executor/i)
      }
    })
  })

  describe('R5 operation keys', () => {
    it('concurrent new messageIds on one task get distinct generations; a repeated messageId reuses its key', async () => {
      const recovery = boot()
      const [a, b, c] = await Promise.all([recovery.begin(alice, 'conc-1', 'm1'), recovery.begin(alice, 'conc-1', 'm2'), recovery.begin(alice, 'conc-1', 'm3')])
      expect([a.generation, b.generation, c.generation].sort()).toEqual([1, 2, 3])
      expect(new Set([a.operationKey, b.operationKey, c.operationKey]).size).toBe(3)
      const newest = [a, b, c].sort((left, right) => right.generation - left.generation)[0]!
      const newestMessage = newest === a ? 'm1' : newest === b ? 'm2' : 'm3'
      expect(await recovery.begin(alice, 'conc-1', newestMessage)).toEqual(newest) // a repeat of the latest generation reuses its key
      expect((await ops()).filter((row) => row.taskId === 'conc-1')).toHaveLength(3)
    })

    it('a repeated messageId of an older generation (a newer one exists) is refused and never re-stamps the old row', async () => {
      const recovery = boot()
      await recovery.begin(alice, 'old-gen', 'm1')
      await recovery.begin(alice, 'old-gen', 'm2')
      const before = await op('old-gen', 1)
      await expect(boot().begin(alice, 'old-gen', 'm1')).rejects.toThrow()
      expect(await op('old-gen', 1)).toEqual(before)
    })

    it('the key is stable across restart and isolated per owner', async () => {
      const a = await boot().begin(alice, 'iso-1', 'm1')
      const sameAfterRestart = await boot().begin(alice, 'iso-1', 'm1')
      expect(sameAfterRestart.operationKey).toBe(a.operationKey)
      const other = await boot().begin(bob, 'iso-1', 'm1')
      expect(other.operationKey).not.toBe(a.operationKey)
    })

    it('the executor sees its own frozen key, committed before execute; it cannot cross-read or change another call key', async () => {
      const seen: Array<{ key: unknown; rowAtExecute: boolean }> = []
      const recovery = boot()
      const executor: AgentExecutor = {
        async execute(context, bus) {
          const key = context.context.state.get('dzup.a2a.operationKey')
          const rows = (await primary.query('SELECT 1 FROM a2a_v1_operations WHERE operation_key = $1', [key])).rowCount
          seen.push({ key, rowAtExecute: rows === 1 })
          context.context.state.set('dzup.a2a.operationKey', 'a2a:v1:hacked-by-executor')
          bus.publish(AgentEvent.task(fixture(context.taskId, 'TASK_STATE_COMPLETED', context.contextId)))
        },
        async cancelTask() {},
      }
      const v1 = createA2AV1Handler({ agentCard: card, executor, taskStore: tasks(), recovery })
      const send = (messageId: string, taskId?: string) => v1.handler.handle({
        jsonrpc: '2.0', id: messageId, method: 'SendMessage',
        params: SendMessageRequest.toJSON(SendMessageRequest.fromJSON({ message: { messageId, ...(taskId ? { taskId } : {}), role: 'ROLE_USER', parts: [{ text: 'go', mediaType: 'text/plain' }] } })),
      }, alice)
      await send('first')
      await send('second')
      expect(seen).toHaveLength(2)
      expect(seen.map((entry) => entry.rowAtExecute)).toEqual([true, true])
      expect(new Set(seen.map((entry) => entry.key)).size).toBe(2)
      expect(seen.map((entry) => entry.key)).not.toContain('a2a:v1:hacked-by-executor')
      const rows = await ops()
      expect(rows).toHaveLength(2)
      expect(rows.map((row) => row.operationKey)).toEqual(expect.arrayContaining(seen.map((entry) => entry.key as string)))
    })

    it('a follow-up creates generation n+1 and the recovery state of n is superseded: not scanned, not projected, not guarded; late result for n is stale', async () => {
      const recovery = boot()
      const key1 = await seed(recovery, 'follow-1', 'TASK_STATE_WORKING', 'm1')
      await scan(boot(), port({ [key1]: { status: 'maybe', receiptRef: digest() } }))
      expect(await op('follow-1', 1)).toMatchObject({ recoveryState: 'recovery_required' })
      const second = await recovery.begin(alice, 'follow-1', 'm2')
      expect(second.generation).toBe(2)
      expect(await applyLateResult(recovery, key1, { state: 'completed', parts: [{ text: 'x' }] })).toBe('stale')
      const v1 = createA2AV1Handler({ agentCard: card, executor: noExecutor, taskStore: tasks(), recovery })
      const response = await v1.handler.handle({ jsonrpc: '2.0', id: 'g', method: 'GetTask', params: { id: 'follow-1' } }, alice) as { result?: { metadata?: Record<string, unknown> } }
      expect(response.result?.metadata?.dzupRecovery).toBeUndefined() // generation 1 is no longer projected
      // Another boot scans: only generation 2 is a candidate, generation 1 is never inspected.
      const p = port({})
      const results = await scan(boot(), p)
      expect(results.map((entry) => entry.operationKey)).toEqual([second.operationKey])
      expect(p.inspect.mock.calls.map((call) => call[0].operationKey)).toEqual([second.operationKey])
    })
  })

  describe('R7 sanitisation', () => {
    it('a database failure during recovery logs and surfaces only the generic text, and leaves the claim to expire', async () => {
      const key = await seed(boot(), 'san-1')
      await primary.query(`CREATE FUNCTION a2a_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-db-detail'; END; $$`)
      await primary.query('CREATE TRIGGER a2a_fixture_fail BEFORE UPDATE ON a2a_v1_tasks FOR EACH ROW EXECUTE FUNCTION a2a_fixture_fail()')
      try {
        const error = await scan(boot(), port({ [key]: notApplied })).then(() => undefined, (caught: unknown) => caught)
        expect(error === undefined || (error instanceof Error && error.message === 'Internal server error')).toBe(true)
        expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('fixture-db-detail')
      } finally {
        await primary.query('DROP TRIGGER a2a_fixture_fail ON a2a_v1_tasks')
        await primary.query('DROP FUNCTION a2a_fixture_fail()')
      }
      expect(JSON.stringify(await stored('san-1'))).not.toContain('fixture-db-detail')
    })
  })

  /** HTTP runtime with the official SDK client; `bootRecovery` is the process boot of this runtime. */
  async function startHttp(recovery: A2AV1Recovery, store: ReturnType<typeof tasks> = tasks(), extra: { cancelRejects?: boolean } = {}) {
    const executed: string[] = []
    const canceled: string[] = []
    const gates = new Map<string, () => void>()
    const executor: AgentExecutor = {
      async execute(context, bus) {
        executed.push(context.taskId)
        const content = context.userMessage.parts[0]?.content
        const text = content?.$case === 'text' ? content.value : ''
        const state = text === 'working' ? 'TASK_STATE_WORKING' : 'TASK_STATE_INPUT_REQUIRED'
        bus.publish(AgentEvent.task(fixture(context.taskId, state, context.contextId)))
        if (state === 'TASK_STATE_WORKING') await new Promise<void>((resolve) => gates.set(context.taskId, resolve))
      },
      async cancelTask(taskId, bus) {
        canceled.push(taskId)
        if (extra.cancelRejects) throw new Error('fixture-executor-cancel-rejects')
        bus.publish(AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON({ taskId, contextId: 'context-fixture', status: { state: 'TASK_STATE_CANCELED', timestamp: '2026-10-10T12:00:00Z' } })))
        gates.get(taskId)?.()
      },
    }
    let base = ''
    let app: ReturnType<typeof createForgeApp> | undefined
    const server = await new Promise<ServerType>((resolve) => {
      const started = serve({ fetch: (request) => app!.fetch(request), port: 0, hostname: '127.0.0.1' }, (info) => {
        base = `http://127.0.0.1:${info.port}`
        app = createForgeApp({
          runStore: new InMemoryRunStore(), agentStore: new InMemoryAgentStore(), modelRegistry: new ModelRegistry(), eventBus: createEventBus(),
          auth: { mode: 'api-key', validateKey: async (label) => ({
            alice: { id: 'alice-fixture', tenantId: 'tenant-fixture', role: 'admin' },
            other: { id: 'alice-fixture', tenantId: 'other-tenant', role: 'admin' },
          })[label as 'alice' | 'other'] ?? null },
          a2a: {
            agentCardConfig: { name: 'm3a-http', description: 'M3a', baseUrl: base, version: '1', authType: 'bearer', agents: [] },
            v1: { executor, taskStore: store, recovery },
          },
        })
        resolve(started)
      })
    })
    servers.push(server)
    const clientFor = async (label = 'alice') => {
      const fetchImpl: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init)
        request.headers.set('Authorization', `Bearer ${label}`)
        return nodeHttpFetch(request)
      }
      return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })], cardResolver: new DefaultAgentCardResolver({ fetchImpl }) }).createFromUrl(base)
    }
    const raw = async (method: string, params: unknown, label = 'alice') => {
      const response = await nodeHttpFetch(new Request(`${base}/a2a`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', Authorization: `Bearer ${label}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'raw', method, params }),
      }))
      return { status: response.status, text: await response.text() }
    }
    return { clientFor, raw, executed, canceled, release: (id: string) => gates.get(id)?.() }
  }
  const send = (text: string, extra: Record<string, unknown> = {}) => SendMessageRequest.fromJSON({
    message: { messageId: `sdk-${text}-${Math.random().toString(16).slice(2)}`, role: 'ROLE_USER', parts: [{ text, mediaType: 'text/plain' }] },
    configuration: { returnImmediately: true }, ...extra,
  })
  /** A WORKING task left by a process that died: sent through a runtime of boot A whose executor never finished. */
  async function orphanFromRestart(text = 'working') {
    const bootA = boot()
    const first = await startHttp(bootA)
    const task = await (await first.clientFor()).sendMessage(send(text))
    if (!('id' in task)) throw new Error('expected task')
    return { id: task.id, key: (await op(task.id)).operationKey as string }
  }
  const cancel = async (client: Awaited<ReturnType<Awaited<ReturnType<typeof startHttp>>['clientFor']>>, id: string) =>
    client.cancelTask({ id, tenant: '', metadata: undefined })

  describe('R4 the cancel guard (cancel propagation itself is deferred to M3b)', () => {
    it('an unscanned other-boot WORKING orphan is refused with -32002 and fixed text, before the SDK runs, even younger than minAgeMs', async () => {
      const { id } = await orphanFromRestart()
      const recovery = boot()
      const second = await startHttp(recovery)
      const error = await cancel(await second.clientFor(), id).then(() => undefined, (caught: unknown) => caught)
      expect(error).toMatchObject({ envelopeCode: -32002 })
      const raw = await second.raw('CancelTask', { id })
      expect(JSON.parse(raw.text).error).toMatchObject({ code: -32002 })
      // On the wire the M1 gate rewrites every -32002 to its fixed per-code text; the guard text itself is visible in-process.
      expect(raw.text).toContain('Task cannot be canceled')
      expect(raw.text).not.toContain('recovery')
      const direct = createA2AV1Handler({ agentCard: card, executor: noExecutor, taskStore: tasks(), recovery })
      const refused = await direct.handler.handle({ jsonrpc: '2.0', id: 'd', method: 'CancelTask', params: { id } }, alice) as { error?: { code: number; message: string } }
      expect(refused.error).toEqual({ code: -32002, message: CANCEL_REFUSED_TEXT, data: expect.anything() })
      expect(second.canceled).toEqual([])
      expect(await stateOf(id)).toBe('TASK_STATE_WORKING')
    })

    it('attached, recovery_required and recovering tasks are refused and never become CANCELED', async () => {
      for (const [index, setup] of ([
        ['attached', async (key: string, recovery: A2AV1Recovery) => { await recoverOrphanedA2AV1Tasks(recovery, port({ [key]: running })) }], // default minAgeMs: the row was backdated by SQL
        ['recovery_required', async (key: string, recovery: A2AV1Recovery) => { await recoverOrphanedA2AV1Tasks(recovery, port({ [key]: { status: 'maybe', receiptRef: digest() } })) }],
        ['recovering', async (key: string) => { await primary.query(`UPDATE a2a_v1_operations SET recovery_state='recovering', claim_kind='scan', claim_token='held', recovery_updated_at=now() WHERE operation_key=$1`, [key]) }],
      ] as const).entries()) {
        await primary.query('TRUNCATE a2a_v1_tasks, a2a_v1_operations')
        const { id, key } = await orphanFromRestart()
        await age() // backdated by direct SQL so the scanner can claim at the default minAgeMs
        const recovery = boot()
        await setup[1](key, recovery)
        const runtime = await startHttp(recovery)
        await expect(cancel(await runtime.clientFor(), id)).rejects.toMatchObject({ envelopeCode: -32002 })
        expect(runtime.canceled).toEqual([])
        expect(await stateOf(id)).toBe('TASK_STATE_WORKING')
        void index
      }
    })

    it('an unscanned orphan on an INPUT_REQUIRED task is not refused (the scanner never touches it): M2 behaviour', async () => {
      const { id } = await orphanFromRestart('input')
      const second = await startHttp(boot())
      const canceled = await cancel(await second.clientFor(), id)
      expect(canceled.status!.state).toBe(TaskState.TASK_STATE_CANCELED)
    })

    it('a same-boot live cancel keeps the M2 behaviour and calls the executor', async () => {
      const recovery = boot()
      const runtime = await startHttp(recovery)
      const client = await runtime.clientFor()
      const task = await client.sendMessage(send('working'))
      if (!('id' in task)) throw new Error('expected task')
      const canceled = await cancel(client, task.id)
      expect(canceled.status!.state).toBe(TaskState.TASK_STATE_CANCELED)
      expect(runtime.canceled).toEqual([task.id])
    })

    it('a not_applied operation row on the current boot (a real row, task still WORKING) keeps the M2 behaviour through the official client', async () => {
      const recovery = boot()
      await seed(recovery, 'na-current')
      await primary.query(`UPDATE a2a_v1_operations SET recovery_state='not_applied' WHERE task_id='na-current'`)
      expect(await op('na-current')).toMatchObject({ recoveryState: 'not_applied', state: 'started', bootId: recovery.bootId })
      expect(await stateOf('na-current')).toBe('TASK_STATE_WORKING')
      const runtime = await startHttp(recovery)
      const canceled = await cancel(await runtime.clientFor(), 'na-current')
      expect(canceled.status!.state).toBe(TaskState.TASK_STATE_CANCELED)
    })

    it('a task with no operation row and a missing task keep the M2 behaviour', async () => {
      const runtime = await startHttp(boot())
      const client = await runtime.clientFor()
      await tasks().save(fixture('no-op-row'), alice)
      expect((await cancel(client, 'no-op-row')).status!.state).toBe(TaskState.TASK_STATE_CANCELED)
      await expect(cancel(client, 'missing-task')).rejects.toMatchObject({ envelopeCode: -32001 }) // guard runs only after the task exists
    })

    it('the guard reads only the latest generation', async () => {
      const recovery = boot()
      const key1 = await seed(recovery, 'latest-1', 'TASK_STATE_WORKING', 'm1')
      await scan(boot(), port({ [key1]: { status: 'maybe', receiptRef: digest() } }))
      await recovery.begin(alice, 'latest-1', 'm2') // generation 2 on the current boot with no recovery state
      const runtime = await startHttp(recovery)
      const canceled = await cancel(await runtime.clientFor(), 'latest-1')
      expect(canceled.status!.state).toBe(TaskState.TASK_STATE_CANCELED)
    })

    it('the guard refuses deterministically both before the claim (unscanned orphan) and after it (claim held mid-inspect)', async () => {
      const { id, key } = await orphanFromRestart()
      await age()
      const recovery = boot()
      const runtime = await startHttp(recovery)
      const client = await runtime.clientFor()
      // Before the claim: the operation is an unscanned other-boot orphan, clause (b).
      expect((await op(id)).recoveryState).toBeNull()
      await expect(cancel(client, id)).rejects.toMatchObject({ envelopeCode: -32002 })
      // After the claim: the scanner holds the claim (recovering) while inspect is pending, clause (a).
      let release!: () => void
      const hold = new Promise<void>((resolve) => { release = resolve })
      const slow = port(async () => { await hold; return { status: 'running', receiptRef: digest('4') } })
      const scanning = recoverOrphanedA2AV1Tasks(recovery, slow)
      await vi.waitFor(() => expect(slow.inspect).toHaveBeenCalled())
      expect(await op(id)).toMatchObject({ recoveryState: 'recovering', claimKind: 'scan' })
      await expect(cancel(client, id)).rejects.toMatchObject({ envelopeCode: -32002 })
      release()
      expect(await scanning).toEqual([{ operationKey: key, outcome: 'attached' }])
      await expect(cancel(client, id)).rejects.toMatchObject({ envelopeCode: -32002 })
      expect(await stateOf(id)).toBe('TASK_STATE_WORKING')
      expect(runtime.canceled).toEqual([])
    })
  })

  describe('R2 the scanner never calls the executor after a real restart', () => {
    it('a restarted runtime and a scan leave the executor uncalled', async () => {
      const { id, key } = await orphanFromRestart()
      const recovery = boot()
      const runtime = await startHttp(recovery)
      await scan(recovery, port({ [key]: notApplied }))
      expect(runtime.executed).toEqual([])
      expect(await stateOf(id)).toBe('TASK_STATE_FAILED')
    })
  })

  describe('R5 a retried messageId on a recovery-marked task is refused before the SDK runs', () => {
    it('does not turn an attached task into FAILED and does not call the executor (HTTP, official client)', async () => {
      const { id, key } = await orphanFromRestart()
      const recovery = boot()
      await scan(recovery, port({ [key]: running }))
      const messageId = (await op(id)).messageId as string
      const runtime = await startHttp(recovery)
      const retry = SendMessageRequest.fromJSON({
        message: { messageId, taskId: id, contextId: 'context-fixture', role: 'ROLE_USER', parts: [{ text: 'working', mediaType: 'text/plain' }] },
        configuration: { returnImmediately: true },
      })
      await expect((await runtime.clientFor()).sendMessage(retry)).rejects.toBeDefined()
      expect(runtime.executed).toEqual([])
      expect(await stateOf(id)).toBe('TASK_STATE_WORKING')
      expect(await op(id)).toMatchObject({ recoveryState: 'attached', state: 'started' })
    })
  })

  describe('R9 GetTask projection through the official SDK client', () => {
    it('recovery_required shows the fixed message and marker, never persisted; attached shows no marker; other tenants get -32001', async () => {
      const { id, key } = await orphanFromRestart()
      const recovery = boot()
      await scan(recovery, port({ [key]: { status: 'maybe', receiptRef: digest() } }))
      const runtime = await startHttp(recovery)
      const client = await runtime.clientFor()
      const got = await client.getTask({ id, tenant: '' })
      expect(got.status!.state).toBe(TaskState.TASK_STATE_WORKING)
      expect(textOf(got)).toBe(RECOVERY_REQUIRED_TEXT)
      expect(got.metadata).toMatchObject({ dzupRecovery: 'required' })
      const dbTask = (await primary.query(`SELECT task FROM a2a_v1_tasks WHERE id = $1`, [id])).rows[0].task
      expect(JSON.stringify(dbTask)).not.toContain('dzupRecovery')
      expect(JSON.stringify(dbTask)).not.toContain(RECOVERY_REQUIRED_TEXT)
      await expect(client.cancelTask({ id, tenant: '', metadata: undefined })).rejects.toMatchObject({ envelopeCode: -32002 })
      expect(JSON.stringify((await primary.query(`SELECT task FROM a2a_v1_tasks WHERE id = $1`, [id])).rows[0].task)).not.toContain('dzupRecovery')
      await expect((await runtime.clientFor('other')).getTask({ id, tenant: '' })).rejects.toMatchObject({ envelopeCode: -32001 })
    })

    it('an attached task and a scan-recovering task show no marker', async () => {
      const { id, key } = await orphanFromRestart()
      const recovery = boot()
      await scan(recovery, port({ [key]: running }))
      const client = await (await startHttp(recovery)).clientFor()
      const got = await client.getTask({ id, tenant: '' })
      expect(got.metadata?.dzupRecovery).toBeUndefined()
      expect(textOf(got)).toBe('status fixture')
    })

    it('the recovery store is unreachable over HTTP and JSON-RPC', async () => {
      const runtime = await startHttp(boot())
      for (const method of ['recoverOrphans', 'recoverOrphanedA2AV1Tasks', 'applyLateResult', 'begin', 'beginOperation', 'latest']) {
        const response = await runtime.raw(method, { id: 'x' })
        expect(JSON.parse(response.text).error).toMatchObject({ code: -32601 })
      }
    })
  })

  // =========================================================================================================================
  // A2A-M3B-20261111-R1 (admission 0d4601bd): M3b. (a) inspect diagnostics, (b) cancel propagation, (c) is the Scripts adapter.
  // =========================================================================================================================
  describe('M3b C0 spike: what the SDK does with a dropped CANCELED save (needs no implementation; green on base by design)', () => {
    /** A store that silently drops CANCELED saves, as the hold-back will. */
    const dropping = (inner: ReturnType<typeof tasks>) => ({
      load: (id: string, context: ServerCallContext) => inner.load(id, context),
      list: (params: Parameters<typeof inner.list>[0], context: ServerCallContext) => inner.list(params, context),
      save: async (task: Task, context: ServerCallContext) => { if (task.status?.state === TaskState.TASK_STATE_CANCELED) return; await inner.save(task, context) },
    })
    const gatesC0 = new Map<string, () => void>()
    const spikeExecutor: AgentExecutor = {
      async execute(context, bus) {
        bus.publish(AgentEvent.task(fixture(context.taskId, 'TASK_STATE_WORKING', context.contextId)))
        await new Promise<void>((resolve) => gatesC0.set(context.taskId, resolve))
      },
      async cancelTask(taskId, bus) {
        bus.publish(AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON({ taskId, contextId: 'context-fixture', status: { state: 'TASK_STATE_CANCELED', timestamp: '2026-10-10T12:00:00Z' } })))
        gatesC0.get(taskId)?.()
      },
    }
    const reasonOf = (error: unknown) => {
      const e = error as { name?: string; toErrorInfo?: () => { reason?: string } }
      return { name: e?.name, reason: typeof e?.toErrorInfo === 'function' ? e.toErrorInfo().reason : undefined }
    }

    it('C0 an orphaned and a live task both raise TaskNotCancelableError after the dropped save; it is recognised by name and reason and instanceof against @a2a-js/sdk/errors fails', async () => {
      const handler = new DefaultRequestHandler(card, dropping(tasks()), spikeExecutor, new DefaultExecutionEventBusManager(dzupOwnerResolver))
      await tasks().save(fixture('c0-orphan', 'TASK_STATE_WORKING'), alice)
      const orphan = await handler.cancelTask({ id: 'c0-orphan', tenant: '' }, alice).then(() => undefined, (error: unknown) => error)
      expect(orphan).toBeDefined()
      expect(reasonOf(orphan)).toEqual({ name: 'TaskNotCancelableError', reason: 'TASK_NOT_CANCELABLE' })
      expect(orphan instanceof JsonRpcTaskNotCancelableError).toBe(false)
      expect(await stateOf('c0-orphan')).toBe('TASK_STATE_WORKING')

      const sent = await handler.sendMessage(SendMessageRequest.fromJSON({
        message: { messageId: 'c0-live', role: 'ROLE_USER', parts: [{ text: 'go', mediaType: 'text/plain' }] }, configuration: { returnImmediately: true },
      }), alice)
      const liveId = (sent as Task).id
      const live = await handler.cancelTask({ id: liveId, tenant: '' }, alice).then(() => undefined, (error: unknown) => error)
      expect(reasonOf(live)).toEqual({ name: 'TaskNotCancelableError', reason: 'TASK_NOT_CANCELABLE' })
      expect(await stateOf(liveId)).toBe('TASK_STATE_WORKING')
    })

    it('C0b records what the SDK does with a live executor\'s later COMPLETED after a dropped CANCELED (documentation, not a gate)', async () => {
      const handler = new DefaultRequestHandler(card, dropping(tasks()), spikeExecutor, new DefaultExecutionEventBusManager(dzupOwnerResolver))
      const sent = await handler.sendMessage(SendMessageRequest.fromJSON({
        message: { messageId: 'c0b-live', role: 'ROLE_USER', parts: [{ text: 'go', mediaType: 'text/plain' }] }, configuration: { returnImmediately: true },
      }), alice)
      const id = (sent as Task).id
      await handler.cancelTask({ id, tenant: '' }, alice).catch(() => undefined)
      const after = await stateOf(id)
      // Observation only: the held-back CANCELED never reached the store and the task keeps its non-terminal state.
      expect(after).toBe('TASK_STATE_WORKING')
    })
  })

  describe('M3b A1 inspect and stop diagnostics are fixed and payload-free', () => {
    it('A1 a thrown inspect, a timed-out inspect and a failed requestStop each emit exactly one fixed record with no id, scope, payload or error text', async () => {
      const logs: Array<{ level: string; operation: string }> = []
      const spy = (entry: { level: string; operation: string }) => { logs.push(entry) }
      const keyThrow = await seed(boot(), 'diag-throw')
      const keySlow = await seed(boot(), 'diag-slow')
      const throwing: A2AExecutionPort = { inspect: async (request) => { if (request.operationKey === keyThrow) throw new Error('diag-probe-secret-detail'); return new Promise(() => {}) } }
      const recovery = boot({ logger: spy, inspectTimeoutMs: 40 })
      await recoverOrphanedA2AV1Tasks(recovery, throwing, { minAgeMs: 0 })
      expect(logs.filter((entry) => entry.operation === 'a2a.v1.recovery.inspect')).toEqual([{ level: 'error', operation: 'a2a.v1.recovery.inspect' }])
      expect(logs.filter((entry) => entry.operation === 'a2a.v1.recovery.inspect-timeout')).toEqual([{ level: 'error', operation: 'a2a.v1.recovery.inspect-timeout' }])
      expect(JSON.stringify(logs)).not.toContain('diag-probe-secret-detail')
      expect(JSON.stringify(logs)).not.toContain(keyThrow)
      expect(JSON.stringify(logs)).not.toContain('diag-throw')
      expect(await op('diag-throw')).toMatchObject({ recoveryState: 'recovery_required' }) // the outcome stays unknown
      expect(await op('diag-slow')).toMatchObject({ recoveryState: 'recovery_required' })
      void keySlow
    })
  })

  describe('M3b cancel propagation (handler-owned, port configured)', () => {
    const canceledState = TaskState.TASK_STATE_CANCELED
    const stopped = { status: 'stopped', receiptRef: digest('5') }
    const runningAnswer = { status: 'running', receiptRef: digest('6') }
    const cancelPort = (answer: unknown | ((request: { operationKey: string; kind?: string }) => unknown), extra: Partial<A2AExecutionPort> = {}): A2AExecutionPort & { inspect: ReturnType<typeof vi.fn> } => ({
      ...port((request) => (typeof answer === 'function' ? (answer as (r: unknown) => unknown)(request) : answer)), ...extra,
    })
    const holdStore = () => tasks({ cancelHoldBack: true })

    /** An orphaned WORKING task left by a dead boot, and a runtime of a new boot that has the port. */
    async function orphan(answer: unknown, opts: { extra?: Partial<A2AExecutionPort>; recovery?: Partial<A2AV1RecoveryOptions>; text?: string } = {}) {
      const { id, key } = await orphanFromRestart(opts.text ?? 'working')
      const p = cancelPort(answer, opts.extra)
      const recovery = boot({ port: p, ...(opts.recovery ?? {}) })
      const runtime = await startHttp(recovery, holdStore())
      return { id, key, p, recovery, runtime, client: await runtime.clientFor() }
    }
    /** A live in-process task and a runtime that has the port. */
    async function live(answer: unknown, extra: Partial<A2AExecutionPort> = {}) {
      const p = cancelPort(answer, extra)
      const recovery = boot({ port: p })
      const runtime = await startHttp(recovery, holdStore())
      const client = await runtime.clientFor()
      const sent = await client.sendMessage(send('working'))
      if (!('id' in sent)) throw new Error('expected task')
      return { id: sent.id, p, recovery, runtime, client }
    }

    it.each([
      ['stopped', stopped, 'TASK_STATE_CANCELED', true],
      ['not_applied (the work never started: a valid stop)', { status: 'not_applied', receiptRef: digest('7') }, 'TASK_STATE_CANCELED', true],
    ])('C3 orphan and live: a cancel inspect answered %s writes CANCELED, resolves the operation and stores the receipt', async (_label, answer, taskState, ok) => {
      expect(ok).toBe(true)
      for (const make of [orphan, live]) {
        await primary.query('TRUNCATE a2a_v1_tasks, a2a_v1_operations')
        const { id, client, p } = await make(answer)
        const result = await client.cancelTask({ id, tenant: '', metadata: undefined })
        expect(result.status!.state).toBe(canceledState)
        expect(await stateOf(id)).toBe(taskState)
        expect(textOf(await stored(id))).toBe('Task was canceled')
        const row = await op(id)
        expect(row).toMatchObject({ state: 'resolved', recoveryState: null })
        expect(JSON.parse(row.receipt!)).toEqual({ digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), state: (answer as { status: string }).status, byteLength: 0 })
        expect(p.inspect.mock.calls.map((call) => call[0].kind)).toEqual(['cancel'])
      }
    })

    it('C3 a terminal answer writes that state and the cancel returns -32002 (the work finished first); the receipt is stored', async () => {
      const { id, client } = await orphan({ status: 'terminal', receiptRef: digest('8'), terminal: { state: 'completed' } })
      await expect(client.cancelTask({ id, tenant: '', metadata: undefined })).rejects.toMatchObject({ envelopeCode: -32002 })
      expect(await stateOf(id)).toBe('TASK_STATE_COMPLETED')
      expect(await op(id)).toMatchObject({ state: 'resolved', recoveryState: null })
      expect((await op(id)).receipt).not.toBeNull()
    })

    it.each([
      ['running', runningAnswer],
      ['an unknown status literal', { status: 'maybe', receiptRef: digest('9') }],
      ['a bad digest', { status: 'stopped', receiptRef: 'sha256:nope' }],
      ['an unknown answer', { status: 'unknown' }],
    ])('C3 an unconfirmed cancel (%s) is recovery_required, the task is not canceled, the hold-back stays and the stored task is returned (D13)', async (_label, answer) => {
      for (const make of [orphan, live]) {
        await primary.query('TRUNCATE a2a_v1_tasks, a2a_v1_operations')
        const { id, client, runtime } = await make(answer)
        const result = await client.cancelTask({ id, tenant: '', metadata: undefined })
        expect(result.status!.state).toBe(TaskState.TASK_STATE_WORKING)
        expect(result.metadata).toMatchObject({ dzupRecovery: 'required' })
        expect(textOf(result)).toBe(RECOVERY_REQUIRED_TEXT)
        expect(await op(id)).toMatchObject({ state: 'cancel_pending', recoveryState: 'recovery_required' })
        expect(await stateOf(id)).toBe('TASK_STATE_WORKING')
        void runtime
      }
    })

    it('C3/A1 a thrown inspect and a timed-out inspect leave recovery_required with one fixed diagnostic each and no probe text anywhere', async () => {
      const logs: Array<{ level: string; operation: string }> = []
      const thrown = await orphan(new Error('cancel-probe-secret') as unknown, { recovery: { logger: (entry: { level: string; operation: string }) => { logs.push(entry) } } })
      thrown.p.inspect.mockImplementation(async () => { throw new Error('cancel-probe-secret') })
      const result = await thrown.client.cancelTask({ id: thrown.id, tenant: '', metadata: undefined })
      expect(result.status!.state).toBe(TaskState.TASK_STATE_WORKING)
      expect(logs).toEqual([{ level: 'error', operation: 'a2a.v1.recovery.inspect' }])
      expect(JSON.stringify(result)).not.toContain('cancel-probe-secret')
      expect(JSON.stringify(await stored(thrown.id))).not.toContain('cancel-probe-secret')
      await primary.query('TRUNCATE a2a_v1_tasks, a2a_v1_operations')
      logs.length = 0
      const slow = await orphan({ status: 'unknown' }, { recovery: { inspectTimeoutMs: 40, logger: (entry: { level: string; operation: string }) => { logs.push(entry) } } })
      slow.p.inspect.mockImplementation(() => new Promise(() => {}))
      const second = await slow.client.cancelTask({ id: slow.id, tenant: '', metadata: undefined })
      expect(second.status!.state).toBe(TaskState.TASK_STATE_WORKING)
      expect(logs).toEqual([{ level: 'error', operation: 'a2a.v1.recovery.inspect-timeout' }])
      expect(await op(slow.id)).toMatchObject({ state: 'cancel_pending', recoveryState: 'recovery_required' })
    })

    it('C3 a generic error from a rejecting executor.cancelTask does not abort the flow: the claim is held and the inspect still runs', async () => {
      const p = cancelPort(stopped)
      const recovery = boot({ port: p })
      const rejecting = await startHttp(recovery, holdStore(), { cancelRejects: true })
      const client = await rejecting.clientFor()
      const sent = await client.sendMessage(send('working'))
      if (!('id' in sent)) throw new Error('expected task')
      const result = await client.cancelTask({ id: sent.id, tenant: '', metadata: undefined })
      expect(result.status!.state).toBe(canceledState)
      expect(p.inspect).toHaveBeenCalledTimes(1)
    })

    it('C4 requestStop is called exactly once per cancel claim for an orphan and for a live task; executor.cancelTask is called by the SDK for the live task only; a failing or timed-out requestStop leaves the outcome to inspect with one fixed diagnostic', async () => {
      const stopCalls: unknown[] = []
      const requestStop = vi.fn(async (request: unknown) => { stopCalls.push(request) })
      const o = await orphan(stopped, { extra: { requestStop } })
      await o.client.cancelTask({ id: o.id, tenant: '', metadata: undefined })
      expect(requestStop).toHaveBeenCalledTimes(1)
      expect(stopCalls[0]).toEqual({ operationKey: o.key, tenantId: 'tenant-fixture', taskId: o.id })
      expect(o.runtime.canceled).toEqual([]) // an orphan has no bus: the SDK never calls executor.cancelTask
      await primary.query('TRUNCATE a2a_v1_tasks, a2a_v1_operations')
      requestStop.mockClear()
      const l = await live(stopped, { requestStop })
      await l.client.cancelTask({ id: l.id, tenant: '', metadata: undefined })
      expect(requestStop).toHaveBeenCalledTimes(1)
      expect(l.runtime.canceled).toEqual([l.id]) // the SDK calls the executor for a live task
      // Failure and timeout: fixed diagnostics, the outcome comes from inspect.
      await primary.query('TRUNCATE a2a_v1_tasks, a2a_v1_operations')
      const logs: Array<{ level: string; operation: string }> = []
      const failing = await orphan(stopped, { extra: { requestStop: async () => { throw new Error('stop-probe-secret') } }, recovery: { logger: (entry: { level: string; operation: string }) => { logs.push(entry) } } })
      expect((await failing.client.cancelTask({ id: failing.id, tenant: '', metadata: undefined })).status!.state).toBe(canceledState)
      expect(logs).toEqual([{ level: 'error', operation: 'a2a.v1.recovery.stop' }])
      expect(JSON.stringify(logs)).not.toContain('stop-probe-secret')
      await primary.query('TRUNCATE a2a_v1_tasks, a2a_v1_operations')
      logs.length = 0
      const hanging = await orphan(stopped, { extra: { requestStop: () => new Promise(() => {}) }, recovery: { inspectTimeoutMs: 40, logger: (entry: { level: string; operation: string }) => { logs.push(entry) } } })
      expect((await hanging.client.cancelTask({ id: hanging.id, tenant: '', metadata: undefined })).status!.state).toBe(canceledState)
      expect(logs).toEqual([{ level: 'error', operation: 'a2a.v1.recovery.stop-timeout' }])
    })

    it('C4 the scanner never calls requestStop', async () => {
      const requestStop = vi.fn(async () => {})
      const { key } = await orphanFromRestart()
      await age()
      const recovery = boot({ port: cancelPort(stopped, { requestStop }) })
      await primary.query(`UPDATE a2a_v1_operations SET state='cancel_pending', recovery_state='recovering', claim_kind='cancel', claim_token='dead', recovery_updated_at = now() - interval '1 hour' WHERE operation_key=$1`, [key])
      expect(await recoverOrphanedA2AV1Tasks(recovery, undefined, { minAgeMs: 0 })).toEqual([{ operationKey: key, outcome: 'canceled' }])
      expect(requestStop).not.toHaveBeenCalled()
    })

    it('C5 re-cancel: from recovery_required a second CancelTask re-runs the claim and the inspect and succeeds on a later stopped; an attached task is cancellable', async () => {
      let answer: unknown = { status: 'unknown' }
      const o = await orphan(() => answer)
      expect((await o.client.cancelTask({ id: o.id, tenant: '', metadata: undefined })).status!.state).toBe(TaskState.TASK_STATE_WORKING)
      expect(await op(o.id)).toMatchObject({ state: 'cancel_pending', recoveryState: 'recovery_required' })
      answer = stopped
      expect((await o.client.cancelTask({ id: o.id, tenant: '', metadata: undefined })).status!.state).toBe(canceledState)
      expect(o.p.inspect).toHaveBeenCalledTimes(2)
      await primary.query('TRUNCATE a2a_v1_tasks, a2a_v1_operations')
      // attached: a scanner attached it, then it is cancelled
      const a = await orphan(stopped)
      await age()
      await recoverOrphanedA2AV1Tasks(boot(), port({ [a.key]: running }), { minAgeMs: 0 })
      expect(await op(a.id)).toMatchObject({ recoveryState: 'attached' })
      expect((await a.client.cancelTask({ id: a.id, tenant: '', metadata: undefined })).status!.state).toBe(canceledState)
    })

    it('C1 the cancel claim: succeeds from started, attached, recovery_required, an expired recovering, on the same boot and on another boot younger than minAgeMs; an unexpired claim is refused; resolved is not claimable; it stamps the current boot', async () => {
      const claimant = boot({ port: cancelPort(stopped) })
      for (const [label, prepare] of [
        ['started', async () => {}],
        ['attached', async (id: string) => { await primary.query(`UPDATE a2a_v1_operations SET recovery_state='attached' WHERE task_id=$1`, [id]) }],
        ['recovery_required', async (id: string) => { await primary.query(`UPDATE a2a_v1_operations SET recovery_state='recovery_required' WHERE task_id=$1`, [id]) }],
        ['expired recovering', async (id: string) => { await primary.query(`UPDATE a2a_v1_operations SET recovery_state='recovering', claim_kind='scan', claim_token='old', recovery_updated_at = now() - interval '1 hour' WHERE task_id=$1`, [id]) }],
      ] as const) {
        const id = `c1-${label.replace(/\s/g, '-')}`
        await seed(boot(), id) // another boot, just begun (younger than minAgeMs)
        await prepare(id)
        const claimed = await claimant.claimCancel(alice, id, `token-${id}`)
        expect(claimed, label).toBeDefined()
        expect(await op(id)).toMatchObject({ state: 'cancel_pending', recoveryState: 'recovering', claimKind: 'cancel', claimToken: `token-${id}`, bootId: claimant.bootId })
      }
      // The same boot (a live cancel) claims too.
      const same = boot({ port: cancelPort(stopped) })
      await same.begin(alice, 'c1-same-boot', 'm1')
      await tasks().save(fixture('c1-same-boot'), alice)
      expect(await same.claimCancel(alice, 'c1-same-boot', 'tok-same')).toBeDefined()
      // An unexpired claim by anyone is refused; the holder keeps its token.
      expect(await claimant.claimCancel(alice, 'c1-same-boot', 'tok-other')).toBeUndefined()
      expect(await op('c1-same-boot')).toMatchObject({ claimToken: 'tok-same' })
      // A resolved operation is not claimable.
      await seed(boot(), 'c1-resolved')
      await primary.query(`UPDATE a2a_v1_operations SET state='resolved' WHERE task_id='c1-resolved'`)
      expect(await claimant.claimCancel(alice, 'c1-resolved', 'tok-r')).toBeUndefined()
      // Only the latest generation is claimable.
      const gens = boot({ port: cancelPort(stopped) })
      await gens.begin(alice, 'c1-gen', 'm1')
      await gens.begin(alice, 'c1-gen', 'm2')
      expect(await gens.claimCancel(alice, 'c1-gen', 'tok-g')).toBeDefined()
      expect(await op('c1-gen', 1)).toMatchObject({ state: 'started', recoveryState: null })
      expect(await op('c1-gen', 2)).toMatchObject({ state: 'cancel_pending' })
    })

    it('C2 the hold-back: CANCELED saves are refused only while the latest operation is cancel_pending and the store has the option; a superseded generation, COMPLETED and a store without the option are untouched', async () => {
      const recovery = boot({ port: cancelPort(stopped) })
      const guarded = tasks({ cancelHoldBack: true })
      const plain = tasks()
      expect(guarded.cancelHoldBack).toBe(true)
      expect(plain.cancelHoldBack).toBe(false)
      await seed(recovery, 'c2-a')
      await recovery.claimCancel(alice, 'c2-a', 'tok-a')
      await guarded.save(fixture('c2-a', 'TASK_STATE_CANCELED'), alice)
      expect(await stateOf('c2-a')).toBe('TASK_STATE_WORKING') // held back (a silent drop)
      await plain.save(fixture('c2-a', 'TASK_STATE_CANCELED'), alice)
      expect(await stateOf('c2-a')).toBe('TASK_STATE_CANCELED') // a store without the option is the M2 statement
      // COMPLETED is never held back.
      await seed(recovery, 'c2-b')
      await recovery.claimCancel(alice, 'c2-b', 'tok-b')
      await guarded.save(fixture('c2-b', 'TASK_STATE_COMPLETED'), alice)
      expect(await stateOf('c2-b')).toBe('TASK_STATE_COMPLETED')
      // A superseded generation does not hold back: generation 2 is the latest and is not cancel_pending.
      await seed(recovery, 'c2-c', 'TASK_STATE_WORKING', 'm1')
      await recovery.claimCancel(alice, 'c2-c', 'tok-c')
      await recovery.begin(alice, 'c2-c', 'm2')
      await guarded.save(fixture('c2-c', 'TASK_STATE_CANCELED'), alice)
      expect(await stateOf('c2-c')).toBe('TASK_STATE_CANCELED')
      // A non-cancel operation state never holds back.
      await seed(recovery, 'c2-d')
      await guarded.save(fixture('c2-d', 'TASK_STATE_CANCELED'), alice)
      expect(await stateOf('c2-d')).toBe('TASK_STATE_CANCELED')
    })

    it('C2 createA2AV1Handler throws at construction when the recovery has a port and the store has no cancel hold-back (or is a custom store without the marker)', () => {
      const withPort = boot({ port: cancelPort(stopped) })
      const config = { agentCard: card, executor: noExecutor, recovery: withPort }
      expect(() => createA2AV1Handler({ ...config, taskStore: tasks() })).toThrow(/hold-back/u)
      expect(() => createA2AV1Handler({ ...config })).toThrow(/hold-back/u)
      expect(() => createA2AV1Handler({ ...config, taskStore: { load: async () => undefined, save: async () => {}, list: async () => ({ tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 }) } })).toThrow(/hold-back/u)
      expect(() => createA2AV1Handler({ ...config, taskStore: tasks({ cancelHoldBack: true }) })).not.toThrow()
      // Without a port nothing is required.
      expect(() => createA2AV1Handler({ agentCard: card, executor: noExecutor, taskStore: tasks(), recovery: boot() })).not.toThrow()
    })

    it('C6 restart: an expired cancel claim of a dead boot is resolved by the scanner with the cancel kind; an unexpired claim is never claimed whatever its boot; a double crash (a scan reclaim of the cancel row) is reclaimed again', async () => {
      const { key } = await orphanFromRestart()
      await primary.query(`UPDATE a2a_v1_operations SET state='cancel_pending', recovery_state='recovering', claim_kind='cancel', claim_token='dead', boot_id='dead-boot', recovery_updated_at = now() WHERE operation_key=$1`, [key])
      const p = cancelPort(stopped)
      const scanner = boot({ port: p })
      expect(await recoverOrphanedA2AV1Tasks(scanner, undefined, { minAgeMs: 0 })).toEqual([]) // unexpired: never claimed
      expect(p.inspect).not.toHaveBeenCalled()
      await primary.query(`UPDATE a2a_v1_operations SET recovery_updated_at = now() - interval '1 hour' WHERE operation_key=$1`, [key])
      expect(await recoverOrphanedA2AV1Tasks(scanner, undefined, { minAgeMs: 0 })).toEqual([{ operationKey: key, outcome: 'canceled' }])
      expect(p.inspect.mock.calls.map((call) => call[0].kind)).toEqual(['cancel'])
      expect(await op((await ops()).find((row) => row.operationKey === key)!.taskId)).toMatchObject({ state: 'resolved', recoveryState: null })
      // Double crash: the scanner reclaimed the cancel row as kind scan, crashed, and the claim expired again.
      await primary.query('TRUNCATE a2a_v1_tasks, a2a_v1_operations')
      const again = await orphanFromRestart()
      await primary.query(`UPDATE a2a_v1_operations SET state='cancel_pending', recovery_state='recovering', claim_kind='scan', claim_token='dead2', boot_id='dead-boot-2', recovery_updated_at = now() - interval '1 hour' WHERE operation_key=$1`, [again.key])
      expect(await recoverOrphanedA2AV1Tasks(boot({ port: cancelPort(stopped) }), undefined, { minAgeMs: 0 })).toEqual([{ operationKey: again.key, outcome: 'canceled' }])
    })

    it('C6 a scanner cancel claim answered running is recovery_required (not attached) and stores no receipt, the hold-back stays; the dispatch kind keeps attaching', async () => {
      const { key, id } = await orphanFromRestart()
      await primary.query(`UPDATE a2a_v1_operations SET state='cancel_pending', recovery_state='recovering', claim_kind='cancel', claim_token='dead', boot_id='dead-boot', recovery_updated_at = now() - interval '1 hour' WHERE operation_key=$1`, [key])
      expect(await recoverOrphanedA2AV1Tasks(boot({ port: cancelPort(runningAnswer) }), undefined, { minAgeMs: 0 })).toEqual([{ operationKey: key, outcome: 'recovery_required' }])
      expect(await op(id)).toMatchObject({ state: 'cancel_pending', recoveryState: 'recovery_required', receipt: null })
      await primary.query('TRUNCATE a2a_v1_tasks, a2a_v1_operations')
      const dispatch = await orphanFromRestart()
      await age()
      expect(await recoverOrphanedA2AV1Tasks(boot({ port: cancelPort(runningAnswer) }), undefined)).toEqual([{ operationKey: dispatch.key, outcome: 'attached' }])
    })

    it('C7 interleavings: a cancel claim racing a scan claim, a late claim, a follow-up begin and another cancel serialise on the per-task lock', async () => {
      await seed(boot(), 'c7-race')
      await age()
      const key = (await op('c7-race')).operationKey as string
      const holder = await newClient()
      await holder.query('BEGIN')
      const lock = `a2a:v1:recovery:${JSON.stringify(['tenant-fixture', JSON.stringify(['tenant-fixture', 'alice-fixture']), 'c7-race'])}`
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 4121955))', [lock])
      try {
        const writer = boot({ port: cancelPort(stopped) })
        const settled: string[] = []
        const tracked = <T,>(name: string, promise: Promise<T>) => promise.then((value) => { settled.push(name); return value })
        const claim = tracked('cancel', writer.claimCancel(alice, 'c7-race', 'tok-1'))
        const second = tracked('cancel2', boot({ port: cancelPort(stopped) }).claimCancel(alice, 'c7-race', 'tok-2'))
        const scan = tracked('scan', recoverOrphanedA2AV1Tasks(boot({ port: cancelPort(stopped) }), undefined, { minAgeMs: 0 }))
        const next = tracked('begin', boot().begin(alice, 'c7-race', 'm2'))
        await vi.waitFor(async () => expect(Number((await primary.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`)).rows[0].n)).toBeGreaterThanOrEqual(3), { timeout: 15_000, interval: 50 })
        expect(settled).toEqual([])
        await holder.query('COMMIT')
        await Promise.all([claim, second, scan, next])
        expect(settled.length).toBe(4)
      } finally { await holder.query('ROLLBACK').catch(() => {}) }
      void key
    })

    it('C7 a live COMPLETED racing a cancel: the first terminal write wins and the cancel returns -32002; a stale-token cancel commit is refused and returns the stored task', async () => {
      let release!: () => void
      const hold = new Promise<void>((resolve) => { release = resolve })
      const o = await orphan(async () => { await hold; return stopped })
      const pending = o.client.cancelTask({ id: o.id, tenant: '', metadata: undefined }).then((value) => ({ value }), (error: unknown) => ({ error }))
      await vi.waitFor(() => expect(o.p.inspect).toHaveBeenCalled(), { timeout: 15_000, interval: 25 })
      await tasks().save(fixture(o.id, 'TASK_STATE_COMPLETED'), alice) // the live work finished first
      release()
      expect(await pending).toMatchObject({ error: { envelopeCode: -32002 } })
      expect(await stateOf(o.id)).toBe('TASK_STATE_COMPLETED')
      // Stale token: a scanner reclaims the expired cancel claim while the handler is still inspecting.
      await primary.query('TRUNCATE a2a_v1_tasks, a2a_v1_operations')
      let release2!: () => void
      const hold2 = new Promise<void>((resolve) => { release2 = resolve })
      const s = await orphan(async () => { await hold2; return stopped })
      const second = s.client.cancelTask({ id: s.id, tenant: '', metadata: undefined })
      await vi.waitFor(() => expect(s.p.inspect).toHaveBeenCalled(), { timeout: 15_000, interval: 25 })
      await primary.query(`UPDATE a2a_v1_operations SET recovery_updated_at = now() - interval '1 hour' WHERE task_id=$1`, [s.id])
      const scanner = boot({ port: cancelPort({ status: 'running', receiptRef: digest('a') }) })
      await recoverOrphanedA2AV1Tasks(scanner, undefined, { minAgeMs: 0 })
      expect(await op(s.id)).toMatchObject({ recoveryState: 'recovery_required', claimToken: expect.not.stringMatching(/^$/u) })
      release2()
      const returned = await second
      expect(returned.status!.state).toBe(TaskState.TASK_STATE_WORKING) // the stale handler wrote nothing and returned the stored task
      expect(await stateOf(s.id)).toBe('TASK_STATE_WORKING')
    })

    it('C7 applyLateResult on a cancel-resolved row is refused (the receipt is stored: first record wins)', async () => {
      const o = await orphan(stopped)
      await o.client.cancelTask({ id: o.id, tenant: '', metadata: undefined })
      expect(await applyLateResult(boot(), o.key, { state: 'completed', parts: [{ text: 'late' }] })).toBe('refused')
    })

    it('C8 -32002 on the wire is the M1 fixed text for a terminal task, an in-progress claim and a lost race; no probe string from a port or executor appears in any response, log or persisted task', async () => {
      const o = await orphan(stopped)
      await primary.query(`UPDATE a2a_v1_operations SET state='cancel_pending', recovery_state='recovering', claim_kind='cancel', claim_token='other', recovery_updated_at = now() WHERE task_id=$1`, [o.id])
      const inProgress = await o.runtime.raw('CancelTask', { id: o.id })
      expect(JSON.parse(inProgress.text).error).toEqual(expect.objectContaining({ code: -32002, message: 'Task cannot be canceled' }))
      await primary.query('TRUNCATE a2a_v1_tasks, a2a_v1_operations')
      const done = await orphan(stopped)
      await done.client.cancelTask({ id: done.id, tenant: '', metadata: undefined })
      const terminal = await done.runtime.raw('CancelTask', { id: done.id })
      expect(JSON.parse(terminal.text).error).toEqual(expect.objectContaining({ code: -32002, message: 'Task cannot be canceled' }))
      expect(terminal.text).not.toMatch(/probe|secret/u)
    })

    it('C9 generation n+1: a follow-up during cancel_pending supersedes generation n (the hold-back no longer applies, a late result for n is stale)', async () => {
      const recovery = boot({ port: cancelPort(stopped) })
      const key1 = await seed(recovery, 'c9', 'TASK_STATE_WORKING', 'm1')
      await recovery.claimCancel(alice, 'c9', 'tok')
      await primary.query(`UPDATE a2a_v1_operations SET recovery_state='recovery_required' WHERE task_id='c9'`)
      await recovery.begin(alice, 'c9', 'm2')
      await tasks({ cancelHoldBack: true }).save(fixture('c9', 'TASK_STATE_CANCELED'), alice)
      expect(await stateOf('c9')).toBe('TASK_STATE_CANCELED')
      expect(await applyLateResult(recovery, key1, { state: 'completed', parts: [{ text: 'x' }] })).toBe('stale')
    })

    it('C10 with a port, a task in INPUT_REQUIRED or AUTH_REQUIRED still takes the M2 synthetic cancel (no claim, no inspect), unless the latest operation is cancel_pending (then -32002)', async () => {
      const o = await orphan(stopped, { text: 'input' })
      expect(await stateOf(o.id)).toBe('TASK_STATE_INPUT_REQUIRED')
      const canceled = await o.client.cancelTask({ id: o.id, tenant: '', metadata: undefined })
      expect(canceled.status!.state).toBe(canceledState)
      expect(o.p.inspect).not.toHaveBeenCalled()
      expect(await op(o.id)).toMatchObject({ state: 'started', recoveryState: null })
      await primary.query('TRUNCATE a2a_v1_tasks, a2a_v1_operations')
      const p = await orphan(stopped, { text: 'input' })
      await primary.query(`UPDATE a2a_v1_operations SET state='cancel_pending', recovery_state='recovery_required' WHERE task_id=$1`, [p.id])
      await expect(p.client.cancelTask({ id: p.id, tenant: '', metadata: undefined })).rejects.toMatchObject({ envelopeCode: -32002 })
      expect(await stateOf(p.id)).toBe('TASK_STATE_INPUT_REQUIRED')
    })

    it('C11 projection: cancel_pending + recovery_required shows the marker (never persisted); cancel_pending + recovering does not', async () => {
      const o = await orphan({ status: 'unknown' })
      await o.client.cancelTask({ id: o.id, tenant: '', metadata: undefined })
      const got = await o.client.getTask({ id: o.id, tenant: '' })
      expect(got.metadata).toMatchObject({ dzupRecovery: 'required' })
      expect(JSON.stringify((await primary.query(`SELECT task FROM a2a_v1_tasks WHERE id=$1`, [o.id])).rows[0].task)).not.toContain('dzupRecovery')
      await primary.query(`UPDATE a2a_v1_operations SET recovery_state='recovering', claim_kind='cancel' WHERE task_id=$1`, [o.id])
      expect((await o.client.getTask({ id: o.id, tenant: '' })).metadata?.dzupRecovery).toBeUndefined()
    })

    it('C12 handler and scanner agree: the port and the timings come from the recovery instance; the scanner takes the instance port, accepts a passed port when the instance has none, throws when both exist and differ, and a per-call value that differs from an explicit instance value throws', async () => {
      const own = cancelPort(stopped)
      const instance = boot({ port: own, claimTtlMs: 120_000, inspectTimeoutMs: 5_000 })
      expect(instance.port).toBe(own)
      expect(instance.claimTtlMs).toBe(120_000)
      expect(instance.inspectTimeoutMs).toBe(5_000)
      expect(boot({ claimTtlMs: 8_000, inspectTimeoutMs: 10_000 }).inspectTimeoutMs).toBe(2_000) // clamped to claimTtlMs / 4
      expect(boot({ claimTtlMs: 8_000 }).inspectTimeoutMs).toBe(2_000)
      expect(boot().inspectTimeoutMs).toBe(10_000)
      expect(boot().claimTtlMs).toBe(300_000)
      expect(boot().minAgeMs).toBe(60_000)
      await expect(recoverOrphanedA2AV1Tasks(instance, cancelPort(stopped), { minAgeMs: 0 })).rejects.toThrow(/port/u)
      await expect(recoverOrphanedA2AV1Tasks(instance, undefined, { claimTtlMs: 5_000, minAgeMs: 0 })).rejects.toThrow(/claimTtlMs/u)
      await expect(recoverOrphanedA2AV1Tasks(instance, undefined, { inspectTimeoutMs: 1, minAgeMs: 0 })).rejects.toThrow(/inspectTimeoutMs/u)
      // A per-call value is compared against the CLAMPED instance value.
      const clamped = boot({ claimTtlMs: 8_000, inspectTimeoutMs: 10_000 })
      await expect(recoverOrphanedA2AV1Tasks(clamped, undefined, { inspectTimeoutMs: 10_000, minAgeMs: 0 })).rejects.toThrow(/inspectTimeoutMs/u)
      await expect(recoverOrphanedA2AV1Tasks(clamped, undefined, { inspectTimeoutMs: 2_000, minAgeMs: 0 })).resolves.toEqual([])
      await expect(recoverOrphanedA2AV1Tasks(boot({ minAgeMs: 5_000 }), undefined, { minAgeMs: 1 })).rejects.toThrow(/minAgeMs/u)
      // An instance without a port accepts a passed port (every M3a call keeps working).
      await expect(recoverOrphanedA2AV1Tasks(boot(), cancelPort(stopped), { minAgeMs: 0 })).resolves.toEqual([])
    })

    it('C13 new behaviours: without a port a leftover cancel_pending row makes CancelTask return -32002 (the widened guard); after each cancel resolution the receipt is stored, recovery_state is null and the operation is resolved', async () => {
      const { id } = await orphanFromRestart()
      await primary.query(`UPDATE a2a_v1_operations SET state='cancel_pending', recovery_state='recovery_required' WHERE task_id=$1`, [id])
      const noPort = await startHttp(boot(), tasks())
      await expect((await noPort.clientFor()).cancelTask({ id, tenant: '', metadata: undefined })).rejects.toMatchObject({ envelopeCode: -32002 })
      expect(noPort.canceled).toEqual([])
      for (const [index, answer] of [[1, stopped], [2, { status: 'not_applied', receiptRef: digest('b') }], [3, { status: 'terminal', receiptRef: digest('c'), terminal: { state: 'failed' } }]] as const) {
        await primary.query('TRUNCATE a2a_v1_tasks, a2a_v1_operations')
        const o = await orphan(answer)
        await o.client.cancelTask({ id: o.id, tenant: '', metadata: undefined }).catch(() => undefined)
        expect(await op(o.id), String(index)).toMatchObject({ state: 'resolved', recoveryState: null })
        expect((await op(o.id)).receipt).not.toBeNull()
      }
    })
  })
})
