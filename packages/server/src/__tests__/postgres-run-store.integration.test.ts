/**
 * Integration tests for PostgresRunStore using a real PostgreSQL container.
 *
 * Prerequisites:
 * - Docker must be running
 * - `testcontainers` must be installed as a devDependency
 *
 * The suite is skipped automatically when Docker is unavailable or
 * testcontainers cannot be imported.
 *
 * Uses the `pgvector/pgvector:pg16` image so the `vector` extension is
 * pre-installed and vector columns in the schema do not cause errors.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { LogEntry } from '@dzupagent/core'
import type { Client as PgClient } from 'pg'
import type { PostgresRunStore } from '../persistence/postgres-stores.js'

// ---------------------------------------------------------------------------
// Conditional container runtime detection
// ---------------------------------------------------------------------------

interface StartedTestContainer {
  getMappedPort(port: number): number
  getHost(): string
  stop(): Promise<void>
}

interface GenericContainerLike {
  withExposedPorts(...ports: number[]): GenericContainerLike
  withEnvironment(env: Record<string, string>): GenericContainerLike
  withWaitStrategy(strategy: unknown): GenericContainerLike
  start(): Promise<StartedTestContainer>
}

interface GenericContainerCtor {
  new(image: string): GenericContainerLike
}

let GenericContainerClass: GenericContainerCtor | undefined
let WaitClass: { forListeningPorts(): unknown } | undefined
let containerRuntimeAvailable = false

try {
  const tc = await import('testcontainers')
  GenericContainerClass = tc.GenericContainer as unknown as GenericContainerCtor
  WaitClass = tc.Wait as unknown as { forListeningPorts(): unknown }
} catch {
  // testcontainers not installed
}

try {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  await exec('docker', ['info'], { timeout: 5000 })
  containerRuntimeAvailable = true
} catch {
  // No container runtime available in this environment.
}

const canRun = GenericContainerClass !== undefined && containerRuntimeAvailable

// ---------------------------------------------------------------------------
// Helpers — DB initialisation
// ---------------------------------------------------------------------------

/**
 * Create all tables needed by PostgresRunStore. Uses raw SQL so we don't
 * need a migration directory: the schema is derived directly from drizzle-schema.ts.
 */
async function createSchema(client: PgClient): Promise<void> {
  await client.query('CREATE EXTENSION IF NOT EXISTS vector')

  await client.query(`
    CREATE TABLE IF NOT EXISTS dzip_agents (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name        VARCHAR(255) NOT NULL,
      description TEXT,
      instructions TEXT NOT NULL,
      model_tier  VARCHAR(50) NOT NULL,
      tools       JSONB DEFAULT '[]',
      guardrails  JSONB,
      approval    VARCHAR(20) NOT NULL DEFAULT 'auto',
      version     INTEGER NOT NULL DEFAULT 1,
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      metadata    JSONB DEFAULT '{}',
      instruction_embedding vector(1536),
      created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS forge_runs (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id            UUID NOT NULL REFERENCES dzip_agents(id),
      status              VARCHAR(30) NOT NULL DEFAULT 'queued',
      input               JSONB,
      output              JSONB,
      plan                JSONB,
      token_usage_input   INTEGER DEFAULT 0,
      token_usage_output  INTEGER DEFAULT 0,
      cost_cents          REAL DEFAULT 0,
      error               TEXT,
      owner_id            TEXT,
      metadata            JSONB DEFAULT '{}',
      input_embedding     vector(1536),
      output_embedding    vector(1536),
      started_at          TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at        TIMESTAMP
    )
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS forge_run_logs (
      id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id    UUID NOT NULL REFERENCES forge_runs(id) ON DELETE CASCADE,
      level     VARCHAR(10) NOT NULL,
      phase     VARCHAR(50),
      message   TEXT NOT NULL,
      data      JSONB,
      timestamp TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `)
}

/** Seed a minimal agent row and return its UUID. */
async function seedAgent(client: PgClient): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO dzip_agents (name, instructions, model_tier)
     VALUES ($1, $2, $3)
     RETURNING id`,
    ['test-agent', 'You are a test agent.', 'standard'],
  )
  return res.rows[0]!.id
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)('PostgresRunStore integration (testcontainers)', () => {
  const GC = GenericContainerClass!

  let container: StartedTestContainer
  let pgClient: PgClient
  let store: PostgresRunStore
  let agentId: string

  beforeAll(async () => {
    // ----------------------------------------------------------------
    // 1. Start PostgreSQL container (pgvector image ships the extension)
    // ----------------------------------------------------------------
    const containerDef = new GC('pgvector/pgvector:pg16')
      .withExposedPorts(5432)
      .withEnvironment({
        POSTGRES_USER: 'test',
        POSTGRES_PASSWORD: 'test',
        POSTGRES_DB: 'testdb',
      })

    if (WaitClass) {
      containerDef.withWaitStrategy(WaitClass.forListeningPorts())
    }

    container = await containerDef.start()

    const host = container.getHost()
    const port = container.getMappedPort(5432)

    // ----------------------------------------------------------------
    // 2. Connect with plain pg + Drizzle node-postgres adapter
    // ----------------------------------------------------------------
    const { default: pg } = await import('pg')
    pgClient = new pg.Client({
      host,
      port,
      user: 'test',
      password: 'test',
      database: 'testdb',
    })
    await pgClient.connect()

    // ----------------------------------------------------------------
    // 3. Create schema
    // ----------------------------------------------------------------
    await createSchema(pgClient)

    // ----------------------------------------------------------------
    // 4. Build Drizzle DB and wrap in PostgresRunStore
    //    drizzle-orm/node-postgres returns NodePgDatabase which is
    //    structurally compatible with the PostgresJsDatabase interface
    //    used internally; we cast to satisfy TypeScript.
    // ----------------------------------------------------------------
    const { drizzle } = await import('drizzle-orm/node-postgres')
    const { PostgresRunStore } = await import('../persistence/postgres-stores.js')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = drizzle(pgClient) as any
    store = new PostgresRunStore(db)

    // ----------------------------------------------------------------
    // 5. Seed a test agent (FK requirement for forge_runs.agent_id)
    // ----------------------------------------------------------------
    agentId = await seedAgent(pgClient)
  }, 120_000) // Container pull + start can be slow on first run

  afterAll(async () => {
    try { await pgClient?.end() } catch { /* ignore */ }
    await container?.stop()
  }, 30_000)

  // -------------------------------------------------------------------------
  // create() + get() round-trip
  // -------------------------------------------------------------------------

  it('create() returns a run with queued status and get() retrieves it', async () => {
    const run = await store.create({
      agentId,
      input: { prompt: 'hello world' },
      metadata: { source: 'integration-test' },
    })

    expect(run.id).toBeTruthy()
    expect(run.agentId).toBe(agentId)
    expect(run.status).toBe('queued')
    expect(run.input).toEqual({ prompt: 'hello world' })
    expect(run.metadata).toMatchObject({ source: 'integration-test' })
    expect(run.startedAt).toBeInstanceOf(Date)

    const fetched = await store.get(run.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.id).toBe(run.id)
    expect(fetched!.agentId).toBe(agentId)
    expect(fetched!.status).toBe('queued')
    expect(fetched!.input).toEqual({ prompt: 'hello world' })
  })

  it('get() returns null for a non-existent id', async () => {
    const result = await store.get('00000000-0000-0000-0000-000000000000')
    expect(result).toBeNull()
  })

  // -------------------------------------------------------------------------
  // update() — status transitions
  // -------------------------------------------------------------------------

  it('update() status change is reflected in subsequent get()', async () => {
    const run = await store.create({ agentId, input: { task: 'status-test' } })
    expect(run.status).toBe('queued')

    await store.update(run.id, {
      status: 'running',
    })

    const updated = await store.get(run.id)
    expect(updated!.status).toBe('running')
  })

  it('update() sets output and completedAt on completion', async () => {
    const run = await store.create({ agentId, input: { task: 'complete-me' } })

    const completedAt = new Date()
    await store.update(run.id, {
      status: 'completed',
      output: { result: 'done' },
      completedAt,
    })

    const fetched = await store.get(run.id)
    expect(fetched!.status).toBe('completed')
    expect(fetched!.output).toEqual({ result: 'done' })
    expect(fetched!.completedAt).toBeInstanceOf(Date)
  })

  it('update() persists error text', async () => {
    const run = await store.create({ agentId, input: { task: 'will-fail' } })

    await store.update(run.id, {
      status: 'failed',
      error: 'Something went wrong',
    })

    const fetched = await store.get(run.id)
    expect(fetched!.status).toBe('failed')
    expect(fetched!.error).toBe('Something went wrong')
  })

  it('update() persists tokenUsage and costCents', async () => {
    const run = await store.create({ agentId, input: { task: 'cost-test' } })

    await store.update(run.id, {
      tokenUsage: { input: 150, output: 300 },
      costCents: 0.025,
    })

    const fetched = await store.get(run.id)
    expect(fetched!.tokenUsage).toEqual({ input: 150, output: 300 })
    expect(fetched!.costCents).toBeCloseTo(0.025, 4)
  })

  // -------------------------------------------------------------------------
  // addLog() + getLogs()
  // -------------------------------------------------------------------------

  it('addLog() and getLogs() round-trip preserves all fields', async () => {
    const run = await store.create({ agentId, input: { task: 'log-test' } })

    const ts = new Date('2026-01-01T00:00:00.000Z')
    const entry: LogEntry = {
      level: 'info',
      phase: 'init',
      message: 'Starting up',
      data: { key: 'value' },
      timestamp: ts,
    }

    await store.addLog(run.id, entry)

    const logs = await store.getLogs(run.id)
    expect(logs).toHaveLength(1)

    const log = logs[0]!
    expect(log.level).toBe('info')
    expect(log.phase).toBe('init')
    expect(log.message).toBe('Starting up')
    expect(log.data).toEqual({ key: 'value' })
    expect(log.timestamp).toBeInstanceOf(Date)
    expect(log.timestamp!.getTime()).toBe(ts.getTime())
  })

  it('addLog() stores warn and error levels correctly', async () => {
    const run = await store.create({ agentId, input: { task: 'multi-log' } })

    await store.addLog(run.id, { level: 'warn', message: 'Low memory' })
    await store.addLog(run.id, { level: 'error', message: 'Crash!', data: { code: 500 } })

    const logs = await store.getLogs(run.id)
    expect(logs).toHaveLength(2)

    const levels = logs.map(l => l.level)
    expect(levels).toContain('warn')
    expect(levels).toContain('error')

    const errorLog = logs.find(l => l.level === 'error')!
    expect(errorLog.data).toEqual({ code: 500 })
  })

  it('addLogs() inserts multiple entries atomically', async () => {
    const run = await store.create({ agentId, input: { task: 'batch-log' } })

    const entries: LogEntry[] = [
      { level: 'debug', message: 'step 1', timestamp: new Date('2026-01-01T00:00:01Z') },
      { level: 'debug', message: 'step 2', timestamp: new Date('2026-01-01T00:00:02Z') },
      { level: 'info', message: 'step 3', timestamp: new Date('2026-01-01T00:00:03Z') },
    ]

    await store.addLogs(run.id, entries)

    const logs = await store.getLogs(run.id)
    expect(logs).toHaveLength(3)
    expect(logs.map(l => l.message)).toEqual(['step 1', 'step 2', 'step 3'])
  })

  it('getLogs() returns empty array for a run with no logs', async () => {
    const run = await store.create({ agentId, input: { task: 'no-logs' } })
    const logs = await store.getLogs(run.id)
    expect(logs).toEqual([])
  })

  it('getLogs() only returns logs for the specified run', async () => {
    const run1 = await store.create({ agentId, input: { task: 'run1' } })
    const run2 = await store.create({ agentId, input: { task: 'run2' } })

    await store.addLog(run1.id, { level: 'info', message: 'from run1' })
    await store.addLog(run2.id, { level: 'info', message: 'from run2' })

    const logs1 = await store.getLogs(run1.id)
    const logs2 = await store.getLogs(run2.id)

    expect(logs1).toHaveLength(1)
    expect(logs1[0]!.message).toBe('from run1')
    expect(logs2).toHaveLength(1)
    expect(logs2[0]!.message).toBe('from run2')
  })

  // -------------------------------------------------------------------------
  // list() with filters
  // -------------------------------------------------------------------------

  it('list() returns all runs when no filter is given', async () => {
    // Create two fresh runs isolated by checking result length increases.
    const before = await store.list()
    await store.create({ agentId, input: { task: 'list-a' } })
    await store.create({ agentId, input: { task: 'list-b' } })
    const after = await store.list()
    expect(after.length).toBeGreaterThanOrEqual(before.length + 2)
  })

  it('list() with status filter returns only matching runs', async () => {
    const run = await store.create({ agentId, input: { task: 'status-filter' } })
    await store.update(run.id, { status: 'completed', completedAt: new Date() })

    const completed = await store.list({ status: 'completed' })
    const allStatuses = completed.map(r => r.status)
    expect(allStatuses.every(s => s === 'completed')).toBe(true)
    expect(completed.some(r => r.id === run.id)).toBe(true)
  })

  it('list() with agentId filter returns only runs for that agent', async () => {
    // Insert a second agent to verify isolation
    const agentId2 = await seedAgent(pgClient)

    await store.create({ agentId, input: { task: 'agent1-run' } })
    await store.create({ agentId: agentId2, input: { task: 'agent2-run' } })

    const runsForAgent1 = await store.list({ agentId })
    const runsForAgent2 = await store.list({ agentId: agentId2 })

    expect(runsForAgent1.every(r => r.agentId === agentId)).toBe(true)
    expect(runsForAgent2.every(r => r.agentId === agentId2)).toBe(true)

    // The two lists should be disjoint by ID.
    const ids1 = new Set(runsForAgent1.map(r => r.id))
    const ids2 = new Set(runsForAgent2.map(r => r.id))
    const intersection = [...ids2].filter(id => ids1.has(id))
    expect(intersection).toHaveLength(0)
  })

  it('list() respects limit and offset', async () => {
    // Ensure at least 3 runs for this agent exist.
    await store.create({ agentId, input: { task: 'paging-1' } })
    await store.create({ agentId, input: { task: 'paging-2' } })
    await store.create({ agentId, input: { task: 'paging-3' } })

    const page1 = await store.list({ agentId, limit: 2, offset: 0 })
    const page2 = await store.list({ agentId, limit: 2, offset: 2 })

    expect(page1.length).toBeLessThanOrEqual(2)
    expect(page2.length).toBeGreaterThanOrEqual(1)

    // No overlap between pages.
    const ids1 = new Set(page1.map(r => r.id))
    const overlap = page2.filter(r => ids1.has(r.id))
    expect(overlap).toHaveLength(0)
  })
})
