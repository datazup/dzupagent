/**
 * API key management routes.
 *
 * Exposes CRUD-lite endpoints for issuing, listing, and revoking API keys.
 * The raw key is returned only once at creation time — subsequent responses
 * never include the key or its hash.
 *
 * Owner scoping (in order of precedence):
 *   1. `c.get('forgeIdentity').id` — populated by {@link identityMiddleware}.
 *   2. `c.get('identity').id`       — legacy key kept for backwards compat.
 *   3. `c.get('apiKey').ownerId`    — set by {@link authMiddleware} on a
 *      successfully validated API key. This is the common path: the caller
 *      is scoped to the owner of the key they authenticated with.
 *   4. `c.get('apiKey').id`         — last-ditch fallback when the validated
 *      record has no explicit ownerId (older records).
 *   5. `'anonymous'`                — only when auth is disabled.
 *
 * In production, callers SHOULD mount this router behind auth so that at
 * least the `apiKey` fallback resolves.
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { PostgresApiKeyStore, type ApiKeyRecord } from '../persistence/api-key-store.js'

type DB = PostgresJsDatabase<Record<string, never>>

export interface ApiKeyRoutesConfig {
  /** Optional pre-built store. If omitted, a fresh one is created from `db`. */
  store?: PostgresApiKeyStore
  /** Drizzle DB handle — required when `store` is omitted. */
  db?: DB
  /**
   * Allowed rate-limit tier values for key creation.
   * When provided, POST /api/keys returns 400 if the requested tier is not in
   * this list. Derived from ForgeServerConfig.rateLimit.tiers keys in app.ts.
   */
  allowedTiers?: string[]
}

interface IdentityLike {
  id?: string
}

interface ApiKeyCtxLike {
  ownerId?: string
  id?: string
}

/**
 * Resolve the owner id for owner-scoped queries.
 *
 * Reads from the Hono context in a priority order (identity → apiKey →
 * anonymous). See the module-level doc comment for the full precedence table.
 */
function resolveOwnerId(c: Context): string {
  const forgeIdentity = c.get('forgeIdentity' as never) as IdentityLike | undefined
  if (forgeIdentity?.id) return forgeIdentity.id

  const identity = c.get('identity' as never) as IdentityLike | undefined
  if (identity?.id) return identity.id

  const apiKey = c.get('apiKey' as never) as ApiKeyCtxLike | undefined
  if (apiKey?.ownerId) return apiKey.ownerId
  if (apiKey?.id) return apiKey.id

  return 'anonymous'
}

function serializeRecord(record: ApiKeyRecord): Record<string, unknown> {
  return {
    id: record.id,
    ownerId: record.ownerId,
    name: record.name,
    rateLimitTier: record.rateLimitTier,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    lastUsedAt: record.lastUsedAt,
    metadata: record.metadata,
  }
}

/**
 * Build the API key management router.
 *
 * Either pass a pre-built `PostgresApiKeyStore` (preferred for tests and
 * dependency injection) or pass a Drizzle `db` and let the router build one.
 */
export function createApiKeyRoutes(config: ApiKeyRoutesConfig | DB): Hono {
  let store: PostgresApiKeyStore
  let allowedTiers: string[] | undefined
  if (config instanceof PostgresApiKeyStore) {
    store = config
  } else if ('store' in (config as ApiKeyRoutesConfig) && (config as ApiKeyRoutesConfig).store) {
    store = (config as ApiKeyRoutesConfig).store!
    allowedTiers = (config as ApiKeyRoutesConfig).allowedTiers
  } else if ('db' in (config as ApiKeyRoutesConfig) && (config as ApiKeyRoutesConfig).db) {
    store = new PostgresApiKeyStore((config as ApiKeyRoutesConfig).db!)
    allowedTiers = (config as ApiKeyRoutesConfig).allowedTiers
  } else {
    // Treat argument as a raw DB handle.
    store = new PostgresApiKeyStore(config as DB)
  }

  const app = new Hono()

  // --- Create key -------------------------------------------------------
  app.post('/', async (c) => {
    let body: { name?: string; tier?: string; expiresIn?: number }
    try {
      body = await c.req.json<{ name?: string; tier?: string; expiresIn?: number }>()
    } catch {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
        400,
      )
    }

    if (!body.name || typeof body.name !== 'string') {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'name is required' } },
        400,
      )
    }

    const tier = body.tier ?? 'standard'

    if (allowedTiers && !allowedTiers.includes(tier)) {
      return c.json(
        {
          error: {
            code: 'BAD_REQUEST',
            message: `Invalid tier "${tier}". Allowed tiers: ${allowedTiers.join(', ')}`,
          },
        },
        400,
      )
    }

    const ownerId = resolveOwnerId(c)

    const result = await store.create(ownerId, body.name, tier, {
      expiresIn: typeof body.expiresIn === 'number' ? body.expiresIn : undefined,
    })

    return c.json(
      {
        key: result.key,
        id: result.record.id,
        name: result.record.name,
        tier: result.record.rateLimitTier,
        createdAt: result.record.createdAt,
        expiresAt: result.record.expiresAt,
      },
      201,
    )
  })

  // --- List keys --------------------------------------------------------
  app.get('/', async (c) => {
    const ownerId = resolveOwnerId(c)
    const records = await store.list(ownerId)
    return c.json({ keys: records.map(serializeRecord) })
  })

  // --- Revoke key -------------------------------------------------------
  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const existing = await store.get(id)
    if (!existing) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'API key not found' } },
        404,
      )
    }
    await store.revoke(id)
    return c.body(null, 204)
  })

  // --- Rotate key -------------------------------------------------------
  app.post('/:id/rotate', async (c) => {
    const id = c.req.param('id')
    const existing = await store.get(id)
    if (!existing) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'API key not found' } },
        404,
      )
    }
    if (existing.revokedAt) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'Cannot rotate a revoked key' } },
        400,
      )
    }

    let expiresIn: number | undefined
    try {
      const body = await c.req.json<{ expiresIn?: number }>()
      if (typeof body.expiresIn === 'number') expiresIn = body.expiresIn
    } catch {
      // body is optional for rotate
    }

    await store.revoke(id)
    const result = await store.create(existing.ownerId, existing.name ?? '', existing.rateLimitTier, {
      expiresIn,
      metadata: existing.metadata,
    })

    return c.json(
      {
        key: result.key,
        id: result.record.id,
        name: result.record.name,
        tier: result.record.rateLimitTier,
        createdAt: result.record.createdAt,
        expiresAt: result.record.expiresAt,
      },
      201,
    )
  })

  return app
}
