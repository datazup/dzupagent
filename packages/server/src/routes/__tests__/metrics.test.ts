import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'

import { PrometheusMetricsCollector } from '../../metrics/prometheus-collector.js'
import { createMetricsRoute } from '../metrics.js'

function collectorWithSample(): PrometheusMetricsCollector {
  const collector = new PrometheusMetricsCollector()
  collector.increment('dzupagent_test_total')
  return collector
}

describe('Prometheus metrics route', () => {
  it('renders Prometheus text when token credentials are valid', async () => {
    const app = createMetricsRoute({
      collector: collectorWithSample(),
      access: { mode: 'token', token: 'scrape-token' },
    })

    const res = await app.request('/', {
      headers: { Authorization: 'Bearer scrape-token' },
    })
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain; version=0.0.4')
    expect(body).toContain('dzupagent_test_total')
  })

  it('denies missing token credentials', async () => {
    const app = createMetricsRoute({
      collector: collectorWithSample(),
      access: { mode: 'token', token: 'scrape-token' },
    })

    const res = await app.request('/')
    const body = await res.json() as { error: { code: string } }

    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('denies invalid token credentials', async () => {
    const app = createMetricsRoute({
      collector: collectorWithSample(),
      access: { mode: 'token', token: 'scrape-token' },
    })

    const res = await app.request('/', {
      headers: { Authorization: 'Bearer wrong-token' },
    })

    expect(res.status).toBe(401)
  })

  it('supports custom header tokens', async () => {
    const app = createMetricsRoute({
      collector: collectorWithSample(),
      access: { mode: 'token', token: 'scrape-token', headerName: 'x-metrics-token' },
    })

    const res = await app.request('/', {
      headers: { 'x-metrics-token': 'scrape-token' },
    })

    expect(res.status).toBe(200)
  })

  it('supports injected middleware guards', async () => {
    const app = createMetricsRoute({
      collector: collectorWithSample(),
      access: {
        mode: 'middleware',
        middleware: async (c, next) => {
          if (c.req.header('x-internal-scrape') !== 'true') {
            return c.text('forbidden', 403)
          }
          await next()
        },
      },
    })

    const denied = await app.request('/')
    const allowed = await app.request('/', {
      headers: { 'x-internal-scrape': 'true' },
    })

    expect(denied.status).toBe(403)
    expect(allowed.status).toBe(200)
  })

  it('allows unsafe public exposure only when explicitly configured', async () => {
    const app = createMetricsRoute({
      collector: collectorWithSample(),
      access: { mode: 'unsafe-public', reason: 'local dev scrape' },
    })

    const res = await app.request('/')

    expect(res.status).toBe(200)
  })

  it('does not add a route guard for disabled access when used directly', async () => {
    const app = new Hono()
    app.route('/metrics', createMetricsRoute({
      collector: collectorWithSample(),
      access: { mode: 'disabled' },
    }))

    const res = await app.request('/metrics')

    expect(res.status).toBe(404)
  })
})
