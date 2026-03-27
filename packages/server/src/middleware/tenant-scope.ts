/**
 * Tenant scoping middleware for multi-tenant DzipAgent deployments.
 *
 * Ensures every request is associated with a tenant ID, making it available
 * to downstream handlers via Hono context.
 */
import type { MiddlewareHandler } from 'hono'

export interface TenantScopeConfig {
  /** Extract tenant ID from request */
  extractTenantId: (c: {
    req: { header: (name: string) => string | undefined }
    get: (key: string) => unknown
  }) => string | undefined
  /** Header name for tenant ID (default: 'X-Tenant-ID') */
  headerName?: string
}

const TENANT_CONTEXT_KEY = 'forgeTenantId'

/**
 * Tenant scoping middleware.
 *
 * Extracts the tenant ID using the provided function (or falls back to
 * reading the configured header) and sets it in the Hono context.
 * Health endpoints are allowed through without a tenant.
 * All other requests receive a 400 error if no tenant ID is found.
 */
export function tenantScopeMiddleware(config: TenantScopeConfig): MiddlewareHandler {
  const headerName = config.headerName ?? 'X-Tenant-ID'

  return async (c, next) => {
    // Health endpoints bypass tenant scoping
    if (c.req.path.startsWith('/api/health')) {
      return next()
    }

    let tenantId = config.extractTenantId(c)

    // Fallback: read from header if extractor returned nothing
    if (!tenantId) {
      tenantId = c.req.header(headerName) ?? undefined
    }

    if (!tenantId) {
      return c.json(
        {
          error: {
            code: 'MISSING_TENANT',
            message: `Tenant ID is required. Provide it via the '${headerName}' header or authentication context.`,
          },
        },
        400,
      )
    }

    c.set(TENANT_CONTEXT_KEY as never, tenantId as never)
    return next()
  }
}

/**
 * Extract tenant ID from Hono context (set by tenantScopeMiddleware).
 *
 * Returns `undefined` if the middleware has not run or no tenant was set.
 */
export function getTenantId(c: { get: (key: string) => unknown }): string | undefined {
  return c.get(TENANT_CONTEXT_KEY) as string | undefined
}
