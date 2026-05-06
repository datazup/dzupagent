/**
 * Postgres-backed regression coverage for the tenant-scope persistence lane.
 *
 * The suite is skipped when Docker/testcontainers are unavailable. It applies
 * the additive 0007 migration to a pre-tenant schema, then exercises the
 * Drizzle-backed catalog and cluster stores against a real Postgres database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { Client as PgClient } from 'pg'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { DrizzleCatalogStore } from '../marketplace/drizzle-catalog-store.js'
import { DrizzleClusterStore } from '../persistence/drizzle-cluster-store.js'

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

async function createPreTenantSchema(client: PgClient): Promise<void> {
  await client.query(`
    CREATE TABLE agent_catalog (
      id uuid PRIMARY KEY,
      slug text NOT NULL,
      name text NOT NULL,
      description text,
      version text NOT NULL,
      tags text[] NOT NULL DEFAULT ARRAY[]::text[],
      author text,
      readme text,
      published_at timestamp,
      is_public boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX agent_catalog_slug_idx ON agent_catalog (slug);
    CREATE INDEX agent_catalog_author_idx ON agent_catalog (author);

    CREATE TABLE agent_clusters (
      id text PRIMARY KEY,
      workspace_type varchar(50) NOT NULL DEFAULT 'local',
      workspace_options jsonb DEFAULT '{}'::jsonb,
      metadata jsonb DEFAULT '{}'::jsonb,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE cluster_roles (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      cluster_id text NOT NULL REFERENCES agent_clusters(id) ON DELETE CASCADE,
      role_id varchar(255) NOT NULL,
      agent_id text NOT NULL,
      capabilities jsonb DEFAULT '[]'::jsonb,
      created_at timestamp NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX cluster_roles_cluster_role_idx ON cluster_roles (cluster_id, role_id);
    CREATE INDEX cluster_roles_cluster_id_idx ON cluster_roles (cluster_id);
  `)
}

async function applyTenantMigration(client: PgClient): Promise<void> {
  const migration = await readFile(
    new URL('../../drizzle/0007_catalog_cluster_tenant.sql', import.meta.url),
    'utf8',
  )
  await client.query(migration)
}

describe.skipIf(!canRun)('tenant-scope Postgres migration and stores (testcontainers)', () => {
  const GC = GenericContainerClass!

  let container: StartedTestContainer
  let pgClient: PgClient
  let db: PostgresJsDatabase
  let catalogStore: DrizzleCatalogStore
  let clusterStore: DrizzleClusterStore

  beforeAll(async () => {
    const containerDef = new GC('postgres:16-alpine')
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

    const { default: pg } = await import('pg')
    pgClient = new pg.Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: 'test',
      password: 'test',
      database: 'testdb',
    })
    await pgClient.connect()

    await createPreTenantSchema(pgClient)
    await pgClient.query(`
      INSERT INTO agent_catalog (id, slug, name, version)
      VALUES ('11111111-1111-1111-1111-111111111111', 'legacy-agent', 'Legacy Agent', '1.0.0');
      INSERT INTO agent_clusters (id)
      VALUES ('legacy-cluster');
    `)
    await applyTenantMigration(pgClient)

    const { drizzle } = await import('drizzle-orm/node-postgres')
    db = drizzle(pgClient) as unknown as PostgresJsDatabase
    catalogStore = new DrizzleCatalogStore(db)
    clusterStore = new DrizzleClusterStore(db)
  }, 120_000)

  afterAll(async () => {
    try { await pgClient?.end() } catch { /* ignore */ }
    await container?.stop()
  }, 30_000)

  it('applies 0007 as an additive migration with default tenant values and indexes', async () => {
    await applyTenantMigration(pgClient)

    const catalogRows = await pgClient.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM agent_catalog WHERE slug = 'legacy-agent'",
    )
    const clusterRows = await pgClient.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM agent_clusters WHERE id = 'legacy-cluster'",
    )
    const indexes = await pgClient.query<{
      catalog_tenant_idx: string | null
      catalog_slug_idx: string | null
      legacy_catalog_slug_idx: string | null
      cluster_idx: string | null
    }>(`
      SELECT
        to_regclass('agent_catalog_tenant_id_idx')::text AS catalog_tenant_idx,
        to_regclass('agent_catalog_tenant_slug_idx')::text AS catalog_slug_idx,
        to_regclass('agent_catalog_slug_idx')::text AS legacy_catalog_slug_idx,
        to_regclass('agent_clusters_tenant_id_idx')::text AS cluster_idx
    `)

    expect(catalogRows.rows[0]?.tenant_id).toBe('default')
    expect(clusterRows.rows[0]?.tenant_id).toBe('default')
    expect(indexes.rows[0]?.catalog_tenant_idx).toBe('agent_catalog_tenant_id_idx')
    expect(indexes.rows[0]?.catalog_slug_idx).toBe('agent_catalog_tenant_slug_idx')
    expect(indexes.rows[0]?.legacy_catalog_slug_idx).toBeNull()
    expect(indexes.rows[0]?.cluster_idx).toBe('agent_clusters_tenant_id_idx')
  })

  it('allows duplicate catalog slugs across tenants on real Postgres', async () => {
    await pgClient.query('TRUNCATE cluster_roles, agent_clusters, agent_catalog RESTART IDENTITY')

    const tenantA = await catalogStore.create({
      id: '22222222-2222-2222-2222-222222222222',
      slug: 'shared-agent',
      name: 'Tenant A Agent',
      description: null,
      version: '1.0.0',
      tags: [],
      author: null,
      readme: null,
      publishedAt: null,
      isPublic: true,
      tenantId: 'tenant-a',
    })
    const tenantB = await catalogStore.create({
      id: '33333333-3333-3333-3333-333333333333',
      slug: 'shared-agent',
      name: 'Tenant B Agent',
      description: null,
      version: '1.0.0',
      tags: [],
      author: null,
      readme: null,
      publishedAt: null,
      isPublic: true,
      tenantId: 'tenant-b',
    })

    expect(tenantA.tenantId).toBe('tenant-a')
    expect(tenantB.tenantId).toBe('tenant-b')
    await expect(catalogStore.create({
      id: '44444444-4444-4444-4444-444444444444',
      slug: 'shared-agent',
      name: 'Tenant A Duplicate',
      description: null,
      version: '1.0.0',
      tags: [],
      author: null,
      readme: null,
      publishedAt: null,
      isPublic: true,
      tenantId: 'tenant-a',
    })).rejects.toThrow('Slug already exists')
  })

  it('keeps catalog updates tenant-scoped on real Postgres', async () => {
    await pgClient.query('TRUNCATE cluster_roles, agent_clusters, agent_catalog RESTART IDENTITY')

    const created = await catalogStore.create({
      id: '22222222-2222-2222-2222-222222222222',
      slug: 'tenant-a-agent',
      name: 'Tenant A Agent',
      description: null,
      version: '1.0.0',
      tags: [],
      author: null,
      readme: null,
      publishedAt: null,
      isPublic: true,
      tenantId: 'tenant-a',
    })

    const updated = await catalogStore.update(
      created.id,
      { name: 'Still Tenant A Agent', tenantId: 'tenant-b' },
      'tenant-a',
    )

    expect(updated.tenantId).toBe('tenant-a')
    expect(await catalogStore.getById(created.id, 'tenant-a')).toEqual(
      expect.objectContaining({ name: 'Still Tenant A Agent', tenantId: 'tenant-a' }),
    )
    expect(await catalogStore.getById(created.id, 'tenant-b')).toBeNull()
  })

  it('keeps cluster role mutations tenant-scoped and reports deletes accurately', async () => {
    await pgClient.query('TRUNCATE cluster_roles, agent_clusters, agent_catalog RESTART IDENTITY')

    await clusterStore.create({ id: 'cluster-a', tenantId: 'tenant-a' })
    await clusterStore.addRole(
      'cluster-a',
      { roleId: 'planner', agentId: 'agent-a', capabilities: ['plan'] },
      'tenant-a',
    )

    await expect(clusterStore.addRole(
      'cluster-a',
      { roleId: 'reviewer', agentId: 'agent-b', capabilities: ['review'] },
      'tenant-b',
    )).rejects.toThrow('NotFound')
    expect(await clusterStore.listRoles('cluster-a', 'tenant-b')).toEqual([])

    const wrongTenantRemove = await clusterStore.removeRole('cluster-a', 'planner', 'tenant-b')
    expect(wrongTenantRemove).toBe(false)

    const removed = await clusterStore.removeRole('cluster-a', 'planner', 'tenant-a')
    expect(removed).toBe(true)
    expect(await clusterStore.listRoles('cluster-a', 'tenant-a')).toEqual([])

    expect(await clusterStore.delete('cluster-a', 'tenant-b')).toBe(false)
    expect(await clusterStore.delete('cluster-a', 'tenant-a')).toBe(true)
  })
})
