/**
 * Authentication middleware for DzupAgent server.
 *
 * Supports API key authentication via Bearer token in Authorization header.
 * When mode is 'none', all requests pass through without auth.
 */
import type { MiddlewareHandler } from 'hono'

export interface AuthConfig {
  mode: 'api-key' | 'none'
  /** Validate an API key. Return truthy value (e.g., key metadata) on success, null on failure. */
  validateKey?: (key: string) => Promise<Record<string, unknown> | null>
}

/**
 * Create Hono middleware for API key authentication.
 *
 * Extracts Bearer token from Authorization header and validates it.
 * Sets `apiKey` context variable on success.
 */
export function authMiddleware(config: AuthConfig): MiddlewareHandler {
  return async (c, next) => {
    if (config.mode === 'none') {
      return next()
    }

    // Skip auth for health endpoints
    if (c.req.path.startsWith('/api/health')) {
      return next()
    }

    if (!config.validateKey) {
      return c.json(
        {
          error: {
            code: 'INVALID_CONFIG',
            message: 'API key auth is enabled but no validateKey function was configured',
          },
        },
        503,
      )
    }

    const authHeader = c.req.header('Authorization')
    if (!authHeader) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Missing Authorization header' } },
        401,
      )
    }

    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader

    if (!token) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Missing API key' } },
        401,
      )
    }

    const keyMeta = await config.validateKey(token)
    if (!keyMeta) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } },
        401,
      )
    }
    c.set('apiKey' as never, keyMeta as never)

    return next()
  }
}
