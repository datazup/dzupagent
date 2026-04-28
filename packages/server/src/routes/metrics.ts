/**
 * Prometheus /metrics route.
 *
 * Serves metrics in Prometheus text exposition format (text/plain; version=0.0.4).
 * Only mounted when the configured MetricsCollector has a `render()` method
 * (i.e., is a PrometheusMetricsCollector).
 */
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import type { PrometheusMetricsCollector } from '../metrics/prometheus-collector.js'

export type MetricsAccessControl =
  | {
      /**
       * Require a bearer token in the `Authorization` header, or an exact token
       * match in `headerName` when a custom header is configured.
       */
      mode: 'token'
      token: string
      headerName?: string
    }
  | {
      /** Delegate framework-level access control to host-supplied middleware. */
      mode: 'middleware'
      middleware: MiddlewareHandler
    }
  | {
      /**
       * Explicit unsafe/development opt-in for public Prometheus scraping.
       * Production hosts should prefer `token` or `middleware`.
       */
      mode: 'unsafe-public'
      reason?: string
    }
  | {
      /** Do not mount `/metrics`, even when the collector supports rendering. */
      mode: 'disabled'
    }

export interface MetricsRouteConfig {
  collector: PrometheusMetricsCollector
  access: MetricsAccessControl
}

/**
 * Create a Hono sub-app that serves the Prometheus metrics endpoint.
 *
 * GET / — renders all tracked metrics in Prometheus text exposition format.
 */
export function createMetricsRoute(config: MetricsRouteConfig): Hono {
  const app = new Hono()

  if (config.access.mode === 'disabled') {
    return app
  }

  const guard = createMetricsAccessGuard(config.access)
  if (guard) {
    app.use('*', guard)
  }

  app.get('/', (c) => {
    const body = config.collector.render()
    return c.text(body, 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    })
  })

  return app
}

function createMetricsAccessGuard(access: MetricsAccessControl): MiddlewareHandler | undefined {
  if (access.mode === 'unsafe-public' || access.mode === 'disabled') {
    return undefined
  }

  if (access.mode === 'middleware') {
    return access.middleware
  }

  if (access.token.length === 0) {
    throw new Error('Prometheus metrics token must not be empty')
  }

  return async (c, next) => {
    const supplied = readMetricsToken(c.req.raw.headers, access)
    if (!constantTimeEquals(supplied, access.token)) {
      return c.json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Metrics credentials are missing or invalid',
        },
      }, 401)
    }

    await next()
  }
}

function readMetricsToken(headers: Headers, access: Extract<MetricsAccessControl, { mode: 'token' }>): string | null {
  if (access.headerName) {
    return headers.get(access.headerName)
  }

  const authorization = headers.get('authorization')
  const bearerPrefix = 'Bearer '
  if (!authorization?.startsWith(bearerPrefix)) {
    return null
  }

  return authorization.slice(bearerPrefix.length)
}

function constantTimeEquals(actual: string | null, expected: string): boolean {
  const actualValue = actual ?? ''
  let mismatch = actualValue.length ^ expected.length
  const length = Math.max(actualValue.length, expected.length)

  for (let index = 0; index < length; index += 1) {
    mismatch |= (actualValue.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0)
  }

  return mismatch === 0
}
