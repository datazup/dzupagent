import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'

import { createForgeApp } from '../../app.js'
import { PrometheusMetricsCollector } from '../../metrics/prometheus-collector.js'
import type { ForgeServerConfig } from '../types.js'

function baseConfig(overrides: Partial<ForgeServerConfig> = {}): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    auth: { mode: 'none' },
    ...overrides,
  }
}

function collectorWithSample(): PrometheusMetricsCollector {
  const collector = new PrometheusMetricsCollector()
  collector.increment('dzupagent_composition_test_total')
  return collector
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('composition Prometheus metrics route', () => {
  it('does not mount /metrics by default when no access policy is configured', async () => {
    const app = createForgeApp(baseConfig({
      metrics: collectorWithSample(),
    }))

    const res = await app.request('/metrics')

    expect(res.status).toBe(404)
  })

  it('does not mount /metrics when the endpoint is disabled explicitly', async () => {
    const app = createForgeApp(baseConfig({
      metrics: collectorWithSample(),
      prometheusMetrics: { access: { mode: 'disabled' } },
    }))

    const res = await app.request('/metrics')

    expect(res.status).toBe(404)
  })

  it('mounts protected /metrics and accepts valid credentials', async () => {
    const app = createForgeApp(baseConfig({
      metrics: collectorWithSample(),
      prometheusMetrics: { access: { mode: 'token', token: 'scrape-token' } },
    }))

    const res = await app.request('/metrics', {
      headers: { Authorization: 'Bearer scrape-token' },
    })
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).toContain('dzupagent_composition_test_total')
  })

  it('denies /metrics when protected credentials are missing or invalid', async () => {
    const app = createForgeApp(baseConfig({
      metrics: collectorWithSample(),
      prometheusMetrics: { access: { mode: 'token', token: 'scrape-token' } },
    }))

    const missing = await app.request('/metrics')
    const invalid = await app.request('/metrics', {
      headers: { Authorization: 'Bearer wrong-token' },
    })

    expect(missing.status).toBe(401)
    expect(invalid.status).toBe(401)
  })

  it('mounts public /metrics only through the unsafe opt-in', async () => {
    const app = createForgeApp(baseConfig({
      metrics: collectorWithSample(),
      prometheusMetrics: { access: { mode: 'unsafe-public', reason: 'local dev scrape' } },
    }))

    const res = await app.request('/metrics')

    expect(res.status).toBe(200)
  })
})
