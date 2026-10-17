/**
 * Real-PostgreSQL proof for the drizzle migration journal
 * (DZUPAGENT-OPS-H-MIGRATION-JOURNAL).
 *
 * Runs drizzle-orm's node-postgres migrator — the one `drizzle-kit migrate`
 * (`db:migrate`) wraps — over packages/server/drizzle: fresh provisioning, an
 * upgrade from a database that stopped at 0018, and a repeat run. The suite is
 * skipped when Docker/testcontainers are unavailable unless
 * RUN_REQUIRED_INTEGRATION=1 makes absence fail closed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Client as PgClient } from 'pg'
import { requireIntegration } from './helpers/require-integration.js'

interface StartedTestContainer {
  getHost(): string
  getMappedPort(port: number): number
  stop(): Promise<unknown>
}

interface GenericContainerLike {
  withName(name: string): GenericContainerLike
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
const forceContainerRuntime = process.env['DZUPAGENT_RUN_TESTCONTAINERS'] === '1'
let containerRuntimeAvailable = forceContainerRuntime

try {
  const tc = await import('testcontainers')
  GenericContainerClass = tc.GenericContainer as unknown as GenericContainerCtor
  WaitClass = tc.Wait as unknown as { forListeningPorts(): unknown }
} catch {
  // testcontainers is optional for local runs.
}

try {
  if (!forceContainerRuntime) {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    await exec('docker', ['info'], { timeout: 5000 })
    containerRuntimeAvailable = true
  }
} catch {
  // No container runtime available in this environment.
}

const canRun = GenericContainerClass !== undefined && containerRuntimeAvailable

const integrationGate = requireIntegration({
  name: 'drizzle migration journal against Postgres (testcontainers)',
  available: canRun,
  reason:
    GenericContainerClass === undefined
      ? 'testcontainers is not installed'
      : 'Docker (container runtime) is not available',
})

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle')
const LEGACY_LAST_IDX = 18

describe.skipIf(integrationGate.shouldSkip)('drizzle migration journal against Postgres (testcontainers)', () => {
  const GC = GenericContainerClass!

  let container: StartedTestContainer
  let legacyFolder: string
  const clients: PgClient[] = []

  async function connect(database: string): Promise<PgClient> {
    const { default: pg } = await import('pg')
    // The postgres image restarts once after initdb, so a listening port can
    // still answer "the database system is starting up" (SQLSTATE 57P03).
    for (let attempt = 1; ; attempt++) {
      const client = new pg.Client({
        host: container.getHost(),
        port: container.getMappedPort(5432),
        user: 'test',
        password: 'test',
        database,
      })
      try {
        await client.connect()
        clients.push(client)
        return client
      } catch (error) {
        await client.end().catch(() => undefined)
        const startingUp = (error as { code?: string }).code === '57P03'
        if (!startingUp || attempt >= 60) throw error
        // sleep-ok: real container readiness backoff; fake timers cannot advance an external Postgres restart
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  }

  async function migrateFolder(client: PgClient, folder: string): Promise<void> {
    const { drizzle } = await import('drizzle-orm/node-postgres')
    const { migrate } = await import('drizzle-orm/node-postgres/migrator')
    await migrate(drizzle(client), { migrationsFolder: folder })
  }

  async function columnExists(client: PgClient, table: string, column: string): Promise<boolean> {
    const result = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
      [table, column],
    )
    return result.rowCount === 1
  }

  async function recordedMigrations(client: PgClient): Promise<number> {
    const result = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
    )
    return Number(result.rows[0]!.count)
  }

  beforeAll(async () => {
    const containerDef = new GC('postgres:18')
      .withName(`datazup-dzupagent-migrations-test-postgres-${process.pid}`)
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

    const admin = await connect('testdb')
    await admin.query('CREATE DATABASE fresh_db')
    await admin.query('CREATE DATABASE upgrade_db')

    // A migrations folder as it was before 0019/0020 were registered: the same
    // SQL files, with the journal cut at the last legacy entry.
    legacyFolder = await mkdtemp(join(tmpdir(), 'dzupagent-legacy-migrations-'))
    await mkdir(join(legacyFolder, 'meta'))
    for (const name of await readdir(migrationsFolder)) {
      if (name.endsWith('.sql')) await copyFile(join(migrationsFolder, name), join(legacyFolder, name))
    }
    const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number }>
    }
    journal.entries = journal.entries.filter((entry) => entry.idx <= LEGACY_LAST_IDX)
    await writeFile(join(legacyFolder, 'meta/_journal.json'), JSON.stringify(journal, null, 2))
  }, 120_000)

  afterAll(async () => {
    for (const client of clients) {
      try { await client.end() } catch { /* ignore */ }
    }
    if (legacyFolder) await rm(legacyFolder, { recursive: true, force: true })
    await container?.stop()
  }, 30_000)

  it('provisions a fresh database with every column the schema requires', async () => {
    const client = await connect('fresh_db')
    await migrateFolder(client, migrationsFolder)

    expect(await columnExists(client, 'run_reflections', 'scored')).toBe(true)
    expect(await columnExists(client, 'agent_mail_dlq', 'tenant_id')).toBe(true)
    const index = await client.query<{ idx: string | null }>(
      "SELECT to_regclass('agent_mail_dlq_tenant_id_idx')::text AS idx",
    )
    expect(index.rows[0]!.idx).toBe('agent_mail_dlq_tenant_id_idx')
  })

  it('upgrades a database at 0018 and keeps its rows', async () => {
    const client = await connect('upgrade_db')
    await migrateFolder(client, legacyFolder)
    expect(await columnExists(client, 'run_reflections', 'scored')).toBe(false)

    await client.query(`
      INSERT INTO run_reflections
        (run_id, completed_at, duration_ms, total_steps, tool_call_count, error_count, quality_score)
      VALUES ('legacy-run', now(), 10, 2, 1, 0, 0.75)
    `)
    await client.query(`
      INSERT INTO agent_mail_dlq
        (id, original_message_id, from_agent, to_agent, subject, body, fail_reason, next_retry_at, created_at)
      VALUES ('legacy-dlq', 'msg-1', 'a', 'b', 'subject', '{}'::jsonb, 'failed', 0, 0)
    `)

    await migrateFolder(client, migrationsFolder)

    const reflection = await client.query<{ scored: boolean; quality_score: number }>(
      "SELECT scored, quality_score FROM run_reflections WHERE run_id = 'legacy-run'",
    )
    expect(reflection.rows).toEqual([{ scored: true, quality_score: 0.75 }])
    const dlq = await client.query<{ tenant_id: string; subject: string }>(
      "SELECT tenant_id, subject FROM agent_mail_dlq WHERE id = 'legacy-dlq'",
    )
    expect(dlq.rows).toEqual([{ tenant_id: 'default', subject: 'subject' }])
  })

  it('treats a repeat migration as a no-op', async () => {
    const client = await connect('fresh_db')
    const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
      entries: unknown[]
    }
    const before = await recordedMigrations(client)
    expect(before).toBe(journal.entries.length)

    await migrateFolder(client, migrationsFolder)

    expect(await recordedMigrations(client)).toBe(before)
  })
})
