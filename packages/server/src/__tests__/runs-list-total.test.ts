/**
 * Session BB — GET /api/runs must return a `total` field representing the
 * full match count (ignoring pagination), alongside the existing paginated
 * `data` + page-size `count`.
 *
 * These tests exercise the route handler against InMemoryRunStore, which
 * implements the optional `count()` method added in this session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import type { PostgresApiKeyStore, ApiKeyRecord } from '../persistence/api-key-store.js'

interface RunsListResponse {
  data: Array<{ id: string; agentId: string; status: string; ownerId?: string | null; tenantId?: string | null }>
  count: number
  total: number
}

function makeApiKeyStore(records: Record<string, ApiKeyRecord>): PostgresApiKeyStore {
  return {
    validate: async (key: string) => records[key] ?? null,
    create: async () => { throw new Error('not implemented') },
    revoke: async () => {},
    list: async () => [],
    get: async () => null,
  } as unknown as PostgresApiKeyStore
}

function apiKeyRecord(id: string, tenantId = 'tenant-1'): ApiKeyRecord {
  return {
    id,
    ownerId: id,
    tenantId,
    name: 'test key',
    role: 'operator',
    rateLimitTier: 'standard',
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    metadata: {},
  }
}

function createTestConfig(): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
  }
}

describe('GET /api/runs — total count', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>

  beforeEach(async () => {
    config = createTestConfig()
    app = createForgeApp(config)
    await config.agentStore.save({
      id: 'agent-1',
      name: 'Agent One',
      instructions: 'test',
      modelTier: 'chat',
    })
    await config.agentStore.save({
      id: 'agent-2',
      name: 'Agent Two',
      instructions: 'test',
      modelTier: 'chat',
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns total=0 when no runs exist (empty list)', async () => {
    const res = await app.request('/api/runs')
    expect(res.status).toBe(200)

    const body = (await res.json()) as RunsListResponse
    expect(body.data).toEqual([])
    expect(body.count).toBe(0)
    expect(body.total).toBe(0)
  })

  it('returns total > count when page is smaller than total matching runs (partial page)', async () => {
    // Create 7 runs for agent-1
    for (let i = 0; i < 7; i++) {
      await config.runStore.create({ agentId: 'agent-1', input: `run-${i}` })
    }

    // Page size of 3 — there are 7 matches total
    const res = await app.request('/api/runs?limit=3')
    expect(res.status).toBe(200)

    const body = (await res.json()) as RunsListResponse
    expect(body.data.length).toBe(3)
    expect(body.count).toBe(3)
    expect(body.total).toBe(7)
  })

  it('returns total === count when the page holds every matching run (full page)', async () => {
    // Create exactly 4 runs — all fit in the default limit (50)
    for (let i = 0; i < 4; i++) {
      await config.runStore.create({ agentId: 'agent-1', input: `run-${i}` })
    }

    const res = await app.request('/api/runs')
    expect(res.status).toBe(200)

    const body = (await res.json()) as RunsListResponse
    expect(body.data.length).toBe(4)
    expect(body.count).toBe(4)
    expect(body.total).toBe(4)
  })

  it('restricts total to the filter predicate (filtered query)', async () => {
    // 3 runs for agent-1, 5 runs for agent-2 — total 8 runs in the store
    for (let i = 0; i < 3; i++) {
      await config.runStore.create({ agentId: 'agent-1', input: `a1-${i}` })
    }
    for (let i = 0; i < 5; i++) {
      await config.runStore.create({ agentId: 'agent-2', input: `a2-${i}` })
    }

    // Filter by agent-1 only — total must reflect the filter, not the whole store
    const res = await app.request('/api/runs?agentId=agent-1')
    expect(res.status).toBe(200)

    const body = (await res.json()) as RunsListResponse
    expect(body.data.length).toBe(3)
    expect(body.count).toBe(3)
    expect(body.total).toBe(3)
    // Sanity check: the filter actually selected the right runs
    for (const run of body.data) {
      expect(run.agentId).toBe('agent-1')
    }

    // And a filtered + paginated query still reports the full filtered total
    const paginated = await app.request('/api/runs?agentId=agent-2&limit=2')
    const paginatedBody = (await paginated.json()) as RunsListResponse
    expect(paginatedBody.data.length).toBe(2)
    expect(paginatedBody.count).toBe(2)
    expect(paginatedBody.total).toBe(5)
  })

  it('returns tenant-wide totals when auth is disabled', async () => {
    await config.runStore.create({ agentId: 'agent-1', input: 'owner-1', ownerId: 'key-1', tenantId: 'tenant-1' })
    await config.runStore.create({ agentId: 'agent-1', input: 'owner-2', ownerId: 'key-2', tenantId: 'tenant-1' })
    await config.runStore.create({ agentId: 'agent-1', input: 'other-tenant', ownerId: 'key-3', tenantId: 'tenant-2' })

    const res = await app.request('/api/runs')
    expect(res.status).toBe(200)

    const body = (await res.json()) as RunsListResponse
    expect(body.count).toBe(3)
    expect(body.total).toBe(3)
  })

  it('scopes total to the authenticated tenant before owner filtering', async () => {
    app = createForgeApp({
      ...config,
      auth: { mode: 'api-key' },
      apiKeyStore: makeApiKeyStore({ token: apiKeyRecord('key-1', 'tenant-1') }),
    })
    await config.runStore.create({ agentId: 'agent-1', input: 'visible', ownerId: 'key-1', tenantId: 'tenant-1' })
    await config.runStore.create({ agentId: 'agent-1', input: 'wrong-tenant', ownerId: 'key-1', tenantId: 'tenant-2' })

    const res = await app.request('/api/runs', {
      headers: { Authorization: 'Bearer token' },
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as RunsListResponse
    expect(body.data.map(run => run.tenantId)).toEqual(['tenant-1'])
    expect(body.count).toBe(1)
    expect(body.total).toBe(1)
  })

  it('scopes total to the authenticated owner while keeping legacy ownerless rows visible', async () => {
    app = createForgeApp({
      ...config,
      auth: { mode: 'api-key' },
      apiKeyStore: makeApiKeyStore({ token: apiKeyRecord('key-1', 'tenant-1') }),
    })
    await config.runStore.create({ agentId: 'agent-1', input: 'owned', ownerId: 'key-1', tenantId: 'tenant-1' })
    await config.runStore.create({ agentId: 'agent-1', input: 'other-owner', ownerId: 'key-2', tenantId: 'tenant-1' })
    await config.runStore.create({ agentId: 'agent-1', input: 'legacy', ownerId: null, tenantId: 'tenant-1' })

    const res = await app.request('/api/runs', {
      headers: { Authorization: 'Bearer token' },
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as RunsListResponse
    expect(body.data.map(run => run.ownerId ?? null).sort()).toEqual(['key-1', null].sort())
    expect(body.count).toBe(2)
    expect(body.total).toBe(2)
  })

  it('applies owner scope before pagination so totals and pages do not leak other owners', async () => {
    app = createForgeApp({
      ...config,
      auth: { mode: 'api-key' },
      apiKeyStore: makeApiKeyStore({ token: apiKeyRecord('key-1', 'tenant-1') }),
    })
    await config.runStore.create({ agentId: 'agent-1', input: 'visible-1', ownerId: 'key-1', tenantId: 'tenant-1' })
    await config.runStore.create({ agentId: 'agent-1', input: 'hidden', ownerId: 'key-2', tenantId: 'tenant-1' })
    await config.runStore.create({ agentId: 'agent-1', input: 'visible-2', ownerId: 'key-1', tenantId: 'tenant-1' })
    await config.runStore.create({ agentId: 'agent-1', input: 'legacy', ownerId: null, tenantId: 'tenant-1' })

    const res = await app.request('/api/runs?limit=2', {
      headers: { Authorization: 'Bearer token' },
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as RunsListResponse
    expect(body.data).toHaveLength(2)
    expect(body.count).toBe(2)
    expect(body.total).toBe(3)
    expect(body.data.every(run => !run.ownerId || run.ownerId === 'key-1')).toBe(true)
  })
})
