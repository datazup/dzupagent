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
import type { Context } from "hono";
import { Hono } from "hono";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  PostgresApiKeyStore,
  type ApiKeyRecord,
} from "../persistence/api-key-store.js";
import { getTenantId } from "../middleware/tenant-scope.js";
import type { ForgeRole } from "../middleware/rbac-types.js";
import type { AppEnv } from "../types.js";

type DB = PostgresJsDatabase<Record<string, never>>;

/**
 * SEC-H-01: the set of valid {@link ForgeRole} values, as a runtime guard.
 *
 * Route-issued keys must carry a role that RBAC actually understands. `'user'`
 * (the historical store default) is NOT a ForgeRole, so keys minted with it had
 * undefined RBAC behaviour. Any client-supplied role is validated against this
 * set before it reaches the store.
 */
const VALID_FORGE_ROLES: ReadonlySet<ForgeRole> = new Set<ForgeRole>([
  "admin",
  "operator",
  "viewer",
  "agent",
]);

/** Least-privileged default role for a route-issued key. */
const DEFAULT_API_KEY_ROLE: ForgeRole = "viewer";

/**
 * Fallback tenant when the caller context carries no server-derived tenant.
 *
 * This is only reached when the router is mounted without tenant scoping /
 * auth (e.g. a single-tenant or local deployment). It is a SERVER-side default,
 * never a client-supplied value.
 */
const DEFAULT_TENANT_ID = "default";

function isForgeRole(value: unknown): value is ForgeRole {
  return typeof value === "string" && VALID_FORGE_ROLES.has(value as ForgeRole);
}

/** API key display names are bounded to 128 characters after trimming. */
const MAX_API_KEY_NAME_LENGTH = 128;
/** API key expirations are bounded to one year, expressed in whole seconds. */
const MAX_API_KEY_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 365;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

export interface ApiKeyRoutesConfig {
  /** Optional pre-built store. If omitted, a fresh one is created from `db`. */
  store?: PostgresApiKeyStore;
  /** Drizzle DB handle — required when `store` is omitted. */
  db?: DB;
  /**
   * Allowed rate-limit tier values for key creation.
   * When provided, POST /api/keys returns 400 if the requested tier is not in
   * this list. Derived from ForgeServerConfig.rateLimit.tiers keys in app.ts.
   */
  allowedTiers?: string[];
}

interface IdentityLike {
  id?: string;
}

interface ApiKeyCtxLike {
  ownerId?: string;
  id?: string;
  role?: string;
  tenantId?: string;
}

function badRequest(message: string) {
  return { error: { code: "BAD_REQUEST", message } };
}

function validateApiKeyName(
  value: unknown
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string") {
    return { ok: false, message: "name is required" };
  }

  const name = value.trim();
  if (name.length === 0) {
    return { ok: false, message: "name must not be empty" };
  }

  if (name.length > MAX_API_KEY_NAME_LENGTH) {
    return {
      ok: false,
      message: `name must be at most ${MAX_API_KEY_NAME_LENGTH} characters`,
    };
  }

  if (CONTROL_CHARACTER_PATTERN.test(name)) {
    return { ok: false, message: "name must not contain control characters" };
  }

  return { ok: true, value: name };
}

function validateExpiresIn(
  value: unknown
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_API_KEY_EXPIRES_IN_SECONDS
  ) {
    return {
      ok: false,
      message: `expiresIn must be a positive integer no greater than ${MAX_API_KEY_EXPIRES_IN_SECONDS} seconds`,
    };
  }

  return { ok: true, value };
}

/**
 * Resolve the owner id for owner-scoped queries.
 *
 * Reads from the Hono context in a priority order (identity → apiKey →
 * anonymous). See the module-level doc comment for the full precedence table.
 */
function resolveOwnerId(c: Context): string {
  const ctx = c as Context<AppEnv>;
  const forgeIdentity = ctx.get("forgeIdentity") as IdentityLike | undefined;
  if (forgeIdentity?.id) return forgeIdentity.id;

  const identity = ctx.get("identity") as IdentityLike | undefined;
  if (identity?.id) return identity.id;

  const apiKey = ctx.get("apiKey") as ApiKeyCtxLike | undefined;
  if (apiKey?.ownerId) return apiKey.ownerId;
  if (apiKey?.id) return apiKey.id;

  return "anonymous";
}

/**
 * SEC-H-01: resolve the tenant a newly-issued key must be scoped to.
 *
 * The tenant is derived exclusively from server-trusted request state — the
 * tenant-scope middleware's `forgeTenantId`, then the authenticated apiKey
 * context's `tenantId` — NEVER from a client-supplied body field. Falling back
 * to a route-issued key onto the shared `'default'` tenant only happens when no
 * tenant scoping/auth is mounted at all (single-tenant / local deployments).
 */
function resolveCallerTenantId(c: Context): string {
  const ctx = c as Context<AppEnv>;

  const scopedTenantId = getTenantId(ctx);
  if (scopedTenantId) return scopedTenantId;

  const apiKey = ctx.get("apiKey") as ApiKeyCtxLike | undefined;
  if (apiKey?.tenantId) return apiKey.tenantId;

  return DEFAULT_TENANT_ID;
}

/**
 * SEC-H-01: resolve the caller's own RBAC role from server-trusted context.
 *
 * Reads the RBAC middleware's `forgeRole`, then the authenticated apiKey
 * context's `role`. Anything that is not a valid {@link ForgeRole} is ignored
 * so an invalid persisted role can never widen behaviour here.
 */
function resolveCallerRole(c: Context): ForgeRole | undefined {
  const ctx = c as Context<AppEnv>;

  const forgeRole = ctx.get("forgeRole");
  if (isForgeRole(forgeRole)) return forgeRole;

  const apiKey = ctx.get("apiKey") as ApiKeyCtxLike | undefined;
  if (isForgeRole(apiKey?.role)) return apiKey.role;

  return undefined;
}

function serializeRecord(record: ApiKeyRecord): Record<string, unknown> {
  return {
    id: record.id,
    ownerId: record.ownerId,
    name: record.name,
    rateLimitTier: record.rateLimitTier,
    role: record.role,
    tenantId: record.tenantId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    lastUsedAt: record.lastUsedAt,
    metadata: record.metadata,
  };
}

/**
 * Build the API key management router.
 *
 * Either pass a pre-built `PostgresApiKeyStore` (preferred for tests and
 * dependency injection) or pass a Drizzle `db` and let the router build one.
 */
export function createApiKeyRoutes(
  config: ApiKeyRoutesConfig | DB
): Hono<AppEnv> {
  let store: PostgresApiKeyStore;
  let allowedTiers: string[] | undefined;
  if (config instanceof PostgresApiKeyStore) {
    store = config;
  } else if (
    "store" in (config as ApiKeyRoutesConfig) &&
    (config as ApiKeyRoutesConfig).store
  ) {
    store = (config as ApiKeyRoutesConfig).store!;
    allowedTiers = (config as ApiKeyRoutesConfig).allowedTiers;
  } else if (
    "db" in (config as ApiKeyRoutesConfig) &&
    (config as ApiKeyRoutesConfig).db
  ) {
    store = new PostgresApiKeyStore((config as ApiKeyRoutesConfig).db!);
    allowedTiers = (config as ApiKeyRoutesConfig).allowedTiers;
  } else {
    // Treat argument as a raw DB handle.
    store = new PostgresApiKeyStore(config as DB);
  }

  const app = new Hono<AppEnv>();

  // --- Create key -------------------------------------------------------
  app.post("/", async (c) => {
    let body: {
      name?: unknown;
      tier?: string;
      expiresIn?: unknown;
      role?: unknown;
      tenantId?: unknown;
    };
    try {
      body = await c.req.json<{
        name?: unknown;
        tier?: string;
        expiresIn?: unknown;
        role?: unknown;
        tenantId?: unknown;
      }>();
    } catch {
      return c.json(badRequest("Invalid JSON body"), 400);
    }

    const name = validateApiKeyName(body.name);
    if (!name.ok) {
      return c.json(badRequest(name.message), 400);
    }

    const expiresIn = validateExpiresIn(body.expiresIn);
    if (!expiresIn.ok) {
      return c.json(badRequest(expiresIn.message), 400);
    }

    const tier = body.tier ?? "standard";

    if (allowedTiers && !allowedTiers.includes(tier)) {
      return c.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: `Invalid tier "${tier}". Allowed tiers: ${allowedTiers.join(
              ", "
            )}`,
          },
        },
        400
      );
    }

    const callerRole = resolveCallerRole(c);
    const callerIsAdmin = callerRole === "admin";

    // SEC-H-01: derive the tenant server-side. A client-supplied `tenantId` is
    // rejected unless the caller is admin — otherwise a caller could mint a key
    // scoped to (and able to read) another tenant's data.
    if (body.tenantId !== undefined && !callerIsAdmin) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "Only admins may set an explicit tenantId",
          },
        },
        403
      );
    }
    let tenantId = resolveCallerTenantId(c);
    if (callerIsAdmin && body.tenantId !== undefined) {
      if (typeof body.tenantId !== "string" || body.tenantId.trim() === "") {
        return c.json(badRequest("tenantId must be a non-empty string"), 400);
      }
      tenantId = body.tenantId.trim();
    }

    // SEC-H-01: validate any client-supplied role against ForgeRole and never
    // let a non-admin caller mint a key with a role other than the default
    // least-privileged `'viewer'` (no privilege escalation via key issuance).
    let role: ForgeRole = DEFAULT_API_KEY_ROLE;
    if (body.role !== undefined) {
      if (!isForgeRole(body.role)) {
        return c.json(
          badRequest("role must be one of: admin, operator, viewer, agent"),
          400
        );
      }
      if (body.role !== DEFAULT_API_KEY_ROLE && !callerIsAdmin) {
        return c.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Only admins may issue a key with a non-default role",
            },
          },
          403
        );
      }
      role = body.role;
    }

    const ownerId = resolveOwnerId(c);

    const result = await store.create(ownerId, name.value, tier, {
      expiresIn: expiresIn.value,
      role,
      tenantId,
    });

    return c.json(
      {
        key: result.key,
        id: result.record.id,
        name: result.record.name,
        tier: result.record.rateLimitTier,
        role: result.record.role,
        tenantId: result.record.tenantId,
        createdAt: result.record.createdAt,
        expiresAt: result.record.expiresAt,
      },
      201
    );
  });

  // --- List keys --------------------------------------------------------
  app.get("/", async (c) => {
    const ownerId = resolveOwnerId(c);
    const records = await store.list(ownerId);
    return c.json({ keys: records.map(serializeRecord) });
  });

  // --- Revoke key -------------------------------------------------------
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await store.get(id);
    const ownerId = resolveOwnerId(c);
    if (!existing || existing.ownerId !== ownerId) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "API key not found" } },
        404
      );
    }
    await store.revoke(id);
    return c.body(null, 204);
  });

  // --- Rotate key -------------------------------------------------------
  app.post("/:id/rotate", async (c) => {
    const id = c.req.param("id");
    const existing = await store.get(id);
    const ownerId = resolveOwnerId(c);
    if (!existing || existing.ownerId !== ownerId) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "API key not found" } },
        404
      );
    }
    if (existing.revokedAt) {
      return c.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: "Cannot rotate a revoked key",
          },
        },
        400
      );
    }

    let expiresIn: number | undefined;
    try {
      const body = await c.req.json<{ expiresIn?: unknown }>();
      const validatedExpiresIn = validateExpiresIn(body.expiresIn);
      if (!validatedExpiresIn.ok) {
        return c.json(badRequest(validatedExpiresIn.message), 400);
      }
      expiresIn = validatedExpiresIn.value;
    } catch {
      // body is optional for rotate
    }

    // SEC-H-01: the rotated key inherits the ORIGINAL key's tenant + role so
    // rotation never silently re-scopes a key onto the shared `'default'`
    // tenant or a `'viewer'` role it did not previously hold. A persisted role
    // that is not a valid ForgeRole (legacy rows) falls back to the
    // least-privileged default rather than propagating an invalid value.
    const rotatedRole: ForgeRole = isForgeRole(existing.role)
      ? existing.role
      : DEFAULT_API_KEY_ROLE;

    await store.revoke(id);
    const result = await store.create(
      existing.ownerId,
      existing.name ?? "",
      existing.rateLimitTier,
      {
        expiresIn,
        metadata: existing.metadata,
        role: rotatedRole,
        tenantId: existing.tenantId,
      }
    );

    return c.json(
      {
        key: result.key,
        id: result.record.id,
        name: result.record.name,
        tier: result.record.rateLimitTier,
        role: result.record.role,
        tenantId: result.record.tenantId,
        createdAt: result.record.createdAt,
        expiresAt: result.record.expiresAt,
      },
      201
    );
  });

  return app;
}
