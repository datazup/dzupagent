/**
 * Identity resolution middleware for DzupAgent server.
 *
 * Resolves a ForgeIdentity from the request's Authorization header
 * (Bearer or ApiKey format) or X-API-Key header, using the configured
 * IdentityResolver from @dzupagent/core.
 */
import type { Context, MiddlewareHandler } from 'hono'
import type {
  IdentityResolver,
  ForgeIdentity,
  ForgeCapability,
} from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface IdentityMiddlewareConfig {
  resolver: IdentityResolver
  /** If true, reject requests without valid identity (default: false). */
  required?: boolean
}

// ---------------------------------------------------------------------------
// Context variable keys
// ---------------------------------------------------------------------------

const IDENTITY_KEY = 'forgeIdentity'
const CAPABILITIES_KEY = 'forgeCapabilities'

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

function extractToken(c: Context): string | undefined {
  const authHeader = c.req.header('Authorization')
  if (authHeader) {
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7) || undefined
    }
    if (authHeader.startsWith('ApiKey ')) {
      return authHeader.slice(7) || undefined
    }
    // Treat raw Authorization header value as token
    return authHeader || undefined
  }

  // Fallback: X-API-Key header
  const apiKeyHeader = c.req.header('X-API-Key')
  return apiKeyHeader || undefined
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Hono middleware that resolves ForgeIdentity from request context.
 *
 * Reads token from Authorization header (Bearer or ApiKey formats)
 * or X-API-Key header as fallback. Passes token to the configured
 * IdentityResolver. On success, sets `forgeIdentity` and
 * `forgeCapabilities` in Hono context variables.
 */
export function identityMiddleware(
  config: IdentityMiddlewareConfig,
): MiddlewareHandler {
  const { resolver, required = false } = config

  return async (c, next) => {
    const token = extractToken(c)

    // Build lowercased headers map for the resolver
    const headers: Record<string, string> = {}
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })

    const identity = await resolver.resolve({ token, headers })

    if (identity) {
      c.set(IDENTITY_KEY as never, identity as never)
      c.set(CAPABILITIES_KEY as never, identity.capabilities as never)
    } else if (required) {
      return c.json(
        {
          error: {
            code: 'IDENTITY_RESOLUTION_FAILED',
            message: 'Could not resolve identity from request credentials',
          },
        },
        401,
      )
    }

    return next()
  }
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

/**
 * Extract ForgeIdentity from Hono context.
 * Returns undefined if identity middleware was not configured or no identity resolved.
 */
export function getForgeIdentity(c: Context): ForgeIdentity | undefined {
  return c.get(IDENTITY_KEY as never) as ForgeIdentity | undefined
}

/**
 * Extract capabilities from Hono context.
 * Returns empty array if no identity was resolved.
 */
export function getForgeCapabilities(c: Context): ForgeCapability[] {
  return (c.get(CAPABILITIES_KEY as never) as ForgeCapability[] | undefined) ?? []
}
