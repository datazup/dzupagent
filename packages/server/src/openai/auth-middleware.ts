/**
 * OpenAI-compatible API key authentication middleware.
 *
 * Reads `Authorization: Bearer <token>` and validates the token.
 * On failure, returns a 401 in OpenAI's error format so that standard
 * OpenAI client libraries surface a recognisable error message.
 *
 * Supports three modes:
 * 1. **Delegate** — if a `validateKey` function is provided, it is called.
 * 2. **Dev mode** — if no `validateKey` is provided, any non-empty Bearer
 *    token is accepted (suitable for local development only).
 * 3. **Disabled** — if `enabled` is explicitly false, requests pass through.
 */
import type { MiddlewareHandler } from 'hono'
import type { OpenAIErrorResponse } from './types.js'

export interface OpenAIAuthConfig {
  /** When false, the middleware is a no-op pass-through. */
  enabled?: boolean
  /**
   * Optional key validator.  Return a truthy metadata object on success,
   * or null/undefined to reject.  When omitted, any non-empty Bearer token
   * is accepted (dev mode).
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
    }

    // Dev mode: non-empty token accepted without further validation

    return next()
  }
}
