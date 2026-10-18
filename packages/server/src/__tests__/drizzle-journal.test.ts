/**
 * Journal consistency for packages/server/drizzle (DZUPAGENT-OPS-H-MIGRATION-JOURNAL).
 *
 * drizzle-kit migrate applies only journal-listed files, and applies an entry
 * only when the last recorded `created_at` is below its `when`. The legacy
 * entries 0000-0018 were all recorded with `when: 0` and must stay that way:
 * changing them would re-run applied migrations on existing databases. Every
 * later entry needs a non-zero, strictly increasing `when` so that databases
 * already at 0018 still pick it up.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle')

interface JournalEntry {
  idx: number
  when: number
  tag: string
}

const journal = JSON.parse(
  readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
) as { entries: JournalEntry[] }

const LEGACY_TAGS = [
  '0000_forge_baseline',
  '0001_agent_mail_dlq',
  '0002_run_status_halted',
  '0003_run_artifacts_api_keys',
  '0004_run_owner_id',
  '0005_api_key_quotas',
  '0005_rbac_tenant',
  '0006_a2a_owner_tenant',
  '0007_catalog_cluster_tenant',
  '0008_run_reflections_owner_tenant',
  '0009_p4_schedule_ha',
  '0010_p2_flow_artifacts_approvals',
  '0011_p1_worker_nodes',
  '0012_p2_flow_jobs',
  '0014_s4_tenant_id_sweep',
  '0015_s4h_worker_providers',
  '0016_oq3_node_adapter_meta',
  '0017_stage5_flow_events',
  '0018_c2_import_lock_chains',
]

/**
 * Run drizzle-orm's real PostgreSQL migrate() against a recording session and
 * return the tags it applied, in order. `lastCreatedAt` is the newest
 * `created_at` already recorded in `__drizzle_migrations`.
 */
async function appliedTags(lastCreatedAt: number | undefined): Promise<string[]> {
  const dialect = new PgDialect()
  const tagByHash = new Map(
    journal.entries.map((entry) => [
      createHash('sha256')
        .update(readFileSync(join(migrationsFolder, `${entry.tag}.sql`)).toString())
        .digest('hex'),
      entry.tag,
    ]),
  )
  const applied: string[] = []
  const tx = {
    execute: async (query: SQL) => {
      const { sql, params } = dialect.sqlToQuery(query)
      if (/^insert into/i.test(sql.trim())) applied.push(tagByHash.get(String(params[0])) ?? 'unknown')
      return []
    },
  }
  const session = {
    execute: async () => [],
    all: async () =>
      lastCreatedAt === undefined ? [] : [{ id: 1, hash: 'recorded', created_at: String(lastCreatedAt) }],
    transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
  }
  await dialect.migrate(
    readMigrationFiles({ migrationsFolder }),
    session as unknown as Parameters<PgDialect['migrate']>[1],
    { migrationsFolder },
  )
  return applied
}

describe('drizzle migration journal (DZUPAGENT-OPS-H-MIGRATION-JOURNAL)', () => {
  it('registers every SQL file exactly once and every entry has a file', () => {
    const files = readdirSync(migrationsFolder)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.slice(0, -'.sql'.length))
      .sort()
    const tags = journal.entries.map((entry) => entry.tag)

    expect(new Set(tags).size).toBe(tags.length)
    expect([...tags].sort()).toEqual(files)
  })

  it('keeps the legacy zero prefix and orders every later entry by a non-zero when', () => {
    const zeroPrefix = journal.entries.findIndex((entry) => entry.when !== 0)
    expect(zeroPrefix).toBe(LEGACY_TAGS.length)
    expect(journal.entries.slice(0, zeroPrefix).map((entry) => entry.tag)).toEqual(LEGACY_TAGS)

    const later = journal.entries.slice(zeroPrefix)
    expect(later.length).toBeGreaterThan(0)
    let previous = 0
    for (const entry of later) {
      expect(entry.when).toBeGreaterThan(previous)
      previous = entry.when
    }
  })

  it('selects the right migrations for fresh, upgraded and current databases', async () => {
    const allTags = journal.entries.map((entry) => entry.tag)
    const maxWhen = Math.max(...journal.entries.map((entry) => entry.when))

    const fresh = await appliedTags(undefined)
    expect(fresh).toEqual(allTags)
    expect(fresh).toContain('0019_reflection_scored_flag')
    expect(fresh).toContain('0020_agent_mail_dlq_tenant')

    expect(await appliedTags(0)).toEqual(['0019_reflection_scored_flag', '0020_agent_mail_dlq_tenant'])
    expect(await appliedTags(maxWhen)).toEqual([])
  })
})
