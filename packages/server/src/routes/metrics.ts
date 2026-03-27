/**
 * Prometheus /metrics route.
 *
 * Serves metrics in Prometheus text exposition format (text/plain; version=0.0.4).
 * Only mounted when the configured MetricsCollector has a `render()` method
 * (i.e., is a PrometheusMetricsCollector).
 */
import { Hono } from 'hono'
import type { PrometheusMetricsCollector } from '../metrics/prometheus-collector.js'

export interface MetricsRouteConfig {
  collector: PrometheusMetricsCollector
}

/**
 * Create a Hono sub-app that serves the Prometheus metrics endpoint.
 *
 * GET / — renders all tracked metrics in Prometheus text exposition format.
 */
export function createMetricsRoute(config: MetricsRouteConfig): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    const body = config.collector.render()
    return c.text(body, 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    })
  })

  return app
}
