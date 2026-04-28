/**
 * Middleware composition for the Hono app. Encapsulates the legacy ordering
 * from `app.ts`:
 *
 *   1. CORS (only when explicitly configured)
 *   2. Security headers (all paths) — unless explicitly disabled
 *   3. Auth (`/api/*`) — when `config.auth` is provided
 *   4. RBAC  (`/api/*`) — chained after auth unless explicitly disabled
 *   5. Rate limiter (`/api/*`) — when `config.rateLimit` is provided
 *   6. Shutdown guard for `POST /api/runs` — when `config.shutdown` is provided
 *   7. Request metrics (all paths) — when `config.metrics` is provided
 *   8. Global `onError` handler (always)
 *
 * The function returns the resolved `effectiveAuth` (with `apiKeyStore` wired
 * into the validateKey callback when applicable) so downstream consumers
 * (notably the A2A route mount) can reuse it.
 */
import type { Hono } from 'hono'
import { cors } from 'hono/cors'

import type { ForgeServerConfig, SecurityHeadersConfig } from './types.js'
import { authMiddleware, type AuthConfig } from '../middleware/auth.js'
import { rbacMiddleware, type ForgeRole, type RBACConfig } from '../middleware/rbac.js'
import { rateLimiterMiddleware } from '../middleware/rate-limiter.js'

export interface ComposedMiddleware {
  /** Auth config with apiKeyStore validate function wired in (when applicable). */
  effectiveAuth: AuthConfig | undefined
}

const FRAMEWORK_API_AUTH_WARNING =
  '[ForgeServer] WARNING: Framework /api/* routes are running without authentication. Set auth.mode="api-key" for production, or auth.mode="none" only for local development or legacy compatibility.'

const PRODUCTION_FRAMEWORK_API_AUTH_ERROR =
  '[ForgeServer] Refusing to start production framework /api/* routes without explicit auth. Configure auth: { mode: "api-key", ... } for production, or auth: { mode: "none" } only for an intentional development/compatibility opt-out.'

const WILDCARD_CORS_WARNING =
  '[ForgeServer] WARNING: CORS is open to all origins (*). This is intended only for local development or legacy compatibility.'

const WILDCARD_CORS_ERROR =
  '[ForgeServer] Refusing wildcard CORS in production without allowWildcardCors=true. Configure corsOrigins with an explicit allow-list, disable CORS by omitting corsOrigins, or opt into compatibility with allowWildcardCors.'

export function assertExplicitFrameworkApiAuth(config: ForgeServerConfig): void {
  if (config.auth) {
    return
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(PRODUCTION_FRAMEWORK_API_AUTH_ERROR)
  }

  console.warn(FRAMEWORK_API_AUTH_WARNING)
}

export function applyMiddleware(app: Hono, config: ForgeServerConfig): ComposedMiddleware {
  applyCors(app, config)
  applySecurityHeaders(app, config)
  const effectiveAuth = applyAuthAndRbac(app, config)
  applyRateLimit(app, config)
  applyShutdownGuard(app, config)
  applyRequestMetrics(app, config)
  applyErrorHandler(app, config)

  return { effectiveAuth }
}

function applyCors(app: Hono, config: ForgeServerConfig): void {
  const origin = resolveCorsOrigin(config)
  if (!origin) {
    return
  }

  app.use('*', cors({
    origin,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }))

  if (isWildcardCorsOrigin(origin)) {
    console.warn(WILDCARD_CORS_WARNING)
  }
}

function resolveCorsOrigin(config: ForgeServerConfig): string | string[] | undefined {
  const origin = config.corsOrigins ?? (config.allowWildcardCors ? '*' : undefined)
  if (!origin) {
    return undefined
  }

  const origins = Array.isArray(origin) ? origin : [origin]
  const hasWildcard = origins.includes('*')
  if (hasWildcard && process.env.NODE_ENV === 'production' && !config.allowWildcardCors) {
    throw new Error(WILDCARD_CORS_ERROR)
  }
  if (hasWildcard && origins.length > 1) {
    throw new Error('[ForgeServer] Invalid CORS configuration: wildcard (*) cannot be combined with explicit origins.')
  }

  return origin
}

function isWildcardCorsOrigin(origin: string | string[]): boolean {
  return Array.isArray(origin) ? origin.includes('*') : origin === '*'
}

function applySecurityHeaders(app: Hono, config: ForgeServerConfig): void {
  if (config.securityHeaders === false) {
    return
  }

  const headers = resolveSecurityHeaders(config.securityHeaders)
  app.use('*', async (c, next) => {
    await next()
    for (const [name, value] of headers) {
      c.header(name, value)
    }
  })
}

function resolveSecurityHeaders(config?: SecurityHeadersConfig): Array<[string, string]> {
  const defaults: Array<[string, string | false | undefined]> = [
    ['X-Content-Type-Options', config?.xContentTypeOptions ?? 'nosniff'],
    ['Referrer-Policy', config?.referrerPolicy ?? 'no-referrer'],
    ['X-Frame-Options', config?.xFrameOptions],
    ['Content-Security-Policy', config?.contentSecurityPolicy],
  ]

  const headers = new Map<string, string>()
  for (const [name, value] of defaults) {
    if (typeof value === 'string') {
      headers.set(name, value)
    }
  }
  for (const [name, value] of Object.entries(config?.additionalHeaders ?? {})) {
    if (value === false || value === undefined) {
      headers.delete(name)
    } else {
      headers.set(name, value)
    }
  }
  return [...headers.entries()]
}

function applyAuthAndRbac(app: Hono, config: ForgeServerConfig): AuthConfig | undefined {
  if (!config.auth) {
    return undefined
  }

  if (config.auth.mode === 'none') {
    console.warn(FRAMEWORK_API_AUTH_WARNING)
  }

  let effectiveAuth: AuthConfig = config.auth
  if (
    config.auth.mode === 'api-key' &&
    !config.auth.validateKey &&
    config.apiKeyStore
  ) {
    effectiveAuth = {
      ...config.auth,
      validateKey: async (key) => {
        const record = await config.apiKeyStore!.validate(key)
        return record ? { ...record } as Record<string, unknown> : null
      },
    }
  }
  app.use('/api/*', authMiddleware(effectiveAuth))

  // MC-S02: RBAC — mounted after authMiddleware so the `apiKey` context
  // variable is populated. Role defaults to `'user'` when the API key
  // record predates the MC-S02 migration, so existing keys keep working
  // but admin-only endpoints (MCP registration, cluster management)
  // reject them. Hosts can opt out with `config.rbac = false`.
  if (config.rbac !== false) {
    const rbacConfig: RBACConfig = config.rbac ?? {
      extractRole: (c) => {
        const key = c.get('apiKey') as Record<string, unknown> | undefined
        const role = key?.['role']
        return typeof role === 'string'
          ? (role as ForgeRole)
          : ('user' as ForgeRole)
      },
    }
    app.use('/api/*', rbacMiddleware(rbacConfig))
  }

  return effectiveAuth
}

function applyRateLimit(app: Hono, config: ForgeServerConfig): void {
  if (config.rateLimit) {
    app.use('/api/*', rateLimiterMiddleware(config.rateLimit))
  }
}

function applyShutdownGuard(app: Hono, config: ForgeServerConfig): void {
  if (!config.shutdown) {
    return
  }
  app.use('/api/runs', async (c, next) => {
    if (c.req.method === 'POST' && !config.shutdown!.isAcceptingRuns()) {
      return c.json(
        { error: { code: 'SERVICE_UNAVAILABLE', message: 'Server is shutting down' } },
        503,
      )
    }
    return next()
  })
}

function applyRequestMetrics(app: Hono, config: ForgeServerConfig): void {
  if (!config.metrics) {
    return
  }
  app.use('*', async (c, next) => {
    const start = Date.now()
    await next()
    const latency = Date.now() - start
    config.metrics!.increment('http_requests_total', {
      method: c.req.method,
      path: c.req.path,
      status: String(c.res.status),
    })
    config.metrics!.observe('http_request_duration_ms', latency, {
      method: c.req.method,
      path: c.req.path,
    })
  })
}

function applyErrorHandler(app: Hono, config: ForgeServerConfig): void {
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err)

    console.error(`[ForgeServer] ${c.req.method} ${c.req.path}: ${message}`)
    config.metrics?.increment('http_errors_total', { path: c.req.path })
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      500,
    )
  })
}
