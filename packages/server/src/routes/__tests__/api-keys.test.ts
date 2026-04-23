/**
 * Route tests for the API key management router.
 *
 * Uses a faked PostgresApiKeyStore (via prototype method replacement with
 * vi.fn()) so we can drive the router end-to-end without a real Postgres.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { Hono } from 'hono'
import { createApiKeyRoutes } from '../api-keys.js'
import {
  PostgresApiKeyStore,
  type ApiKeyRecord,
  type CreateApiKeyResult,
} from '../../persistence/api-key-store.js'

function buildRecord(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'key-uuid-1',
    ownerId: 'owner-1',
    name: 'my-key',
    rateLimitTier: 'standard',
    createdAt: new Date('2026-04-20T00:00:00Z'),
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    metadata: {},
    ...overrides,
  }
}

function buildStore(): PostgresApiKeyStore {
  // Instantiate with a dummy db — we replace the instance methods below.
  const store = new PostgresApiKeyStore({} as never)
  store.create = vi.fn() as unknown as typeof store.create
  store.list = vi.fn() as unknown as typeof store.list
  store.revoke = vi.fn() as unknown as typeof store.revoke
  store.get = vi.fn() as unknown as typeof store.get
  store.validate = vi.fn() as unknown as typeof store.validate
  return store
}

function buildApp(store: PostgresApiKeyStore): Hono {
  const app = new Hono()
  app.route('/api/keys', createApiKeyRoutes({ store }))
  return app
}

describe('API key routes', () => {
  let store: PostgresApiKeyStore
  let app: Hono

  beforeEach(() => {
    store = buildStore()
    app = buildApp(store)
  })

  it('POST /api/keys returns 201 with the raw key and metadata', async () => {
    const rawKey = 'd'.repeat(64)
    const record = buildRecord({ name: 'my-key', rateLimitTier: 'premium' })
    const result: CreateApiKeyResult = { key: rawKey, record }
    ;(store.create as ReturnType<typeof vi.fn>).mockResolvedValue(result)

    const res = await app.request('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'my-key', tier: 'premium' }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['key']).toBe(rawKey)
    expect(body['id']).toBe(record.id)
    expect(body['name']).toBe('my-key')
    expect(body['tier']).toBe('premium')
    expect(body['createdAt']).toBeDefined()
    // Hash never escapes to the wire.
    expect(body['keyHash']).toBeUndefined()

    expect(store.create).toHaveBeenCalledWith('anonymous', 'my-key', 'premium', { expiresIn: undefined })
  })

  it('POST /api/keys rejects missing name with 400', async () => {
    const res = await app.request('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'premium' }),
    })

    expect(res.status).toBe(400)
    expect(store.create).not.toHaveBeenCalled()
  })

  it('GET /api/keys returns 200 with an array of records (no hash)', async () => {
    const records = [
      buildRecord({ id: 'k1', name: 'first' }),
      buildRecord({ id: 'k2', name: 'second' }),
    ]
    ;(store.list as ReturnType<typeof vi.fn>).mockResolvedValue(records)

    const res = await app.request('/api/keys')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> }
    expect(body.keys).toHaveLength(2)
    expect(body.keys[0]!['id']).toBe('k1')
    expect(body.keys[0]!['keyHash']).toBeUndefined()
    expect(body.keys[1]!['id']).toBe('k2')
    expect(store.list).toHaveBeenCalledWith('anonymous')
  })

  it('DELETE /api/keys/:id returns 204 when the key exists', async () => {
    ;(store.get as ReturnType<typeof vi.fn>).mockResolvedValue(buildRecord({ id: 'k1' }))
    ;(store.revoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

    const res = await app.request('/api/keys/k1', { method: 'DELETE' })

    expect(res.status).toBe(204)
    expect(store.revoke).toHaveBeenCalledWith('k1')
  })

  it('DELETE /api/keys/:id returns 404 when the key is unknown', async () => {
    ;(store.get as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    const res = await app.request('/api/keys/missing', { method: 'DELETE' })

    expect(res.status).toBe(404)
    expect(store.revoke).not.toHaveBeenCalled()
  })

  it('uses the authenticated identity id as ownerId when present', async () => {
    const rawKey = 'e'.repeat(64)
    const record = buildRecord({ ownerId: 'user-42' })
    ;(store.create as ReturnType<typeof vi.fn>).mockResolvedValue({ key: rawKey, record })

    const scopedApp = new Hono()
    scopedApp.use('*', async (c, next) => {
      c.set('identity' as never, { id: 'user-42' } as never)
      return next()
    })
    scopedApp.route('/api/keys', createApiKeyRoutes({ store }))

    const res = await scopedApp.request('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'scoped' }),
    })

    expect(res.status).toBe(201)
    expect(store.create).toHaveBeenCalledWith('user-42', 'scoped', 'standard', { expiresIn: undefined })
  })
})

// --- Option L: allowedTiers validation ---
describe('API key routes — allowedTiers validation', () => {
  it('accepts a tier that is in the allowedTiers list', async () => {
    const store = buildStore()
    const rawKey = 'f'.repeat(64)
    const record = buildRecord({ rateLimitTier: 'premium' })
    ;(store.create as Mock).mockResolvedValue({ key: rawKey, record })

    const app = new Hono()
    app.route('/api/keys', createApiKeyRoutes({ store, allowedTiers: ['standard', 'premium'] }))

    const res = await app.request('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'k', tier: 'premium' }),
    })

    expect(res.status).toBe(201)
    expect(store.create).toHaveBeenCalledOnce()
  })

  it('rejects a tier not in allowedTiers with 400', async () => {
    const store = buildStore()
    const app = new Hono()
    app.route('/api/keys', createApiKeyRoutes({ store, allowedTiers: ['standard'] }))

    const res = await app.request('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'k', tier: 'ultra' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain('"ultra"')
    expect(store.create).not.toHaveBeenCalled()
  })

  it('defaults to "standard" tier and validates it against allowedTiers', async () => {
    const store = buildStore()
    const rawKey = 'g'.repeat(64)
    const record = buildRecord()
    ;(store.create as Mock).mockResolvedValue({ key: rawKey, record })

    const app = new Hono()
    app.route('/api/keys', createApiKeyRoutes({ store, allowedTiers: ['standard', 'premium'] }))

    const res = await app.request('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'k' }),
    })

    expect(res.status).toBe(201)
    expect(store.create).toHaveBeenCalledWith('anonymous', 'k', 'standard', { expiresIn: undefined })
  })
})

// --- Option M: expiresIn and rotate endpoint ---
describe('API key routes — expiresIn and rotate', () => {
  it('POST /api/keys with expiresIn passes it through to store.create', async () => {
    const store = buildStore()
    const rawKey = 'h'.repeat(64)
    const expiresAt = new Date(Date.now() + 3600 * 1000)
    const record = buildRecord({ expiresAt })
    ;(store.create as Mock).mockResolvedValue({ key: rawKey, record })

    const app = buildApp(store)
    const res = await app.request('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'expiring', expiresIn: 3600 }),
    })

    expect(res.status).toBe(201)
    expect(store.create).toHaveBeenCalledWith('anonymous', 'expiring', 'standard', { expiresIn: 3600 })
    const body = (await res.json()) as { expiresAt: string }
    expect(body.expiresAt).toBeDefined()
  })

  it('POST /api/keys/:id/rotate returns 404 for unknown key', async () => {
    const store = buildStore()
    ;(store.get as Mock).mockResolvedValue(null)

    const app = buildApp(store)
    const res = await app.request('/api/keys/bad-id/rotate', { method: 'POST' })

    expect(res.status).toBe(404)
  })

  it('POST /api/keys/:id/rotate returns 400 for an already-revoked key', async () => {
    const store = buildStore()
    ;(store.get as Mock).mockResolvedValue(buildRecord({ revokedAt: new Date() }))

    const app = buildApp(store)
    const res = await app.request('/api/keys/key-uuid-1/rotate', { method: 'POST' })

    expect(res.status).toBe(400)
    expect(store.revoke).not.toHaveBeenCalled()
  })

  it('POST /api/keys/:id/rotate atomically revokes old key and creates a new one', async () => {
    const store = buildStore()
    const existing = buildRecord({ id: 'old-id', name: 'my-key', rateLimitTier: 'premium' })
    ;(store.get as Mock).mockResolvedValue(existing)
    ;(store.revoke as Mock).mockResolvedValue(undefined)
    const newRawKey = 'i'.repeat(64)
    const newRecord = buildRecord({ id: 'new-id', name: 'my-key', rateLimitTier: 'premium' })
    ;(store.create as Mock).mockResolvedValue({ key: newRawKey, record: newRecord })

    const app = buildApp(store)
    const res = await app.request('/api/keys/old-id/rotate', { method: 'POST' })

    expect(res.status).toBe(201)
    expect(store.revoke).toHaveBeenCalledWith('old-id')
    expect(store.create).toHaveBeenCalledWith('owner-1', 'my-key', 'premium', {
      expiresIn: undefined,
      metadata: {},
    })
    const body = (await res.json()) as { key: string; id: string }
    expect(body.key).toBe(newRawKey)
    expect(body.id).toBe('new-id')
  })

  it('POST /api/keys/:id/rotate forwards expiresIn to the new key', async () => {
    const store = buildStore()
    const existing = buildRecord()
    ;(store.get as Mock).mockResolvedValue(existing)
    ;(store.revoke as Mock).mockResolvedValue(undefined)
    const newRecord = buildRecord({ id: 'new-2' })
    ;(store.create as Mock).mockResolvedValue({ key: 'j'.repeat(64), record: newRecord })

    const app = buildApp(store)
    const res = await app.request('/api/keys/key-uuid-1/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 86400 }),
    })

    expect(res.status).toBe(201)
    expect(store.create).toHaveBeenCalledWith('owner-1', 'my-key', 'standard', {
      expiresIn: 86400,
      metadata: {},
    })
  })
})

// --- Option N: DzupEventBus audit events from PostgresApiKeyStore ---
describe('PostgresApiKeyStore — event bus audit trail', () => {
  function buildMockBus() {
    return { emit: vi.fn(), on: vi.fn(), once: vi.fn(), onAny: vi.fn() }
  }

  it('emits api-key:created on create()', async () => {
    const bus = buildMockBus()
    const store = new PostgresApiKeyStore({
      insert: () => ({
        values: () => ({
          returning: async () => [
            {
              id: 'k1',
              ownerId: 'user-1',
              name: 'test',
              rateLimitTier: 'standard',
              keyHash: 'hash',
              createdAt: new Date(),
              expiresAt: null,
              revokedAt: null,
              lastUsedAt: null,
              metadata: {},
            },
          ],
        }),
      }),
    } as never, bus as never)

    await store.create('user-1', 'test', 'standard')

    expect(bus.emit).toHaveBeenCalledWith({
      type: 'api-key:created',
      id: 'k1',
      ownerId: 'user-1',
      tier: 'standard',
    })
  })

  it('emits api-key:revoked only when a row is actually revoked', async () => {
    const bus = buildMockBus()
    const revokedRow = { id: 'k2', ownerId: 'user-2' }
    const store = new PostgresApiKeyStore({
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [revokedRow],
          }),
        }),
      }),
    } as never, bus as never)

    await store.revoke('k2')

    expect(bus.emit).toHaveBeenCalledWith({
      type: 'api-key:revoked',
      id: 'k2',
      ownerId: 'user-2',
    })
  })

  it('does NOT emit api-key:revoked when the key was already revoked (idempotent)', async () => {
    const bus = buildMockBus()
    const store = new PostgresApiKeyStore({
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
    } as never, bus as never)

    await store.revoke('k-already')

    expect(bus.emit).not.toHaveBeenCalled()
  })

  it('emits api-key:validated on successful validate()', async () => {
    const bus = buildMockBus()
    const now = new Date()
    const row = {
      id: 'k3',
      ownerId: 'user-3',
      name: 'v',
      rateLimitTier: 'premium',
      keyHash: 'hash',
      createdAt: now,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      metadata: {},
    }
    const store = new PostgresApiKeyStore({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [row],
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => undefined,
        }),
      }),
    } as never, bus as never)

    await store.validate('raw-key')

    expect(bus.emit).toHaveBeenCalledWith({
      type: 'api-key:validated',
      id: 'k3',
      ownerId: 'user-3',
      tier: 'premium',
    })
  })

  it('does NOT emit api-key:validated when the key is not found', async () => {
    const bus = buildMockBus()
    const store = new PostgresApiKeyStore({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    } as never, bus as never)

    const result = await store.validate('unknown-key')

    expect(result).toBeNull()
    expect(bus.emit).not.toHaveBeenCalled()
  })
})
