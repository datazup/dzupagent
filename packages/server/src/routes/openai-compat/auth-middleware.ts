/**
 * OpenAI-compatible API key authentication middleware.
 *
 * Reads `Authorization: Bearer <token>` and validates the token.
 * On failure, returns a 401 in OpenAI's error format so that standard
 * OpenAI client libraries surface a recognisable error message.
 *
 * Supports three modes:
 * 1. **Delegate** — if a `validateKey` function is provided, it is called.
 * 2. **Disabled** — if `enabled` is explicitly `false`, requests pass
 *    through unauthenticated. This is the only way to opt into dev mode.
 * 3. **Rejected** — if no `validateKey` is provided and `enabled` is not
 *    explicitly `false`, all requests are rejected with 401. This is a
 *    secure-by-default posture: silent dev-mode fallthrough has been
 *    removed to avoid accidentally shipping an open endpoint.
 */
import type { MiddlewareHandler } from 'hono'
import type { OpenAIErrorResponse } from './types.js'

export interface OpenAIAuthConfig {
  /**
   * When `false`, the middleware is a no-op pass-through. This is the only
   * supported way to disable auth for development — omitting `validateKey`
   * without also setting `enabled: false` results in all requests being
   * rejected with 401.
   */
  enabled?: boolean
  /**
   * Optional key validator. Return a truthy metadata object on success,
   * or null/undefined to reject. Required unless `enabled` is explicitly
   * `false`.
   */
  validateKey?: (key: string) => Promise<Record<string, unknown> | null>
}

function errorResponse(
  message: string,
  code: string,
): OpenAIErrorResponse {
  return {
    error: {
      message,
      type: 'invalid_request_error',
      param: null,
      code,
    },
  }
}

/**
 * Create Hono middleware that validates OpenAI-style Bearer tokens.
 */
export function openaiAuthMiddleware(config?: OpenAIAuthConfig): MiddlewareHandler {
  return async (c, next) => {
    // Disabled — pass through
    if (config?.enabled === false) {
      return next()
    }

    const authHeader = c.req.header('Authorization')

    if (!authHeader) {
      return c.json(
        errorResponse(
          'You didn\'t provide an API key. You need to provide your API key in an Authorization header using Bearer auth.',
          'invalid_api_key',
        ),
        401,
      )
    }

    // Extract the token from "Bearer <token>"
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : ''

    if (!token) {
      return c.json(
        errorResponse('Invalid API key', 'invalid_api_key'),
        401,
      )
    }

    // Delegate to custom validator if provided
    if (config?.validateKey) {
      const keyMeta = await config.validateKey(token)
      if (!keyMeta) {
        return c.json(
          errorResponse(
            'Incorrect API key provided. You can find your API key at https://platform.openai.com/account/api-keys.',
            'invalid_api_key',
          ),
          401,
        )
      }
      // Stash metadata for downstream handlers
      c.set('apiKey' as never, keyMeta as never)
      return next()
    }

    // Secure-by-default: when no validator is configured and auth was not
    // explicitly disabled (`enabled === false` was handled at the top of
    // this middleware), reject the request. This prevents accidentally
    // shipping a dev-mode fallthrough to production.
    return c.json(
      errorResponse(
        'API key authentication is not configured on this server.',
        'invalid_api_key',
      ),
      401,
    )
  }
}
