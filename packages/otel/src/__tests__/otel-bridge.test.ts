import { describe, it, expect, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEventBus, DzupEvent } from '@dzupagent/core'
import { DzupTracer } from '../tracer.js'
import { OTelBridge, InMemoryMetricSink } from '../otel-bridge.js'

describe('OTelBridge', () => {
  let bus: DzupEventBus
  let tracer: DzupTracer
  let sink: InMemoryMetricSink
  let bridge: OTelBridge

  beforeEach(() => {
    bus = createEventBus()
    tracer = new DzupTracer()
    sink = new InMemoryMetricSink()
    bridge = new OTelBridge({ tracer, metricSink: sink })
  })

  describe('attach / detach', () => {
    it('starts detached', () => {
      expect(bridge.isAttached).toBe(false)
    })

    it('attaches to event bus', () => {
      bridge.attach(bus)
      expect(bridge.isAttached).toBe(true)
    })

    it('detaches from event bus', () => {
      bridge.attach(bus)
      bridge.detach()
      expect(bridge.isAttached).toBe(false)
    })

    it('re-attach replaces previous subscription', () => {
      bridge.attach(bus)
      bridge.attach(bus) // should not double-subscribe
      expect(bridge.isAttached).toBe(true)

      bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
      // Should only count once, not twice
      expect(sink.getCounter('dzip_agent_runs_total', { agent_id: 'a1', status: 'started' })).toBe(1)
    })

    it('does not record after detach', () => {
      bridge.attach(bus)
      bridge.detach()

      bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
      expect(sink.getCounter('dzip_agent_runs_total', { agent_id: 'a1', status: 'started' })).toBe(0)
    })
  })

  describe('agent lifecycle metrics', () => {
    beforeEach(() => {
      bridge.attach(bus)
    })

    it('records agent:started counter', () => {
      bus.emit({ type: 'agent:started', agentId: 'code-gen', runId: 'r1' })

      expect(sink.getCounter('dzip_agent_runs_total', {
        agent_id: 'code-gen',
        status: 'started',
      })).toBe(1)
    })

    it('records agent:completed counter and duration histogram', () => {
      bus.emit({ type: 'agent:completed', agentId: 'code-gen', runId: 'r1', durationMs: 5000 })

      expect(sink.getCounter('dzip_agent_runs_total', {
        agent_id: 'code-gen',
        status: 'completed',
      })).toBe(1)

      const hist = sink.getHistogram('dzip_agent_duration_seconds', { agent_id: 'code-gen' })
      expect(hist).toHaveLength(1)
      expect(hist[0]).toBe(5) // 5000ms -> 5s
    })

    it('records agent:failed counter', () => {
      bus.emit({
        type: 'agent:failed',
        agentId: 'code-gen',
        runId: 'r1',
        errorCode: 'PROVIDER_UNAVAILABLE',
        message: 'API down',
      })

      expect(sink.getCounter('dzip_agent_errors_total', {
        agent_id: 'code-gen',
        error_code: 'PROVIDER_UNAVAILABLE',
      })).toBe(1)
    })
  })

  describe('tool lifecycle metrics', () => {
    beforeEach(() => {
      bridge.attach(bus)
    })

    it('records tool:called counter', () => {
      bus.emit({ type: 'tool:called', toolName: 'git_status', input: {} })
      expect(sink.getCounter('forge_tool_calls_total', { tool_name: 'git_status' })).toBe(1)
    })

    it('accumulates multiple calls', () => {
      bus.emit({ type: 'tool:called', toolName: 'read_file', input: {} })
      bus.emit({ type: 'tool:called', toolName: 'read_file', input: {} })
      bus.emit({ type: 'tool:called', toolName: 'read_file', input: {} })
      expect(sink.getCounter('forge_tool_calls_total', { tool_name: 'read_file' })).toBe(3)
    })

    it('records tool:result histogram', () => {
      bus.emit({ type: 'tool:result', toolName: 'git_diff', durationMs: 1500 })
      const hist = sink.getHistogram('forge_tool_duration_seconds', { tool_name: 'git_diff' })
      expect(hist).toHaveLength(1)
      expect(hist[0]).toBe(1.5)
    })

    it('records tool:error counter', () => {
      bus.emit({
        type: 'tool:error',
        toolName: 'write_file',
        errorCode: 'TOOL_EXECUTION_FAILED',
        message: 'Permission denied',
      })
      expect(sink.getCounter('forge_tool_errors_total', {
        tool_name: 'write_file',
        error_code: 'TOOL_EXECUTION_FAILED',
      })).toBe(1)
    })
  })

  describe('memory metrics', () => {
    beforeEach(() => {
      bridge.attach(bus)
    })

    it('records memory:written counter', () => {
      bus.emit({ type: 'memory:written', namespace: 'lessons', key: 'k1' })
      expect(sink.getCounter('forge_memory_writes_total', { namespace: 'lessons' })).toBe(1)
    })

    it('records memory:searched counter', () => {
      bus.emit({ type: 'memory:searched', namespace: 'conventions', query: 'api routes', resultCount: 3 })
      expect(sink.getCounter('forge_memory_searches_total', { namespace: 'conventions' })).toBe(1)
    })

    it('records memory:error counter', () => {
      bus.emit({ type: 'memory:error', namespace: 'facts', message: 'Store unavailable' })
      expect(sink.getCounter('forge_memory_errors_total', { namespace: 'facts' })).toBe(1)
    })
  })

  describe('budget metrics', () => {
    beforeEach(() => {
      bridge.attach(bus)
    })

    const usage = {
      tokensUsed: 5000,
      tokensLimit: 10000,
      costCents: 50,
      costLimitCents: 100,
      iterations: 3,
      iterationsLimit: 10,
      percent: 50,
    }

    it('records budget:warning counter', () => {
      bus.emit({ type: 'budget:warning', level: 'warn', usage })
      expect(sink.getCounter('forge_budget_warnings_total', { level: 'warn' })).toBe(1)
    })

    it('records budget:exceeded counter', () => {
      bus.emit({ type: 'budget:exceeded', reason: 'tokens', usage })
      expect(sink.getCounter('forge_budget_exceeded_total', { reason: 'tokens' })).toBe(1)
    })
  })

  describe('pipeline metrics', () => {
    beforeEach(() => {
      bridge.attach(bus)
    })

    it('records pipeline:phase_changed counter', () => {
      bus.emit({ type: 'pipeline:phase_changed', phase: 'gen_backend', previousPhase: 'plan' })
      expect(sink.getCounter('forge_pipeline_phase_transitions_total', {
        from: 'plan',
        to: 'gen_backend',
      })).toBe(1)
    })

    it('records pipeline:validation_failed counter', () => {
      bus.emit({ type: 'pipeline:validation_failed', phase: 'validate', errors: ['Type errors'] })
      expect(sink.getCounter('forge_pipeline_validation_failures_total', { phase: 'validate' })).toBe(1)
    })
  })

  describe('approval metrics', () => {
    beforeEach(() => {
      bridge.attach(bus)
    })

    it('records approval:requested counter', () => {
      bus.emit({ type: 'approval:requested', runId: 'r1', plan: {} })
      expect(sink.getCounter('forge_approval_requests_total', { status: 'requested' })).toBe(1)
    })

    it('records approval:granted counter', () => {
      bus.emit({ type: 'approval:granted', runId: 'r1' })
      expect(sink.getCounter('forge_approval_requests_total', { status: 'granted' })).toBe(1)
    })

    it('records approval:rejected counter', () => {
      bus.emit({ type: 'approval:rejected', runId: 'r1', reason: 'unsafe' })
      expect(sink.getCounter('forge_approval_requests_total', { status: 'rejected' })).toBe(1)
    })
  })

  describe('MCP metrics', () => {
    beforeEach(() => {
      bridge.attach(bus)
    })

    it('records mcp:connected counter', () => {
      bus.emit({ type: 'mcp:connected', serverName: 'memory-server', toolCount: 5 })
      expect(sink.getCounter('forge_mcp_connections_total', {
        server: 'memory-server',
        status: 'connected',
      })).toBe(1)
    })

    it('records mcp:disconnected counter', () => {
      bus.emit({ type: 'mcp:disconnected', serverName: 'memory-server' })
      expect(sink.getCounter('forge_mcp_connections_total', {
        server: 'memory-server',
        status: 'disconnected',
      })).toBe(1)
    })
  })

  describe('provider metrics', () => {
    beforeEach(() => {
      bridge.attach(bus)
    })

    it('records provider:failed counter', () => {
      bus.emit({ type: 'provider:failed', tier: 'primary', provider: 'anthropic', message: '503' })
      expect(sink.getCounter('forge_provider_failures_total', {
        provider: 'anthropic',
        tier: 'primary',
      })).toBe(1)
    })

    it('records provider:circuit_opened gauge', () => {
      bus.emit({ type: 'provider:circuit_opened', provider: 'openai' })
      expect(sink.getGauge('forge_provider_circuit_state', { provider: 'openai' })).toBe(1)
    })

    it('records provider:circuit_closed gauge', () => {
      bus.emit({ type: 'provider:circuit_opened', provider: 'openai' })
      bus.emit({ type: 'provider:circuit_closed', provider: 'openai' })
      expect(sink.getGauge('forge_provider_circuit_state', { provider: 'openai' })).toBe(0)
    })
  })

  describe('events with no metrics', () => {
    beforeEach(() => {
      bridge.attach(bus)
    })

    it('hook:error produces no metrics (but does not throw)', () => {
      // Should not throw
      bus.emit({ type: 'hook:error', hookName: 'beforeToolCall', message: 'oops' })
      // No specific metric to check; just verify it doesn't crash
    })

    it('plugin:registered produces no metrics', () => {
      bus.emit({ type: 'plugin:registered', pluginName: 'my-plugin' })
    })
  })

  describe('ignoreEvents', () => {
    it('skips events in the ignore list', () => {
      const filtered = new OTelBridge({
        tracer,
        metricSink: sink,
        ignoreEvents: ['tool:called', 'memory:searched'],
      })
      filtered.attach(bus)

      bus.emit({ type: 'tool:called', toolName: 'git_status', input: {} })
      bus.emit({ type: 'memory:searched', namespace: 'ns', query: 'q', resultCount: 0 })
      bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })

      expect(sink.getCounter('forge_tool_calls_total', { tool_name: 'git_status' })).toBe(0)
      expect(sink.getCounter('forge_memory_searches_total', { namespace: 'ns' })).toBe(0)
      // agent:started should still be recorded
      expect(sink.getCounter('dzip_agent_runs_total', { agent_id: 'a1', status: 'started' })).toBe(1)
    })
  })

  describe('enableMetrics = false', () => {
    it('does not record metrics when disabled', () => {
      const noMetricsBridge = new OTelBridge({
        tracer,
        metricSink: sink,
        enableMetrics: false,
      })
      noMetricsBridge.attach(bus)

      bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
      expect(sink.getCounter('dzip_agent_runs_total', { agent_id: 'a1', status: 'started' })).toBe(0)
    })
  })

  describe('InMemoryMetricSink', () => {
    it('accumulates counter increments', () => {
      sink.increment('test_counter', { k: 'v' })
      sink.increment('test_counter', { k: 'v' })
      sink.increment('test_counter', { k: 'v' }, 5)
      expect(sink.getCounter('test_counter', { k: 'v' })).toBe(7)
    })

    it('records histogram observations', () => {
      sink.observe('test_hist', { k: 'v' }, 1.5)
      sink.observe('test_hist', { k: 'v' }, 2.5)
      expect(sink.getHistogram('test_hist', { k: 'v' })).toEqual([1.5, 2.5])
    })

    it('sets gauge values', () => {
      sink.gauge('test_gauge', { k: 'v' }, 10)
      expect(sink.getGauge('test_gauge', { k: 'v' })).toBe(10)
      sink.gauge('test_gauge', { k: 'v' }, 20)
      expect(sink.getGauge('test_gauge', { k: 'v' })).toBe(20)
    })

    it('resets all metrics', () => {
      sink.increment('c', {})
      sink.observe('h', {}, 1)
      sink.gauge('g', {}, 5)
      sink.reset()
      expect(sink.getCounter('c', {})).toBe(0)
      expect(sink.getHistogram('h', {})).toEqual([])
      expect(sink.getGauge('g', {})).toBeUndefined()
    })

    it('distinguishes metrics by labels', () => {
      sink.increment('c', { env: 'prod' })
      sink.increment('c', { env: 'dev' })
      expect(sink.getCounter('c', { env: 'prod' })).toBe(1)
      expect(sink.getCounter('c', { env: 'dev' })).toBe(1)
    })
  })
})
