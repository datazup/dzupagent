/**
 * Tenant scoping middleware for multi-tenant DzupAgent deployments.
 *
 * Ensures every request is associated with a tenant ID, making it available
 * to downstream handlers via Hono context.
 */
import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../types.js";

export interface TenantScopeConfig {
  /**
   * Extract tenant ID from the request. This SHOULD derive the tenant from a
   * server-trusted source (e.g. the authenticated API key / identity context),
   * NOT from client-controlled input. See `allowHeaderTenantFallback`.
   */
  extractTenantId: (c: {
    req: { header: (name: string) => string | undefined };
    get: (key: string) => unknown;
  }) => string | undefined;
  /** Header name for tenant ID (default: 'X-Tenant-ID') */
  headerName?: string;
  /**
   * SEC-I-05: when `true`, fall back to the client-supplied tenant header if
   * `extractTenantId` returns nothing. This is OFF by default because a client
   * can set any value for that header — trusting it lets a caller read/write
   * another tenant's data (tenant spoofing). Only enable it for trusted-network
   * deployments where the tenant cannot be derived server-side. The
   * recommended posture is to derive the tenant inside `extractTenantId` from
   * the authenticated context and leave this disabled.
   */
  allowHeaderTenantFallback?: boolean;
}

const TENANT_CONTEXT_KEY = "forgeTenantId" as const;

/**
 * Tenant scoping middleware.
 *
 * Extracts the tenant ID using the provided function (or falls back to
 * reading the configured header) and sets it in the Hono context.
 * Health endpoints are allowed through without a tenant.
 * All other requests receive a 400 error if no tenant ID is found.
 */
export function tenantScopeMiddleware(
  config: TenantScopeConfig
): MiddlewareHandler<AppEnv> {
  const headerName = config.headerName ?? "X-Tenant-ID";

  return async (c, next) => {
    // Health endpoints bypass tenant scoping
    if (c.req.path.startsWith("/api/health")) {
      return next();
    }

    // Prefer the server-trusted tenant from the extractor (auth context).
    let tenantId = config.extractTenantId(c);

    // SEC-I-05: only fall back to the client-supplied header when explicitly
    // opted in. The header is attacker-controllable, so trusting it by default
    // would allow tenant spoofing. Default posture: derive tenant server-side
    // via `extractTenantId` and reject when it is absent.
    if (!tenantId && config.allowHeaderTenantFallback === true) {
      tenantId = c.req.header(headerName) ?? undefined;
    }

    if (!tenantId) {
      return c.json(
        {
          error: {
            code: "MISSING_TENANT",
            message: `Tenant ID is required. Provide it via the '${headerName}' header or authentication context.`,
          },
        },
        400
      );
    }

    c.set(TENANT_CONTEXT_KEY, tenantId);
    return next();
  };
}

/**
 * Extract tenant ID from Hono context (set by tenantScopeMiddleware).
 *
 * Returns `undefined` if the middleware has not run or no tenant was set.
 */
export function getTenantId(c: {
  get: (key: string) => unknown;
}): string | undefined {
  return c.get(TENANT_CONTEXT_KEY) as string | undefined;
}
