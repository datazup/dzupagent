/**
 * Postgres-backed API key store.
 *
 * Stores only SHA-256 hashes of raw keys. The raw key is generated and
 * returned once at creation time — callers MUST store it themselves because
 * the server can never recover it.
 *
 * Validation hashes the submitted key and looks up the row by `key_hash`,
 * rejecting revoked/expired rows and updating `last_used_at` on success.
 */
import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { DzupEventBus } from '@dzupagent/core'
import { apiKeys } from './drizzle-schema.js'

type DB = PostgresJsDatabase<Record<string, never>>

/**
 * Public representation of an API key record.
 *
 * Never includes the raw key or its hash — only safe metadata. This type is
 * what API key management endpoints return.
 */
export interface ApiKeyRecord {
  id: string
  ownerId: string
  name: string | null
  rateLimitTier: string
  /** MC-S02: RBAC role. Defaults to `'user'`. */
  role: string
  /** MC-S02: Tenant scope. Defaults to `'default'`. */
  tenantId: string
  createdAt: Date
  expiresAt: Date | null
  revokedAt: Date | null
  lastUsedAt: Date | null
  metadata: Record<string, unknown>
}

/** Result returned by `create()` — the raw key is shown exactly once. */
export interface CreateApiKeyResult {
  /** Raw API key (hex, 64 chars). Shown exactly once. */
  key: string
  record: ApiKeyRecord
}

/**
 * Hash a raw API key using SHA-256 (hex, 64 chars).
 *
 * Exported for testing — production callers should not need it directly.
 */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex')
}

/**
 * Generate a cryptographically-random 32-byte API key encoded as hex (64 chars).
 */
export function generateRawApiKey(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Postgres-backed API key store.
 */
export class PostgresApiKeyStore {
  constructor(
    private readonly db: DB,
    private readonly eventBus?: DzupEventBus,
  ) {}

  /**
   * Create a new API key for the given owner.
   *
   * Generates a random 32-byte key, stores its SHA-256 hash, and returns both
   * the raw key (shown once) and the DB record (without the hash).
   */
  async create(
    ownerId: string,
    name: string,
    tier: string = 'standard',
    options?: {
      expiresAt?: Date | null
      expiresIn?: number
      metadata?: Record<string, unknown>
      /** MC-S02: RBAC role for this key. Defaults to `'user'`. */
      role?: string
      /** MC-S02: Tenant scope. Defaults to `'default'`. */
      tenantId?: string
    },
  ): Promise<CreateApiKeyResult> {
    const rawKey = generateRawApiKey()
    const keyHash = hashApiKey(rawKey)

    let expiresAt = options?.expiresAt ?? null
    if (expiresAt === null && options?.expiresIn != null) {
      expiresAt = new Date(Date.now() + options.expiresIn * 1000)
    }

    const rows = await this.db
      .insert(apiKeys)
      .values({
        keyHash,
        ownerId,
        name,
        rateLimitTier: tier,
        role: options?.role ?? 'user',
        tenantId: options?.tenantId ?? 'default',
        expiresAt,
        metadata: options?.metadata ?? {},
      })
      .returning()

    const row = rows[0]
    if (!row) {
      throw new Error('Failed to create API key: no row returned')
    }

    const record = this.toRecord(row)
    this.eventBus?.emit({ type: 'api-key:created', id: record.id, ownerId, tier })
    return { key: rawKey, record }
  }

  /**
   * Validate a raw API key.
   *
   * Returns the record metadata on success, or null when the key is unknown,
   * revoked, or expired. Updates `lastUsedAt` on successful validation.
   */
  async validate(rawKey: string): Promise<ApiKeyRecord | null> {
    if (!rawKey) return null
    const keyHash = hashApiKey(rawKey)

    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1)

    const row = rows[0]
    if (!row) return null

    if (row.revokedAt) return null

    const now = new Date()
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
      return null
    }

    // Update lastUsedAt — non-critical; swallow errors silently so a failing
    // update does not reject otherwise-valid requests.
    try {
      await this.db
        .update(apiKeys)
        .set({ lastUsedAt: now })
        .where(eq(apiKeys.id, row.id))
    } catch {
      // ignore
    }

    const record = this.toRecord({ ...row, lastUsedAt: now })
    this.eventBus?.emit({ type: 'api-key:validated', id: record.id, ownerId: record.ownerId, tier: record.rateLimitTier })
    return record
  }

  /**
   * Revoke an API key by id. Idempotent — revoking an already-revoked key
   * is a no-op that leaves the original `revokedAt` timestamp in place.
   */
  async revoke(id: string): Promise<void> {
    const rows = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id, ownerId: apiKeys.ownerId })
    const row = rows[0]
    if (row) {
      this.eventBus?.emit({ type: 'api-key:revoked', id: row.id, ownerId: row.ownerId })
    }
  }

  /**
   * List keys for the given owner. Never returns the key hash.
   */
  async list(ownerId: string): Promise<ApiKeyRecord[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.ownerId, ownerId))
      .orderBy(desc(apiKeys.createdAt))

    return rows.map((row) => this.toRecord(row))
  }

  /**
   * Get a single key by id (never includes the hash).
   */
  async get(id: string): Promise<ApiKeyRecord | null> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, id))
      .limit(1)
    const row = rows[0]
    return row ? this.toRecord(row) : null
  }

  private toRecord(row: typeof apiKeys.$inferSelect): ApiKeyRecord {
    return {
      id: row.id,
      ownerId: row.ownerId,
      name: row.name,
      rateLimitTier: row.rateLimitTier,
      role: (row as unknown as { role?: string }).role ?? 'user',
      tenantId: (row as unknown as { tenantId?: string }).tenantId ?? 'default',
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      lastUsedAt: row.lastUsedAt,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
    }
  }
}
