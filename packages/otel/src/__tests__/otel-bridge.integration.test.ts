import { describe, it, expect, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'
import { DzupTracer, OTelBridge, InMemoryMetricSink, getAllMetricNames } from '../index.js'

describe('OTelBridge integration', () => {
  let bus: DzupEventBus
  let tracer: DzupTracer
  let sink: InMemoryMetricSink
  let bridge: OTelBridge

  beforeEach(() => {
    bus = createEventBus()
    tracer = new DzupTracer()
    sink = new InMemoryMetricSink()
    bridge = new OTelBridge({ tracer, metricSink: sink })
    bridge.attach(bus)
  })

  it('translates a mixed event stream into metrics across extracted fragments', () => {
    bus.emit({ type: 'agent:started', agentId: 'agent-1', runId: 'run-1' })
    bus.emit({ type: 'agent:completed', agentId: 'agent-1', runId: 'run-1', durationMs: 2500 })
    bus.emit({ type: 'tool:called', toolName: 'read_file', input: { path: 'README.md' } })
    bus.emit({ type: 'tool:result', toolName: 'read_file', durationMs: 1500 })
    bus.emit({ type: 'memory:written', namespace: 'notes', key: 'k1' })
    bus.emit({ type: 'pipeline:run_started', pipelineId: 'pipe-1', runId: 'run-2' })
    bus.emit({ type: 'pipeline:node_completed', pipelineId: 'pipe-1', nodeId: 'node-1', durationMs: 375 })
    bus.emit({
      type: 'vector:search_completed',
      provider: 'qdrant',
      collection: 'docs',
      latencyMs: 40,
      resultCount: 7,
    })
    bus.emit({ type: 'agent:stop_reason', agentId: 'agent-1', reason: 'budget', iterations: 8, toolStats: [] })

    expect(sink.getCounter('dzip_agent_runs_total', {
      agent_id: 'agent-1',
      status: 'started',
    })).toBe(1)
    expect(sink.getCounter('dzip_agent_runs_total', {
      agent_id: 'agent-1',
      status: 'completed',
    })).toBe(1)
    expect(sink.getHistogram('dzip_agent_duration_seconds', { agent_id: 'agent-1' })).toEqual([2.5])

    expect(sink.getCounter('forge_tool_calls_total', { tool_name: 'read_file' })).toBe(1)
    expect(sink.getHistogram('forge_tool_duration_seconds', { tool_name: 'read_file' })).toEqual([1.5])

    expect(sink.getCounter('forge_memory_writes_total', { namespace: 'notes' })).toBe(1)

    expect(sink.getCounter('forge_pipeline_runs_total', {
      pipeline_id: 'pipe-1',
      status: 'started',
    })).toBe(1)
    expect(sink.getHistogram('forge_pipeline_node_duration_seconds', {
      pipeline_id: 'pipe-1',
      node_id: 'node-1',
    })).toEqual([0.375])

    expect(sink.getCounter('forge_vector_searches_total', {
      provider: 'qdrant',
      collection: 'docs',
    })).toBe(1)
    expect(sink.getHistogram('forge_vector_search_duration_seconds', {
      provider: 'qdrant',
      collection: 'docs',
    })).toEqual([0.04])
    expect(sink.getHistogram('forge_vector_search_result_count', {
      provider: 'qdrant',
      collection: 'docs',
    })).toEqual([7])

    expect(sink.getCounter('dzip_agent_stop_total', {
      agent_id: 'agent-1',
      reason: 'budget',
    })).toBe(1)

    const metricNames = getAllMetricNames()
    expect(metricNames).toEqual(expect.arrayContaining([
      'dzip_agent_runs_total',
      'forge_tool_calls_total',
      'forge_memory_writes_total',
      'forge_pipeline_runs_total',
      'forge_vector_search_result_count',
      'dzip_agent_stop_total',
    ]))
  })

  it('stops recording after detach without changing the public API contract', () => {
    bus.emit({ type: 'agent:started', agentId: 'agent-2', runId: 'run-3' })
    bridge.detach()
    bus.emit({ type: 'agent:started', agentId: 'agent-2', runId: 'run-4' })

    expect(sink.getCounter('dzip_agent_runs_total', {
      agent_id: 'agent-2',
      status: 'started',
    })).toBe(1)
    expect(bridge.isAttached).toBe(false)
  })
})
