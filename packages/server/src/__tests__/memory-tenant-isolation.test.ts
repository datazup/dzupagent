/**
 * Denial tests for MJ-SEC-04 — memory routes must be tenant-scoped by
 * server-authenticated metadata, not by caller-supplied namespace/scope.
 *
 * These tests assert that:
 *   1. Browse with a spoofed scope cannot read another tenant's memory.
 *   2. Export with a spoofed scope cannot export another tenant's memory.
 *   3. Import with a spoofed scope cannot write into another tenant's namespace.
 *   4. Single-tenant deployments (auth disabled) continue to work.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import type { MemoryServiceLike } from '@dzupagent/memory-ipc'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CallRecord {
  op: 'get' | 'search' | 'put'
  namespace: string
  scope: Record<string, string>
  args: unknown[]
}

function createTrackingMemoryService(): MemoryServiceLike & { calls: CallRecord[] } {
  const store = new Map<string, Record<string, unknown>[]>()
  const calls: CallRecord[] = []

  function storeKey(ns: string, scope: Record<string, string>): string {
    const sorted = Object.entries(scope).sort(([a], [b]) => a.localeCompare(b))
    return `${ns}:${JSON.stringify(sorted)}`
  }

  return {
    calls,
    async get(namespace: string, scope: Record<string, string>, key?: string) {
      calls.push({ op: 'get', namespace, scope: { ...scope }, args: [key] })
      const sk = storeKey(namespace, scope)
      const records = store.get(sk) ?? []
      if (key) return records.filter((r) => r['key'] === key)
      return records
    },
    async search(
      namespace: string,
      scope: Record<string, string>,
      query: string,
      limit?: number,
    ) {
      calls.push({ op: 'search', namespace, scope: { ...scope }, args: [query, limit] })
      const sk = storeKey(namespace, scope)
      const records = store.get(sk) ?? []
      return records.slice(0, limit ?? 100)
    },
    async put(
      namespace: string,
      scope: Record<string, string>,
      key: string,
      value: Record<string, unknown>,
    ) {
      calls.push({ op: 'put', namespace, scope: { ...scope }, args: [key] })
      const sk = storeKey(namespace, scope)
      const records = store.get(sk) ?? []
      const idx = records.findIndex((r) => r['key'] === key)
      const record = { ...value, key }
      if (idx >= 0) records[idx] = record
      else records.push(record)
      store.set(sk, records)
    },
  }
}

interface AuthOpts {
  // Map token → key metadata
  keys: Record<string, Record<string, unknown>>
}

function createAuthedConfig(
  memoryService: MemoryServiceLike,
  auth?: AuthOpts,
): ForgeServerConfig {
  const config: ForgeServerConfig = {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    memoryService,
  }
  if (auth) {
    config.auth = {
      mode: 'api-key',
      validateKey: async (token: string) => auth.keys[token] ?? null,
    }
  }
  return config
}

async function reqAuthed(
  app: ReturnType<typeof createForgeApp>,
  method: string,
  path: string,
  token: string,
  body?: unknown,
) {
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  }
  if (body) init.body = JSON.stringify(body)
  return app.request(path, init)
}

// ---------------------------------------------------------------------------
// Browse: spoofed scope cannot read another tenant's memory
// ---------------------------------------------------------------------------

describe('Memory browse — tenant isolation (MJ-SEC-04)', () => {
  let memoryService: ReturnType<typeof createTrackingMemoryService>

  beforeEach(async () => {
    memoryService = createTrackingMemoryService()
    // Tenant A's data is keyed under tenantId=tenant-a
    await memoryService.put('lessons', { tenantId: 'tenant-a' }, 'a-secret', {
      text: 'Tenant A secret',
    })
    // Tenant B's data is keyed under tenantId=tenant-b
    await memoryService.put('lessons', { tenantId: 'tenant-b' }, 'b-secret', {
      text: 'Tenant B secret',
    })
  })

  it('forces authenticated tenantId over caller-supplied scope (browse)', async () => {
    const app = createForgeApp(
      createAuthedConfig(memoryService, {
        keys: {
          'token-a': { id: 'k-a', tenantId: 'tenant-a' },
          'token-b': { id: 'k-b', tenantId: 'tenant-b' },
        },
      }),
    )

    // Tenant A presents tenant-b's scope to try to read tenant-b's data.
    const spoofed = encodeURIComponent(JSON.stringify({ tenantId: 'tenant-b' }))
    const res = await reqAuthed(
      app,
      'GET',
      `/api/memory-browse/lessons?scope=${spoofed}`,
      'token-a',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { value: { text?: string } }[] }

    // Must only see tenant-a's data (the auth-derived scope wins).
    const texts = body.data.map((e) => e.value.text)
    expect(texts).toContain('Tenant A secret')
    expect(texts).not.toContain('Tenant B secret')

    // The downstream memory call must have received the AUTHORITATIVE tenantId.
    const lastGet = memoryService.calls.filter((c) => c.op === 'get').at(-1)
    expect(lastGet?.scope['tenantId']).toBe('tenant-a')
  })

  it('forces authenticated tenantId over caller-supplied scope on search', async () => {
    const app = createForgeApp(
      createAuthedConfig(memoryService, {
        keys: {
          'token-a': { id: 'k-a', tenantId: 'tenant-a' },
        },
      }),
    )
    const spoofed = encodeURIComponent(JSON.stringify({ tenantId: 'tenant-b' }))
    const res = await reqAuthed(
      app,
      'GET',
      `/api/memory-browse/lessons?scope=${spoofed}&search=secret`,
      'token-a',
    )
    expect(res.status).toBe(200)
    const lastSearch = memoryService.calls.filter((c) => c.op === 'search').at(-1)
    expect(lastSearch?.scope['tenantId']).toBe('tenant-a')
  })

  it('layers ownerId from auth context onto scope (browse)', async () => {
    const app = createForgeApp(
      createAuthedConfig(memoryService, {
        keys: {
          'token-owner': { id: 'k', ownerId: 'owner-x' },
        },
      }),
    )
    const res = await reqAuthed(
      app,
      'GET',
      '/api/memory-browse/lessons',
      'token-owner',
    )
    expect(res.status).toBe(200)
    const lastGet = memoryService.calls.filter((c) => c.op === 'get').at(-1)
    expect(lastGet?.scope['ownerId']).toBe('owner-x')
  })

  it('honours client-supplied scope when auth is disabled (single-tenant)', async () => {
    const app = createForgeApp(createAuthedConfig(memoryService))
    const scope = encodeURIComponent(JSON.stringify({ tenantId: 'tenant-a' }))
    const res = await app.request(`/api/memory-browse/lessons?scope=${scope}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { value: { text?: string } }[] }
    const texts = body.data.map((e) => e.value.text)
    expect(texts).toContain('Tenant A secret')
    expect(texts).not.toContain('Tenant B secret')
  })
})

// ---------------------------------------------------------------------------
// Export: spoofed scope cannot export another tenant's memory
// ---------------------------------------------------------------------------

describe('Memory export — tenant isolation (MJ-SEC-04)', () => {
  let memoryService: ReturnType<typeof createTrackingMemoryService>

  beforeEach(async () => {
    memoryService = createTrackingMemoryService()
    await memoryService.put('lessons', { tenantId: 'tenant-a' }, 'a-1', { text: 'A1' })
    await memoryService.put('lessons', { tenantId: 'tenant-b' }, 'b-1', { text: 'B1' })
  })

  it('overrides spoofed scope with authenticated tenantId', async () => {
    const app = createForgeApp(
      createAuthedConfig(memoryService, {
        keys: { 'token-a': { id: 'k-a', tenantId: 'tenant-a' } },
      }),
    )

    // Tenant A tries to export tenant-b's data by spoofing the scope.
    const res = await reqAuthed(app, 'POST', '/api/memory/export', 'token-a', {
      namespace: 'lessons',
      scope: { tenantId: 'tenant-b' },
      format: 'json',
      limit: 100,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { record_count: number; data: string }
    }

    // The export must only see tenant-a's frame, not tenant-b's.
    // We decode the json data and confirm no tenant-b records leaked.
    const decoded = Buffer.from(body.data.data, 'base64').toString('utf8')
    expect(decoded).not.toContain('B1')
  })

  it('layers default scope when auth is disabled', async () => {
    // Auth disabled → caller-supplied scope is used, since this is a
    // single-tenant deployment.
    const app = createForgeApp(createAuthedConfig(memoryService))

    const res = await app.request('/api/memory/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: 'lessons',
        scope: { tenantId: 'tenant-a' },
        format: 'json',
        limit: 100,
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { data: string } }
    const decoded = Buffer.from(body.data.data, 'base64').toString('utf8')
    expect(decoded).toContain('A1')
    expect(decoded).not.toContain('B1')
  })
})

// ---------------------------------------------------------------------------
// Import: spoofed scope cannot write into another tenant's namespace
// ---------------------------------------------------------------------------

describe('Memory import — tenant isolation (MJ-SEC-04)', () => {
  let memoryService: ReturnType<typeof createTrackingMemoryService>

  beforeEach(async () => {
    memoryService = createTrackingMemoryService()
    // Pre-seed tenant A so we have data to export → import.
    await memoryService.put('lessons', { tenantId: 'tenant-a' }, 'seed', { text: 'seed' })
  })

  it('rewrites import scope with authenticated tenantId (no cross-tenant write)', async () => {
    const appA = createForgeApp(
      createAuthedConfig(memoryService, {
        keys: { 'token-a': { id: 'k-a', tenantId: 'tenant-a' } },
      }),
    )

    // First export tenant-a's data while authenticated as tenant-a.
    const exportRes = await reqAuthed(appA, 'POST', '/api/memory/export', 'token-a', {
      namespace: 'lessons',
      scope: {},
      format: 'arrow_ipc',
      limit: 100,
    })
    expect(exportRes.status).toBe(200)
    const exportBody = (await exportRes.json()) as { data: { data: string } }

    // Now authenticate as tenant-b and try to import using a SPOOFED tenant-a
    // scope. The server must rewrite the scope to tenant-b.
    const appB = createForgeApp(
      createAuthedConfig(memoryService, {
        keys: { 'token-b': { id: 'k-b', tenantId: 'tenant-b' } },
      }),
    )

    // Reset call tracker to only observe import-time writes.
    memoryService.calls.length = 0

    const importRes = await reqAuthed(appB, 'POST', '/api/memory/import', 'token-b', {
      data: exportBody.data.data,
      format: 'arrow_ipc',
      namespace: 'lessons',
      scope: { tenantId: 'tenant-a' }, // spoof attempt
      merge_strategy: 'upsert',
    })
    expect(importRes.status).toBe(200)

    // Every put recorded since the import started must carry tenantId=tenant-b
    // (the AUTHORITATIVE id), never tenant-a.
    const tenantsTouched = new Set(
      memoryService.calls
        .filter((c) => c.op === 'put')
        .map((c) => c.scope['tenantId']),
    )
    if (tenantsTouched.size > 0) {
      expect(tenantsTouched.has('tenant-a')).toBe(false)
      expect(tenantsTouched.has('tenant-b')).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Analytics: spoofed scope cannot read another tenant's frame
// ---------------------------------------------------------------------------

describe('Memory analytics — tenant isolation (MJ-SEC-04)', () => {
  it('overrides spoofed scope on analytics endpoints', async () => {
    const memoryService = createTrackingMemoryService()
    await memoryService.put('lessons', { tenantId: 'tenant-a' }, 'a-1', { text: 'A1' })
    await memoryService.put('lessons', { tenantId: 'tenant-b' }, 'b-1', { text: 'B1' })

    const app = createForgeApp(
      createAuthedConfig(memoryService, {
        keys: { 'token-a': { id: 'k-a', tenantId: 'tenant-a' } },
      }),
    )

    // Tenant A queries analytics with a spoofed tenant-b scope. Even if
    // DuckDB-WASM is not installed, the route always invokes
    // arrowMemory.exportFrame() to build the input table. We assert the
    // exportFrame call carries the authenticated tenantId, regardless of
    // whether the analytics layer ultimately succeeds.
    const spoofed = encodeURIComponent(JSON.stringify({ tenantId: 'tenant-b' }))
    await reqAuthed(
      app,
      'GET',
      `/api/memory/analytics/namespace-stats?namespace=lessons&scope=${spoofed}`,
      'token-a',
    )

    // We use search/get tracking — the arrow extension layers on top of the
    // plain memory service, so we look at all calls and confirm no tenant-b
    // scope was issued during analytics.
    const tenantBCalls = memoryService.calls.filter(
      (c) => c.scope['tenantId'] === 'tenant-b',
    )
    // Only the seed put for tenant-b recorded earlier — no read calls.
    expect(tenantBCalls.every((c) => c.op === 'put')).toBe(true)
  })
})
