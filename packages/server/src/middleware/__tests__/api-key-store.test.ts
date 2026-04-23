/**
 * Unit tests for PostgresApiKeyStore.
 *
 * These tests mock the Drizzle DB entirely — they exercise store logic
 * (hashing, revoke/expiry checks, return-type shape) without touching
 * Postgres.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import {
  PostgresApiKeyStore,
  hashApiKey,
  type ApiKeyRecord,
} from '../../persistence/api-key-store.js'
import type { apiKeys } from '../../persistence/drizzle-schema.js'

/**
 * Build a chainable mock around the minimal fluent API we use:
 *   insert().values().returning()
 *   select().from().where().limit()
 *   select().from().where().orderBy()
 *   update().set().where()
 */
interface MockDB {
  insert: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
}

function rowFromRecord(
  record: Partial<typeof apiKeys.$inferSelect> & {
    id?: string
    keyHash?: string
    ownerId?: string
    rateLimitTier?: string
  },
): typeof apiKeys.$inferSelect {
  return {
    id: record.id ?? 'key-uuid-1',
    keyHash: record.keyHash ?? 'hash-placeholder',
    ownerId: record.ownerId ?? 'owner-1',
    name: record.name ?? 'test-key',
    rateLimitTier: record.rateLimitTier ?? 'standard',
    createdAt: record.createdAt ?? new Date('2026-04-20T00:00:00Z'),
    expiresAt: record.expiresAt ?? null,
    revokedAt: record.revokedAt ?? null,
    lastUsedAt: record.lastUsedAt ?? null,
    metadata: record.metadata ?? {},
  } as typeof apiKeys.$inferSelect
}

/** Helper: build a DB whose `select().from().where().limit()` resolves to rows. */
function mockSelect(rows: Array<typeof apiKeys.$inferSelect>): ReturnType<typeof vi.fn> {
  const chain = {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
        orderBy: vi.fn().mockResolvedValue(rows),
      }),
    }),
  }
  return vi.fn().mockReturnValue(chain)
}

function mockInsert(returnedRows: Array<typeof apiKeys.$inferSelect>): ReturnType<typeof vi.fn> {
  const chain = {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(returnedRows),
    }),
  }
  return vi.fn().mockReturnValue(chain)
}

function mockUpdate(updatedValuesCapture: { value?: Record<string, unknown> }): ReturnType<typeof vi.fn> {
  const chain = {
    set: vi.fn((values: Record<string, unknown>) => {
      updatedValuesCapture.value = values
      return {
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }
    }),
  }
  return vi.fn().mockReturnValue(chain)
}

function buildDb(overrides: Partial<MockDB>): PostgresJsDatabase<Record<string, never>> {
  return {
    insert: overrides.insert ?? vi.fn(),
    select: overrides.select ?? vi.fn(),
    update: overrides.update ?? vi.fn(),
    delete: overrides.delete ?? vi.fn(),
  } as unknown as PostgresJsDatabase<Record<string, never>>
}

describe('PostgresApiKeyStore', () => {
  let updateCapture: { value?: Record<string, unknown> }

  beforeEach(() => {
    updateCapture = {}
  })

  it('create() generates a raw key and stores its SHA-256 hash (never the raw key)', async () => {
    let capturedInsertValues: Record<string, unknown> | undefined
    const insert = vi.fn().mockReturnValue({
      values: vi.fn((values: Record<string, unknown>) => {
        capturedInsertValues = values
        return {
          returning: vi.fn().mockResolvedValue([
            rowFromRecord({
              id: 'key-uuid-1',
              keyHash: values['keyHash'] as string,
              ownerId: values['ownerId'] as string,
              name: values['name'] as string | null,
              rateLimitTier: (values['rateLimitTier'] as string) ?? 'standard',
            }),
          ]),
        }
      }),
    })

    const db = buildDb({ insert })
    const store = new PostgresApiKeyStore(db)

    const { key, record } = await store.create('owner-1', 'my-key', 'premium')

    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(capturedInsertValues).toBeDefined()
    expect(capturedInsertValues!['keyHash']).toBe(hashApiKey(key))
    expect(capturedInsertValues!['keyHash']).not.toBe(key)
    expect(capturedInsertValues!['ownerId']).toBe('owner-1')
    expect(capturedInsertValues!['name']).toBe('my-key')
    expect(capturedInsertValues!['rateLimitTier']).toBe('premium')
    // Record returned must NOT expose the hash.
    expect((record as unknown as Record<string, unknown>)['keyHash']).toBeUndefined()
    expect(record.id).toBe('key-uuid-1')
  })

  it('validate() returns the record for a valid, non-expired, non-revoked key', async () => {
    const rawKey = 'a'.repeat(64)
    const keyHash = hashApiKey(rawKey)
    const row = rowFromRecord({
      keyHash,
      expiresAt: new Date(Date.now() + 60_000),
    })

    const select = mockSelect([row])
    const update = mockUpdate(updateCapture)
    const db = buildDb({ select, update })
    const store = new PostgresApiKeyStore(db)

    const result = await store.validate(rawKey)

    expect(result).not.toBeNull()
    expect(result!.id).toBe(row.id)
    expect(result!.ownerId).toBe(row.ownerId)
    expect((result as unknown as Record<string, unknown>)['keyHash']).toBeUndefined()
    // lastUsedAt update was issued.
    expect(update).toHaveBeenCalled()
    expect(updateCapture.value).toMatchObject({ lastUsedAt: expect.any(Date) })
  })

  it('validate() returns null for a revoked key', async () => {
    const rawKey = 'b'.repeat(64)
    const row = rowFromRecord({
      keyHash: hashApiKey(rawKey),
      revokedAt: new Date('2026-04-19T00:00:00Z'),
    })
    const select = mockSelect([row])
    const update = vi.fn()
    const db = buildDb({ select, update })
    const store = new PostgresApiKeyStore(db)

    const result = await store.validate(rawKey)

    expect(result).toBeNull()
    // Must NOT update lastUsedAt for revoked keys.
    expect(update).not.toHaveBeenCalled()
  })

  it('validate() returns null for an expired key', async () => {
    const rawKey = 'c'.repeat(64)
    const row = rowFromRecord({
      keyHash: hashApiKey(rawKey),
      expiresAt: new Date(Date.now() - 60_000),
    })
    const select = mockSelect([row])
    const update = vi.fn()
    const db = buildDb({ select, update })
    const store = new PostgresApiKeyStore(db)

    const result = await store.validate(rawKey)

    expect(result).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it('validate() returns null when the key is unknown', async () => {
    const select = mockSelect([])
    const db = buildDb({ select })
    const store = new PostgresApiKeyStore(db)

    const result = await store.validate('does-not-exist')

    expect(result).toBeNull()
  })

  it('revoke() issues an update that sets revokedAt to a Date', async () => {
    const update = mockUpdate(updateCapture)
    const db = buildDb({ update })
    const store = new PostgresApiKeyStore(db)

    await store.revoke('key-uuid-1')

    expect(update).toHaveBeenCalledTimes(1)
    expect(updateCapture.value).toBeDefined()
    expect(updateCapture.value!['revokedAt']).toBeInstanceOf(Date)
  })

  it('list() returns records for the owner without exposing keyHash', async () => {
    const rows = [
      rowFromRecord({ id: 'k1', ownerId: 'owner-42', name: 'first', keyHash: 'hash-1' }),
      rowFromRecord({ id: 'k2', ownerId: 'owner-42', name: 'second', keyHash: 'hash-2' }),
    ]
    const select = mockSelect(rows)
    const db = buildDb({ select })
    const store = new PostgresApiKeyStore(db)

    const results = await store.list('owner-42')

    expect(results).toHaveLength(2)
    for (const r of results) {
      expect((r as unknown as Record<string, unknown>)['keyHash']).toBeUndefined()
      expect(r.ownerId).toBe('owner-42')
    }
    expect(results.map((r: ApiKeyRecord) => r.id)).toEqual(['k1', 'k2'])
  })
})
