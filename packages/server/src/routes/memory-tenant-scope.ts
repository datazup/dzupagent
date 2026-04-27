/**
 * Tenant scoping helpers for memory routes (MJ-SEC-04).
 *
 * Memory browse, export, import, and analytics routes must NOT trust
 * caller-supplied `namespace` and `scope` values. Instead, the authenticated
 * tenant identity (extracted from the API key context populated by the auth
 * middleware) is the source of truth.
 *
 * Single-tenant deployments where auth is disabled must continue to work, so
 * the helpers fall back to a configurable default scope when no authenticated
 * identity is present.
 */
import type { Context } from 'hono'

/**
 * Configuration for memory routes tenant-scope resolution.
 *
 * When `resolveAuthScope` is provided, it is consulted first. If it returns a
 * non-empty record, those keys are FORCED into the final scope (silently
 * overriding any client-supplied values for the same key). When no authenticated
 * identity is present (or the resolver returns an empty record), the
 * `defaultScope` is used as a fallback.
 */
export interface MemoryTenantScopeConfig {
  /**
   * Resolve the authenticated tenant scope from the Hono context.
   * Defaults to {@link defaultResolveAuthScope} which inspects the `apiKey`
   * context variable populated by the auth middleware.
   */
  resolveAuthScope?: (c: Context) => Record<string, string>
  /**
   * Fallback scope when no authenticated identity is present. Use this for
   * single-tenant deployments running with auth disabled.
   * Defaults to `{}` (no implicit scope filter).
   */
  defaultScope?: Record<string, string>
}

/**
 * Default extractor: pulls `tenantId` and `ownerId` from the auth-middleware
 * `apiKey` context variable. This matches the behaviour of `runs.ts`, which
 * uses the same fields for owner/tenant scoping.
 */
export function defaultResolveAuthScope(c: Context): Record<string, string> {
  const key = c.get('apiKey' as never) as Record<string, unknown> | undefined
  if (!key) return {}
  const out: Record<string, string> = {}
  const tenantId = key['tenantId']
  if (typeof tenantId === 'string' && tenantId.length > 0) {
    out['tenantId'] = tenantId
  }
  const ownerId = key['ownerId']
  if (typeof ownerId === 'string' && ownerId.length > 0) {
    out['ownerId'] = ownerId
  }
  return out
}

/**
 * Apply the authoritative tenant scope to a client-supplied scope record.
 *
 * Authenticated keys silently override conflicting client values to avoid
 * leaking which tenant a key belongs to. When no authenticated identity is
 * present, the configured `defaultScope` is layered under the client scope.
 */
export function applyAuthoritativeScope(
  c: Context,
  clientScope: Record<string, string>,
  config: MemoryTenantScopeConfig = {},
): Record<string, string> {
  const resolver = config.resolveAuthScope ?? defaultResolveAuthScope
  const authScope = resolver(c)

  if (Object.keys(authScope).length > 0) {
    // Authenticated request: force auth scope keys to override client values.
    return { ...clientScope, ...authScope }
  }

  // Single-tenant / unauthenticated: layer default scope under client scope.
  return { ...(config.defaultScope ?? {}), ...clientScope }
}
