import { describe, it, expect, vi } from 'vitest'
import { createForgeApp } from '../app.js'
import { InMemoryRunStore, InMemoryAgentStore, ModelRegistry, createEventBus } from '@dzupagent/core'
import type { PostgresApiKeyStore, ApiKeyRecord } from '../persistence/api-key-store.js'

interface MockStoreOptions {
  validKey: string
  ownerId?: string
  listSpy?: ReturnType<typeof vi.fn>
}

function makeMockStore(options: MockStoreOptions): PostgresApiKeyStore {
  const record: ApiKeyRecord = {
    id: 'key-1',
    ownerId: options.ownerId ?? 'user-1',
    name: 'test',
    role: 'operator',
    rateLimitTier: 'standard',
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    metadata: {},
  }
  return {
    validate: async (key: string) => (key === options.validKey ? record : null),
    create: async () => { throw new Error('not implemented') },
    revoke: async () => {},
    list: options.listSpy ?? (async () => []),
    get: async () => null,
  } as unknown as PostgresApiKeyStore
}

function createTestApp(validateKey?: string) {
  return createForgeApp({
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    auth: { mode: 'api-key' },
    apiKeyStore: makeMockStore({ validKey: validateKey ?? 'valid-key' }),
  })
}

describe('API key auth wiring', () => {
  it('GET /api/health bypasses auth', async () => {
    const app = createTestApp()
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
  })

  it('GET /api/runs without token returns 401', async () => {
    const app = createTestApp()
    const res = await app.request('/api/runs')
    expect(res.status).toBe(401)
  })

  it('GET /api/runs with valid Bearer token returns 200', async () => {
    const app = createTestApp('my-secret-key')
    const res = await app.request('/api/runs', {
      headers: { Authorization: 'Bearer my-secret-key' },
    })
    expect(res.status).toBe(200)
  })

  it('GET /api/runs with invalid Bearer token returns 401', async () => {
    const app = createTestApp('my-secret-key')
    const res = await app.request('/api/runs', {
      headers: { Authorization: 'Bearer wrong-key' },
    })
    expect(res.status).toBe(401)
  })

  it('/api/keys route is mounted when apiKeyStore is provided', async () => {
    const app = createTestApp('k')
    // POST without auth → 401 (route is there, auth middleware fires first)
    const res = await app.request('/api/keys', { method: 'GET' })
    expect(res.status).toBe(401)
  })

  it('GET /api/keys with valid Bearer token scopes list by apiKey.ownerId', async () => {
    // Arrange — a list() spy so we can assert the owner scoping.
    const listSpy = vi.fn(async () => [] as ApiKeyRecord[])
    const store = makeMockStore({
      validKey: 'token-abc',
      ownerId: 'user-42',
      listSpy,
    })
    const app = createForgeApp({
      runStore: new InMemoryRunStore(),
      agentStore: new InMemoryAgentStore(),
      eventBus: createEventBus(),
      modelRegistry: new ModelRegistry(),
      auth: { mode: 'api-key' },
      apiKeyStore: store,
    })

    // Act
    const res = await app.request('/api/keys', {
      headers: { Authorization: 'Bearer token-abc' },
    })

    // Assert — route is reachable (200, not 401), and owner was resolved
    // from the authenticated apiKey record (not 'anonymous').
    expect(res.status).toBe(200)
    const body = (await res.json()) as { keys: unknown[] }
    expect(body.keys).toEqual([])
    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(listSpy).toHaveBeenCalledWith('user-42')
  })
})
