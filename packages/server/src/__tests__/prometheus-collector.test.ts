import { describe, it, expect, beforeEach } from 'vitest'
import { PrometheusMetricsCollector } from '../metrics/prometheus-collector.js'

describe('PrometheusMetricsCollector', () => {
  let collector: PrometheusMetricsCollector

  beforeEach(() => {
    collector = new PrometheusMetricsCollector()
  })

  describe('counter increment and render', () => {
    it('increments a counter and renders it in Prometheus format', () => {
      collector.increment('forge_routing_total', { tier: 'chat' })
      collector.increment('forge_routing_total', { tier: 'chat' })
      collector.increment('forge_routing_total', { tier: 'codegen' })

      const output = collector.render()
      expect(output).toContain('# HELP forge_routing_total')
      expect(output).toContain('# TYPE forge_routing_total counter')
      expect(output).toContain('forge_routing_total{tier="chat"} 2')
      expect(output).toContain('forge_routing_total{tier="codegen"} 1')
    })

    it('increments a counter without labels', () => {
      collector.increment('forge_errors_total')
      collector.increment('forge_errors_total')
      collector.increment('forge_errors_total')

      const output = collector.render()
      expect(output).toContain('forge_errors_total 3')
    })

    it('increments by a custom amount', () => {
      collector.increment('forge_tokens_total', { model: 'gpt-5' }, 150)

      const output = collector.render()
      expect(output).toContain('forge_tokens_total{model="gpt-5"} 150')
    })
  })

  describe('histogram observe and render', () => {
    it('observes values and renders sum, count, and buckets', () => {
      collector.observe('forge_run_duration_ms', 75, { tier: 'chat' })
      collector.observe('forge_run_duration_ms', 200, { tier: 'chat' })
      collector.observe('forge_run_duration_ms', 3000, { tier: 'chat' })

      const output = collector.render()
      expect(output).toContain('# HELP forge_run_duration_ms')
      expect(output).toContain('# TYPE forge_run_duration_ms histogram')

      // Bucket checks: 75 fits in le=100, 200 fits in le=250, 3000 fits in le=5000
      expect(output).toContain('forge_run_duration_ms_bucket{tier="chat",le="50"} 0')
      expect(output).toContain('forge_run_duration_ms_bucket{tier="chat",le="100"} 1')
      expect(output).toContain('forge_run_duration_ms_bucket{tier="chat",le="250"} 2')
      expect(output).toContain('forge_run_duration_ms_bucket{tier="chat",le="500"} 2')
      expect(output).toContain('forge_run_duration_ms_bucket{tier="chat",le="1000"} 2')
      expect(output).toContain('forge_run_duration_ms_bucket{tier="chat",le="2500"} 2')
      expect(output).toContain('forge_run_duration_ms_bucket{tier="chat",le="5000"} 3')
      expect(output).toContain('forge_run_duration_ms_bucket{tier="chat",le="10000"} 3')
      expect(output).toContain('forge_run_duration_ms_bucket{tier="chat",le="+Inf"} 3')

      // Sum and count
      expect(output).toContain('forge_run_duration_ms_sum{tier="chat"} 3275')
      expect(output).toContain('forge_run_duration_ms_count{tier="chat"} 3')
    })

    it('updates histogram buckets cumulatively across repeated observations', () => {
      collector.observe('forge_latency_ms', 10)
      collector.observe('forge_latency_ms', 60)

      const firstRender = collector.render()
      expect(firstRender).toContain('forge_latency_ms_bucket{le="50"} 1')
      expect(firstRender).toContain('forge_latency_ms_bucket{le="100"} 2')
      expect(firstRender).toContain('forge_latency_ms_bucket{le="+Inf"} 2')
      expect(firstRender).toContain('forge_latency_ms_sum 70')
      expect(firstRender).toContain('forge_latency_ms_count 2')

      collector.observe('forge_latency_ms', 2600)
      collector.observe('forge_latency_ms', 12000)

      const secondRender = collector.render()
      expect(secondRender).toContain('forge_latency_ms_bucket{le="50"} 1')
      expect(secondRender).toContain('forge_latency_ms_bucket{le="100"} 2')
      expect(secondRender).toContain('forge_latency_ms_bucket{le="250"} 2')
      expect(secondRender).toContain('forge_latency_ms_bucket{le="500"} 2')
      expect(secondRender).toContain('forge_latency_ms_bucket{le="1000"} 2')
      expect(secondRender).toContain('forge_latency_ms_bucket{le="2500"} 2')
      expect(secondRender).toContain('forge_latency_ms_bucket{le="5000"} 3')
      expect(secondRender).toContain('forge_latency_ms_bucket{le="10000"} 3')
      expect(secondRender).toContain('forge_latency_ms_bucket{le="+Inf"} 4')
      expect(secondRender).toContain('forge_latency_ms_sum 14670')
      expect(secondRender).toContain('forge_latency_ms_count 4')
    })

    it('observes histogram without labels', () => {
      collector.observe('forge_latency_ms', 42)

      const output = collector.render()
      expect(output).toContain('forge_latency_ms_bucket{le="50"} 1')
      expect(output).toContain('forge_latency_ms_bucket{le="+Inf"} 1')
      expect(output).toContain('forge_latency_ms_sum 42')
      expect(output).toContain('forge_latency_ms_count 1')
    })
  })

  describe('gauge set and render', () => {
    it('sets a gauge value and renders it', () => {
      collector.gauge('forge_active_runs', 5, { agent: 'builder' })
      collector.gauge('forge_active_runs', 3, { agent: 'builder' })

      const output = collector.render()
      expect(output).toContain('# HELP forge_active_runs')
      expect(output).toContain('# TYPE forge_active_runs gauge')
      expect(output).toContain('forge_active_runs{agent="builder"} 3')
      // Should NOT contain the old value
      expect(output).not.toContain('forge_active_runs{agent="builder"} 5')
    })

    it('sets a gauge without labels', () => {
      collector.gauge('forge_queue_depth', 10)

      const output = collector.render()
      expect(output).toContain('forge_queue_depth 10')
    })
  })

  describe('multiple labels', () => {
    it('sorts label keys alphabetically in output', () => {
      collector.increment('http_requests_total', {
        status: '200',
        method: 'GET',
        path: '/api/runs',
      })

      const output = collector.render()
      // Labels should be sorted: method, path, status
      expect(output).toContain(
        'http_requests_total{method="GET",path="/api/runs",status="200"} 1',
      )
    })

    it('handles different label sets as separate series', () => {
      collector.increment('http_requests_total', { method: 'GET', status: '200' })
      collector.increment('http_requests_total', { method: 'POST', status: '201' })
      collector.increment('http_requests_total', { method: 'GET', status: '200' })

      const output = collector.render()
      expect(output).toContain('http_requests_total{method="GET",status="200"} 2')
      expect(output).toContain('http_requests_total{method="POST",status="201"} 1')
    })
  })

  describe('reset', () => {
    it('clears all metrics', () => {
      collector.increment('forge_counter', { a: '1' })
      collector.observe('forge_histogram', 100, { b: '2' })
      collector.gauge('forge_gauge', 42, { c: '3' })

      expect(collector.render()).not.toBe('')

      collector.reset()

      expect(collector.render()).toBe('')
    })
  })

  describe('exposition format correctness', () => {
    it('groups metrics by name with HELP and TYPE headers', () => {
      collector.register('forge_routing_total', 'counter', 'Number of run routing decisions')
      collector.increment('forge_routing_total', { tier: 'chat' }, 42)

      const output = collector.render()
      const lines = output.split('\n')

      expect(lines[0]).toBe('# HELP forge_routing_total Number of run routing decisions')
      expect(lines[1]).toBe('# TYPE forge_routing_total counter')
      expect(lines[2]).toBe('forge_routing_total{tier="chat"} 42')
    })

    it('uses metric name as default help text when not registered', () => {
      collector.increment('my_counter')

      const output = collector.render()
      expect(output).toContain('# HELP my_counter my_counter')
    })

    it('does not have trailing newline after last metric block', () => {
      collector.increment('a_counter')
      const output = collector.render()
      expect(output.endsWith('\n')).toBe(false)
    })
  })

  describe('empty render', () => {
    it('returns empty string when no metrics have been recorded', () => {
      expect(collector.render()).toBe('')
    })
  })

  describe('parent class compatibility', () => {
    it('keeps parent class toJSON() in sync', () => {
      collector.increment('forge_counter', { tier: 'chat' })
      collector.observe('forge_hist', 100, { tier: 'chat' })
      collector.gauge('forge_gauge', 42)

      const json = collector.toJSON()
      expect(json.length).toBe(3)
    })

    it('parent get() returns the value for a metric', () => {
      collector.increment('forge_counter', { tier: 'chat' })
      collector.increment('forge_counter', { tier: 'chat' })

      expect(collector.get('forge_counter', { tier: 'chat' })).toBe(2)
    })

    it('parent reset also clears prometheus state', () => {
      collector.increment('forge_counter')
      collector.reset()

      expect(collector.get('forge_counter')).toBeUndefined()
      expect(collector.render()).toBe('')
    })
  })

  describe('mixed metric types in same render', () => {
    it('renders counters, histograms, and gauges together', () => {
      collector.increment('forge_requests', { method: 'GET' }, 10)
      collector.observe('forge_latency', 150)
      collector.gauge('forge_connections', 5)

      const output = collector.render()

      // Counter section
      expect(output).toContain('# TYPE forge_requests counter')
      expect(output).toContain('forge_requests{method="GET"} 10')

      // Histogram section
      expect(output).toContain('# TYPE forge_latency histogram')
      expect(output).toContain('forge_latency_sum 150')
      expect(output).toContain('forge_latency_count 1')

      // Gauge section
      expect(output).toContain('# TYPE forge_connections gauge')
      expect(output).toContain('forge_connections 5')
    })
  })
})
