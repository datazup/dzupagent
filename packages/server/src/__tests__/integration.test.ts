/**
 * End-to-end integration test for @dzupagent/server.
 *
 * Boots a minimal createForgeApp() with InMemoryRunStore + a mock API key
 * store and exercises the full request lifecycle via Hono's app.request().
 * No real HTTP socket — the Hono fetch handler is invoked in-process.
 *
 * Scenarios:
 *   1. POST /api/keys              — create an API key (authenticated via seed key)
 *   2. POST /api/runs (Bearer key) — create a run using the freshly-issued key
 *   3. GET  /api/runs/:id          — fetch the run
 *   4. GET  /api/runs/:id/logs     — fetch run logs
 *   5. GET  /api/runs (no auth)    — verify auth is enforced (401)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createForgeApp } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import type {
  PostgresApiKeyStore,
  ApiKeyRecord,
  CreateApiKeyResult,
} from '../persistence/api-key-store.js'

/**
 * In-memory stand-in for {@link PostgresApiKeyStore} used by the integration
 * test. Implements the shape of the methods the server actually calls. The
 * test casts it to PostgresApiKeyStore at the assignment site because the
 * app.ts wiring is typed against the concrete class.
 */
class InMemoryApiKeyStore {
  private readonly keys = new Map<string, ApiKeyRecord & { rawKey: string }>()

  async create(
    ownerId: string,
    name: string,
    tier: string = 'standard',
  ): Promise<CreateApiKeyResult> {
    const id = `key-${Math.random().toString(36).slice(2)}`
    const rawKey = `raw-${Math.random().toString(36).slice(2)}`
    const record: ApiKeyRecord = {
      id,
      ownerId,
      name,
      role: 'operator',
      rateLimitTier: tier,
      createdAt: new Date(),
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      metadata: {},
    }
    this.keys.set(rawKey, { ...record, rawKey })
    return { key: rawKey, record }
  }

  async validate(rawKey: string): Promise<ApiKeyRecord | null> {
    const entry = this.keys.get(rawKey)
    if (!entry) return null
    if (entry.revokedAt) return null
    if (entry.expiresAt && entry.expiresAt.getTime() <= Date.now()) return null
    const { rawKey: _raw, ...record } = entry
    return record
  }

  async revoke(id: string): Promise<void> {
    for (const [key, entry] of this.keys) {
      if (entry.id === id) {
        this.keys.set(key, { ...entry, revokedAt: new Date() })
        return
      }
    }
  }

  async list(ownerId: string): Promise<ApiKeyRecord[]> {
    return [...this.keys.values()]
      .filter((entry) => entry.ownerId === ownerId)
      .map(({ rawKey: _raw, ...record }) => record)
  }

  async get(id: string): Promise<ApiKeyRecord | null> {
    for (const entry of this.keys.values()) {
      if (entry.id === id) {
        const { rawKey: _raw, ...record } = entry
        return record
      }
    }
    return null
  }

  /** Test helper: seed a key directly so the first HTTP request can authenticate. */
  async seed(ownerId: string, name: string): Promise<string> {
    const { key } = await this.create(ownerId, name)
    return key
  }
}

interface AppHarness {
  app: ReturnType<typeof createForgeApp>
  keyStore: InMemoryApiKeyStore
  runStore: InMemoryRunStore
  agentStore: InMemoryAgentStore
}

function makeApp(): AppHarness {
  const keyStore = new InMemoryApiKeyStore()
  const runStore = new InMemoryRunStore()
  const agentStore = new InMemoryAgentStore()

  const app = createForgeApp({
    runStore,
    agentStore,
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    auth: { mode: 'api-key' },
    apiKeyStore: keyStore as unknown as PostgresApiKeyStore,
  })

  return { app, keyStore, runStore, agentStore }
}

async function authedReq(
  app: ReturnType<typeof createForgeApp>,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
  }
  return app.request(path, init)
}

describe('Integration: full request lifecycle', () => {
  let harness: AppHarness
  let seedKey: string

  beforeEach(async () => {
    harness = makeApp()

    // Seed a key directly into the mock store so the first /api/keys call
    // can authenticate. In a real deployment the "first key" is created
    // out-of-band (seed script, admin CLI, etc.).
    seedKey = await harness.keyStore.seed('owner-1', 'seed')

    // Seed an agent so POST /api/runs has something to target. We go
    // through the store directly rather than the HTTP API to keep each
    // test focused on exactly one lifecycle segment.
    await harness.agentStore.save({
      id: 'agent-int-1',
      name: 'Integration Agent',
      instructions: 'You are an integration test agent',
      modelTier: 'chat',
    })
  })

  it('1. POST /api/keys issues a new API key', async () => {
    const res = await authedReq(harness.app, 'POST', '/api/keys', seedKey, {
      name: 'test-key',
      tier: 'standard',
    })

    expect(res.status).toBe(201)
    const body = await res.json() as {
      key: string
      id: string
      name: string
      tier: string
    }
    expect(body.key).toBeTruthy()
    expect(body.key.startsWith('raw-')).toBe(true)
    expect(body.id.startsWith('key-')).toBe(true)
    expect(body.name).toBe('test-key')
    expect(body.tier).toBe('standard')
  })

  it('2. POST /api/runs with a freshly-issued key returns 201', async () => {
    // Issue a new key via the HTTP API.
    const keyRes = await authedReq(harness.app, 'POST', '/api/keys', seedKey, {
      name: 'run-key',
    })
    expect(keyRes.status).toBe(201)
    const { key: rawKey } = await keyRes.json() as { key: string }

    // Use it to create a run.
    const runRes = await authedReq(harness.app, 'POST', '/api/runs', rawKey, {
      agentId: 'agent-int-1',
      input: { task: 'integration-test' },
    })
    expect(runRes.status).toBe(201)
    const runBody = await runRes.json() as {
      data: { id: string; status: string; agentId: string }
    }
    expect(runBody.data.id).toBeTruthy()
    expect(runBody.data.status).toBe('queued')
    expect(runBody.data.agentId).toBe('agent-int-1')
  })

  it('3. GET /api/runs/:id returns the run with correct status', async () => {
    // Issue a key + create a run.
    const keyRes = await authedReq(harness.app, 'POST', '/api/keys', seedKey, {
      name: 'get-run-key',
    })
    const { key: rawKey } = await keyRes.json() as { key: string }

    const createRes = await authedReq(harness.app, 'POST', '/api/runs', rawKey, {
      agentId: 'agent-int-1',
      input: { task: 'fetch-me' },
    })
    const { data: created } = await createRes.json() as { data: { id: string } }

    // Fetch it back.
    const getRes = await authedReq(harness.app, 'GET', `/api/runs/${created.id}`, rawKey)
    expect(getRes.status).toBe(200)
    const getBody = await getRes.json() as {
      data: { id: string; status: string; agentId: string; input: unknown }
    }
    expect(getBody.data.id).toBe(created.id)
    expect(getBody.data.status).toBe('queued')
    expect(getBody.data.agentId).toBe('agent-int-1')
    expect(getBody.data.input).toEqual({ task: 'fetch-me' })
  })

  it('4. GET /api/runs/:id/logs returns the logs array', async () => {
    // Create a run via HTTP.
    const keyRes = await authedReq(harness.app, 'POST', '/api/keys', seedKey, {
      name: 'logs-key',
    })
    const { key: rawKey } = await keyRes.json() as { key: string }

    const createRes = await authedReq(harness.app, 'POST', '/api/runs', rawKey, {
      agentId: 'agent-int-1',
      input: { task: 'with-logs' },
    })
    const { data: created } = await createRes.json() as { data: { id: string } }

    // Seed a log entry via the store so the endpoint has something to return.
    await harness.runStore.addLog(created.id, {
      level: 'info',
      phase: 'test',
      message: 'hello from integration test',
    })

    const logsRes = await authedReq(harness.app, 'GET', `/api/runs/${created.id}/logs`, rawKey)
    expect(logsRes.status).toBe(200)
    const logsBody = await logsRes.json() as {
      data: Array<{ level: string; message: string; phase?: string }>
    }
    expect(Array.isArray(logsBody.data)).toBe(true)
    expect(logsBody.data.length).toBeGreaterThanOrEqual(1)
    const seeded = logsBody.data.find((entry) => entry.message === 'hello from integration test')
    expect(seeded).toBeTruthy()
    expect(seeded?.level).toBe('info')
    expect(seeded?.phase).toBe('test')
  })

  it('5. GET /api/runs without Authorization header returns 401', async () => {
    const res = await harness.app.request('/api/runs', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('5b. GET /api/runs with an invalid Bearer key returns 401', async () => {
    const res = await authedReq(harness.app, 'GET', '/api/runs', 'raw-not-a-real-key')
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })
})
