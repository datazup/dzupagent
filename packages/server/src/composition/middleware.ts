/**
 * Middleware composition for the Hono app. Encapsulates the legacy ordering
 * from `app.ts`:
 *
 *   1. CORS (only when explicitly configured)
 *   2. Security headers (all paths) — unless explicitly disabled
 *   3. Auth (`/api/*`) — when `config.auth` is provided
 *   4. RBAC  (`/api/*`) — chained after auth unless explicitly disabled
 *   5. Rate limiter (`/api/*`) — when `config.rateLimit` is provided
 *   6. JSON body size guard (all paths) — unless explicitly disabled
 *   7. Shutdown guard for `POST /api/runs` — when `config.shutdown` is provided
 *   8. Request metrics (all paths) — when `config.metrics` is provided
 *   9. Global `onError` handler (always)
 *
 * The function returns the resolved `effectiveAuth` (with `apiKeyStore` wired
 * into the validateKey callback when applicable) so downstream consumers
 * (notably the A2A route mount) can reuse it.
 */
import type { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { cors } from 'hono/cors'
import { defaultLogger } from '@dzupagent/core/utils'

import type { ForgeServerConfig, JsonBodyLimitConfig, SecurityHeadersConfig } from './types.js'
import { authMiddleware, type AuthConfig } from '../middleware/auth.js'
import { rbacMiddleware, type ForgeRole, type RBACConfig } from '../middleware/rbac.js'
import { rateLimiterMiddleware } from '../middleware/rate-limiter.js'

export interface ComposedMiddleware {
  /** Auth config with apiKeyStore validate function wired in (when applicable). */
  effectiveAuth: AuthConfig | undefined
}

export const DEFAULT_JSON_BODY_MAX_BYTES = 1_048_576

const DEFAULT_ROUTE_JSON_BODY_MAX_BYTES: Record<string, number> = {
  '/api/memory/import': 8 * 1_048_576,
  '/api/workflows/compile': 2 * 1_048_576,
  '/v1/chat/completions': 2 * 1_048_576,
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

export function applyMiddleware(app: Hono<AppEnv>, config: ForgeServerConfig): ComposedMiddleware {
  applyCors(app, config)
  applySecurityHeaders(app, config)
  const effectiveAuth = applyAuthAndRbac(app, config)
  applyRateLimit(app, config)
  applyJsonBodySizeLimit(app, config)
  applyShutdownGuard(app, config)
  applyRequestMetrics(app, config)
  applyErrorHandler(app, config)

  return { effectiveAuth }
}

export function createDefaultRbacConfig(config: ForgeServerConfig): RBACConfig {
  if (config.rbac !== false && config.rbac !== undefined) {
    return config.rbac
  }

  return {
    extractRole: (c) => {
      const key = c.get('apiKey') as Record<string, unknown> | undefined
      const role = key?.['role']
      return typeof role === 'string'
        ? (role as ForgeRole)
        : 'operator'
    },
  }
}

function applyCors(app: Hono<AppEnv>, config: ForgeServerConfig): void {
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

function applySecurityHeaders(app: Hono<AppEnv>, config: ForgeServerConfig): void {
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

function applyAuthAndRbac(app: Hono<AppEnv>, config: ForgeServerConfig): AuthConfig | undefined {
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
  // variable is populated. Role defaults to `'operator'` when the API key
  // record predates the MC-S02 migration, so existing keys keep working
  // but admin-only endpoints (MCP registration, cluster management)
  // reject them. Hosts can opt out with `config.rbac = false`.
  if (config.rbac !== false) {
    app.use('/api/*', rbacMiddleware(createDefaultRbacConfig(config)))
  }

  return effectiveAuth
}

function applyRateLimit(app: Hono<AppEnv>, config: ForgeServerConfig): void {
  if (!config.rateLimit) {
    return
  }

  for (const path of getRateLimitedRoutePatterns(config)) {
    app.use(path, rateLimiterMiddleware(config.rateLimit))
  }
}

function getRateLimitedRoutePatterns(config: ForgeServerConfig): string[] {
  const paths = ['/api/*']
  if (config.a2a) {
    paths.push('/a2a', '/a2a/*')
  }
  if (config.openai?.enabled === true) {
    paths.push('/v1/*')
  }
  return paths
}

function applyJsonBodySizeLimit(app: Hono<AppEnv>, config: ForgeServerConfig): void {
  if (config.jsonBodyLimit === false) {
    return
  }

  const limits = resolveJsonBodyLimits(config.jsonBodyLimit)
  app.use('*', async (c, next) => {
    if (!shouldCheckJsonBodySize(c.req.method, c.req.header('content-type'))) {
      return next()
    }

    const maxBytes = resolveJsonBodyMaxBytes(c.req.path, limits)
    const contentLength = parseContentLength(c.req.header('content-length'))
    if (contentLength !== undefined && contentLength > maxBytes) {
      return c.json(
        {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `JSON request body too large (max ${maxBytes} bytes)`,
          },
        },
        413,
      )
    }

    if (contentLength === undefined) {
      const actualBytes = await getRequestBodyByteLength(c.req.raw)
      if (actualBytes > maxBytes) {
        return c.json(
          {
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              message: `JSON request body too large (max ${maxBytes} bytes)`,
            },
          },
          413,
        )
      }
    }

    return next()
  })
}

interface ResolvedJsonBodyLimits {
  defaultMaxBytes: number
  routeMaxBytes: Record<string, number>
}

function resolveJsonBodyLimits(config?: JsonBodyLimitConfig): ResolvedJsonBodyLimits {
  return {
    defaultMaxBytes: positiveIntegerOr(config?.defaultMaxBytes, DEFAULT_JSON_BODY_MAX_BYTES),
    routeMaxBytes: {
      ...DEFAULT_ROUTE_JSON_BODY_MAX_BYTES,
      ...sanitizeRouteMaxBytes(config?.routeMaxBytes),
    },
  }
}

function sanitizeRouteMaxBytes(routeMaxBytes?: Record<string, number>): Record<string, number> {
  if (!routeMaxBytes) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(routeMaxBytes)
      .filter(([path, bytes]) => path.length > 0 && Number.isInteger(bytes) && bytes > 0),
  )
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback
}

function shouldCheckJsonBodySize(method: string, contentType: string | undefined): boolean {
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
    return false
  }
  if (!contentType) {
    return false
  }
  const normalized = contentType.toLowerCase()
  return normalized.includes('application/json') || normalized.includes('+json')
}

function parseContentLength(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

async function getRequestBodyByteLength(request: Request): Promise<number> {
  try {
    return (await request.clone().arrayBuffer()).byteLength
  } catch {
    return 0
  }
}

function resolveJsonBodyMaxBytes(path: string, limits: ResolvedJsonBodyLimits): number {
  const exact = limits.routeMaxBytes[path]
  if (exact !== undefined) {
    return exact
  }

  let matchedBytes: number | undefined
  let matchedPrefixLength = -1
  for (const [pattern, bytes] of Object.entries(limits.routeMaxBytes)) {
    if (!pattern.endsWith('*')) {
      continue
    }
    const prefix = pattern.slice(0, -1)
    if (path.startsWith(prefix) && prefix.length > matchedPrefixLength) {
      matchedBytes = bytes
      matchedPrefixLength = prefix.length
    }
  }

  return matchedBytes ?? limits.defaultMaxBytes
}

function applyShutdownGuard(app: Hono<AppEnv>, config: ForgeServerConfig): void {
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

function applyRequestMetrics(app: Hono<AppEnv>, config: ForgeServerConfig): void {
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

function applyErrorHandler(app: Hono<AppEnv>, config: ForgeServerConfig): void {
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err)

    defaultLogger.error(`[ForgeServer] ${c.req.method} ${c.req.path}: ${message}`)
    config.metrics?.increment('http_errors_total', { path: c.req.path })
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      500,
    )
  })
}
