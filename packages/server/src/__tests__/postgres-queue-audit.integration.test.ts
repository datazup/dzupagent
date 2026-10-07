import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { PgDialect } from 'drizzle-orm/pg-core'
import { PostgresRunQueue, type PostgresRunQueueDatabase } from '../queue/postgres-run-queue.js'
const url = process.env.DZUPAGENT_AUDIT_POSTGRES_URL
// Explicit private fixture; never use the application's database connection.
describe.skipIf(!url)('Postgres queue ownership audit', () => {
  const client = postgres(url!, { max: 4 })
  const dialect = new PgDialect()
  const db: PostgresRunQueueDatabase = { async execute(statement) {
    const query = dialect.sqlToQuery(statement)
    return await client.unsafe(query.sql, query.params as postgres.ParameterOrJSON<never>[])
  } }
  beforeAll(async () => {
    await client.unsafe(`CREATE TABLE IF NOT EXISTS flow_jobs (id text primary key, run_id text, agent_id text, input jsonb, metadata jsonb, tenant_id text, priority integer default 0, attempts integer default 0, status text default 'pending', claimed_at timestamptz, claimed_by text, error text, created_at timestamptz default now(), updated_at timestamptz default now())`)
  })
  beforeEach(async () => { await client.unsafe("TRUNCATE flow_jobs") })
  afterAll(async () => { await client.end() })
  it.each(['complete', 'retry', 'fail'])('renews live jobs and fences stale %s transitions', async mode => {
    let finish!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const processing = new Promise<void>((resolve, reject) => { finish = () => mode === "complete" ? resolve() : reject(new Error("fixture failure")) })
    const a = new PostgresRunQueue({ db, workerId: 'a', pollIntervalMs: 0, claimTimeoutMs: 120, concurrency: 1, fairScheduling: false, maxRetries: mode === 'retry' ? 2 : 0 })
    const b = new PostgresRunQueue({ db, workerId: 'b', pollIntervalMs: 0, claimTimeoutMs: 120, concurrency: 1, fairScheduling: false })
    let bCalls = 0
    a.start(async () => { started(); await processing })
    b.start(async () => { bCalls++ })
    try {
      const job = await a.enqueue({ runId: 'audit-run', agentId: 'audit-agent', input: {}, priority: 0 })
      await a._poll(); await entered
      // Cross the original reclaim threshold while the first processor stays live.
      await new Promise(resolve => setTimeout(resolve, 280))
      await b._poll()
      expect(bCalls).toBe(0)
      const live = await client.unsafe('SELECT claimed_by, attempts FROM flow_jobs WHERE id = $1', [job.id])
      expect(live[0]).toMatchObject({ claimed_by: 'a', attempts: 1 })
      // Simulate a reclaimer winning the next generation, then release the stale worker.
      await client.unsafe("UPDATE flow_jobs SET claimed_by = 'b', attempts = attempts + 1, claimed_at = now() WHERE id = $1", [job.id])
      finish(); await a.stop()
      const retained = await client.unsafe('SELECT status, claimed_by, attempts FROM flow_jobs WHERE id = $1', [job.id])
      expect(retained[0]).toMatchObject({ status: 'claimed', claimed_by: 'b', attempts: 2 })
    } finally { finish(); await a.stop(); await b.stop() }
  })
})
