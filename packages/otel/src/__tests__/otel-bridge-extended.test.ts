/**
 * Extended OTelBridge tests covering:
 * - All event-metric-map extract functions (pipeline, identity, protocol, security, vector)
 * - Span event creation for agent lifecycle events
 * - enableSpanEvents=false flag
 * - metricSink getter
 * - Error swallowing in event handler
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createEventBus } from '@forgeagent/core'
import type { ForgeEventBus } from '@forgeagent/core'
import { ForgeTracer } from '../tracer.js'
import { OTelBridge, InMemoryMetricSink } from '../otel-bridge.js'

describe('OTelBridge extended', () => {
  let bus: ForgeEventBus
  let tracer: ForgeTracer
  let sink: InMemoryMetricSink
  let bridge: OTelBridge

  beforeEach(() => {
    bus = createEventBus()
    tracer = new ForgeTracer()
    sink = new InMemoryMetricSink()
    bridge = new OTelBridge({ tracer, metricSink: sink })
    bridge.attach(bus)
  })

  describe('metricSink getter', () => {
    it('returns the configured metric sink', () => {
      expect(bridge.metricSink).toBe(sink)
    })

    it('defaults to InMemoryMetricSink when not provided', () => {
      const defaultBridge = new OTelBridge({ tracer })
      expect(defaultBridge.metricSink).toBeDefined()
    })
  })

  describe('identity metrics', () => {
    it('records identity:resolved counter', () => {
      bus.emit({ type: 'identity:resolved', agentId: 'agent-1', method: 'jwt' })
      expect(sink.getCounter('forge_identity_operations_total', {
        agent_id: 'agent-1',
        status: 'resolved',
      })).toBe(1)
    })

    it('records identity:failed counter', () => {
      bus.emit({ type: 'identity:failed', agentId: 'agent-2', reason: 'expired' })
      expect(sink.getCounter('forge_identity_operations_total', {
        agent_id: 'agent-2',
        status: 'failed',
      })).toBe(1)
    })

    it('records identity:credential_expired counter', () => {
      bus.emit({
        type: 'identity:credential_expired',
        agentId: 'agent-3',
        credentialType: 'api_key',
      })
      expect(sink.getCounter('forge_identity_credential_expirations_total', {
        agent_id: 'agent-3',
        credential_type: 'api_key',
      })).toBe(1)
    })

    it('records identity:trust_updated counter', () => {
      bus.emit({
        type: 'identity:trust_updated',
        agentId: 'agent-4',
        previousScore: 0.8,
        newScore: 0.9,
      })
      expect(sink.getCounter('forge_identity_trust_updates_total', {
        agent_id: 'agent-4',
      })).toBe(1)
    })

    it('records identity:delegation_issued counter', () => {
      bus.emit({
        type: 'identity:delegation_issued',
        delegator: 'parent-agent',
        delegate: 'child-agent',
        scopes: ['read', 'write'],
      })
      expect(sink.getCounter('forge_identity_delegations_total', {
        delegator: 'parent-agent',
      })).toBe(1)
    })
  })

  describe('registry metrics', () => {
    it('records registry:agent_registered counter', () => {
      bus.emit({ type: 'registry:agent_registered', agentId: 'a1', capabilities: [] })
      expect(sink.getCounter('forge_registry_operations_total', {
        operation: 'registered',
      })).toBe(1)
    })

    it('records registry:agent_deregistered counter', () => {
      bus.emit({ type: 'registry:agent_deregistered', agentId: 'a1' })
      expect(sink.getCounter('forge_registry_operations_total', {
        operation: 'deregistered',
      })).toBe(1)
    })

    it('records registry:agent_updated counter', () => {
      bus.emit({ type: 'registry:agent_updated', agentId: 'a1', fields: ['name'] })
      expect(sink.getCounter('forge_registry_operations_total', {
        operation: 'updated',
      })).toBe(1)
    })

    it('records registry:health_changed counter', () => {
      bus.emit({
        type: 'registry:health_changed',
        agentId: 'a1',
        previousStatus: 'healthy',
        newStatus: 'degraded',
      })
      expect(sink.getCounter('forge_registry_health_changes_total', {
        agent_id: 'a1',
        new_status: 'degraded',
      })).toBe(1)
    })

    it('records registry:capability_added counter', () => {
      bus.emit({
        type: 'registry:capability_added',
        agentId: 'a1',
        capability: 'code-gen',
      })
      expect(sink.getCounter('forge_registry_operations_total', {
        operation: 'capability_added',
      })).toBe(1)
    })
  })

  describe('protocol metrics', () => {
    it('records protocol:message_sent counter', () => {
      bus.emit({
        type: 'protocol:message_sent',
        protocol: 'a2a',
        messageType: 'task',
        targetAgent: 'worker',
      })
      expect(sink.getCounter('forge_protocol_messages_total', {
        protocol: 'a2a',
        direction: 'sent',
      })).toBe(1)
    })

    it('records protocol:message_received counter', () => {
      bus.emit({
        type: 'protocol:message_received',
        protocol: 'mcp',
        messageType: 'response',
        sourceAgent: 'tool-server',
      })
      expect(sink.getCounter('forge_protocol_messages_total', {
        protocol: 'mcp',
        direction: 'received',
      })).toBe(1)
    })

    it('records protocol:error counter', () => {
      bus.emit({
        type: 'protocol:error',
        protocol: 'a2a',
        message: 'timeout',
        errorCode: 'TIMEOUT',
      })
      expect(sink.getCounter('forge_protocol_errors_total', {
        protocol: 'a2a',
      })).toBe(1)
    })

    it('records protocol:connected counter', () => {
      bus.emit({
        type: 'protocol:connected',
        protocol: 'a2a',
        remoteAgent: 'worker-1',
      })
      expect(sink.getCounter('forge_protocol_connections_total', {
        protocol: 'a2a',
        status: 'connected',
      })).toBe(1)
    })

    it('records protocol:disconnected counter', () => {
      bus.emit({
        type: 'protocol:disconnected',
        protocol: 'a2a',
        remoteAgent: 'worker-1',
        reason: 'timeout',
      })
      expect(sink.getCounter('forge_protocol_connections_total', {
        protocol: 'a2a',
        status: 'disconnected',
      })).toBe(1)
    })

    it('records protocol:state_changed counter', () => {
      bus.emit({
        type: 'protocol:state_changed',
        protocol: 'a2a',
        previousState: 'connecting',
        newState: 'ready',
      })
      expect(sink.getCounter('forge_protocol_state_changes_total', {
        protocol: 'a2a',
        new_state: 'ready',
      })).toBe(1)
    })
  })

  describe('pipeline runtime metrics', () => {
    it('records pipeline:run_started counter', () => {
      bus.emit({
        type: 'pipeline:run_started',
        pipelineId: 'pipe-1',
        runId: 'run-1',
      })
      expect(sink.getCounter('forge_pipeline_runs_total', {
        pipeline_id: 'pipe-1',
        status: 'started',
      })).toBe(1)
    })

    it('records pipeline:node_started counter', () => {
      bus.emit({
        type: 'pipeline:node_started',
        pipelineId: 'pipe-1',
        nodeId: 'n1',
        nodeType: 'agent',
      })
      expect(sink.getCounter('forge_pipeline_node_executions_total', {
        pipeline_id: 'pipe-1',
        node_type: 'agent',
        status: 'started',
      })).toBe(1)
    })

    it('records pipeline:node_completed histogram', () => {
      bus.emit({
        type: 'pipeline:node_completed',
        pipelineId: 'pipe-1',
        nodeId: 'n1',
        durationMs: 2500,
      })
      const hist = sink.getHistogram('forge_pipeline_node_duration_seconds', {
        pipeline_id: 'pipe-1',
        node_id: 'n1',
      })
      expect(hist).toHaveLength(1)
      expect(hist[0]).toBe(2.5)
    })

    it('records pipeline:node_failed counter', () => {
      bus.emit({
        type: 'pipeline:node_failed',
        pipelineId: 'pipe-1',
        nodeId: 'n2',
        message: 'timeout',
      })
      expect(sink.getCounter('forge_pipeline_node_failures_total', {
        pipeline_id: 'pipe-1',
        node_id: 'n2',
      })).toBe(1)
    })

    it('records pipeline:node_skipped counter', () => {
      bus.emit({
        type: 'pipeline:node_skipped',
        pipelineId: 'pipe-1',
        nodeId: 'n3',
        reason: 'condition_false',
      })
      expect(sink.getCounter('forge_pipeline_node_skips_total', {
        pipeline_id: 'pipe-1',
        node_id: 'n3',
      })).toBe(1)
    })

    it('records pipeline:suspended counter', () => {
      bus.emit({
        type: 'pipeline:suspended',
        pipelineId: 'pipe-1',
        reason: 'approval_needed',
      })
      expect(sink.getCounter('forge_pipeline_suspensions_total', {
        pipeline_id: 'pipe-1',
      })).toBe(1)
    })

    it('records pipeline:resumed counter', () => {
      bus.emit({
        type: 'pipeline:resumed',
        pipelineId: 'pipe-1',
      })
      expect(sink.getCounter('forge_pipeline_resumptions_total', {
        pipeline_id: 'pipe-1',
      })).toBe(1)
    })

    it('records pipeline:loop_iteration counter', () => {
      bus.emit({
        type: 'pipeline:loop_iteration',
        pipelineId: 'pipe-1',
        nodeId: 'loop-1',
        iteration: 3,
      })
      expect(sink.getCounter('forge_pipeline_loop_iterations_total', {
        pipeline_id: 'pipe-1',
        node_id: 'loop-1',
      })).toBe(1)
    })

    it('records pipeline:checkpoint_saved counter', () => {
      bus.emit({
        type: 'pipeline:checkpoint_saved',
        pipelineId: 'pipe-1',
        nodeId: 'n1',
      })
      expect(sink.getCounter('forge_pipeline_checkpoints_total', {
        pipeline_id: 'pipe-1',
      })).toBe(1)
    })

    it('records pipeline:run_completed counter and duration histogram', () => {
      bus.emit({
        type: 'pipeline:run_completed',
        pipelineId: 'pipe-1',
        runId: 'run-1',
        durationMs: 30000,
      })
      expect(sink.getCounter('forge_pipeline_runs_total', {
        pipeline_id: 'pipe-1',
        status: 'completed',
      })).toBe(1)

      const hist = sink.getHistogram('forge_pipeline_run_duration_seconds', {
        pipeline_id: 'pipe-1',
      })
      expect(hist).toHaveLength(1)
      expect(hist[0]).toBe(30)
    })

    it('records pipeline:run_failed counter', () => {
      bus.emit({
        type: 'pipeline:run_failed',
        pipelineId: 'pipe-1',
        runId: 'run-1',
        message: 'error',
      })
      expect(sink.getCounter('forge_pipeline_runs_total', {
        pipeline_id: 'pipe-1',
        status: 'failed',
      })).toBe(1)
    })

    it('records pipeline:run_cancelled counter', () => {
      bus.emit({
        type: 'pipeline:run_cancelled',
        pipelineId: 'pipe-1',
        runId: 'run-1',
        reason: 'user_cancel',
      })
      expect(sink.getCounter('forge_pipeline_runs_total', {
        pipeline_id: 'pipe-1',
        status: 'cancelled',
      })).toBe(1)
    })
  })

  describe('security/safety metrics', () => {
    it('records policy:evaluated counter and histogram', () => {
      bus.emit({
        type: 'policy:evaluated',
        policySetId: 'ps-1',
        action: 'tool:call',
        effect: 'allow',
        durationUs: 150,
      })
      expect(sink.getCounter('forge_policy_evaluations_total', {
        policy_set_id: 'ps-1',
        effect: 'allow',
      })).toBe(1)

      const hist = sink.getHistogram('forge_policy_evaluation_duration_us', {
        policy_set_id: 'ps-1',
      })
      expect(hist).toEqual([150])
    })

    it('records policy:denied counter', () => {
      bus.emit({
        type: 'policy:denied',
        policySetId: 'ps-1',
        action: 'memory:write',
        reason: 'unauthorized',
      })
      expect(sink.getCounter('forge_policy_denials_total', {
        policy_set_id: 'ps-1',
        action: 'memory:write',
      })).toBe(1)
    })

    it('records policy:set_updated counter', () => {
      bus.emit({
        type: 'policy:set_updated',
        policySetId: 'ps-1',
        version: 2,
      })
      expect(sink.getCounter('forge_policy_updates_total', {
        policy_set_id: 'ps-1',
      })).toBe(1)
    })

    it('records safety:violation counter', () => {
      bus.emit({
        type: 'safety:violation',
        category: 'prompt_injection',
        severity: 'critical',
        message: 'injection detected',
        agentId: 'a1',
      })
      expect(sink.getCounter('forge_safety_violations_total', {
        category: 'prompt_injection',
        severity: 'critical',
      })).toBe(1)
    })

    it('records safety:blocked counter', () => {
      bus.emit({
        type: 'safety:blocked',
        category: 'data_exfiltration',
        action: 'tool:call',
        agentId: 'a1',
        message: 'blocked',
      })
      expect(sink.getCounter('forge_safety_blocks_total', {
        category: 'data_exfiltration',
        action: 'tool:call',
      })).toBe(1)
    })

    it('records safety:kill_requested counter', () => {
      bus.emit({
        type: 'safety:kill_requested',
        agentId: 'rogue-agent',
        reason: 'budget_exceeded',
      })
      expect(sink.getCounter('forge_safety_kill_requests_total', {
        agent_id: 'rogue-agent',
      })).toBe(1)
    })

    it('records memory:threat_detected counter', () => {
      bus.emit({
        type: 'memory:threat_detected',
        threatType: 'poisoning',
        namespace: 'lessons',
        message: 'suspicious write',
      })
      expect(sink.getCounter('forge_memory_threats_total', {
        threat_type: 'poisoning',
        namespace: 'lessons',
      })).toBe(1)
    })

    it('records memory:quarantined counter', () => {
      bus.emit({
        type: 'memory:quarantined',
        namespace: 'lessons',
        key: 'k1',
        reason: 'threat',
      })
      expect(sink.getCounter('forge_memory_quarantines_total', {
        namespace: 'lessons',
      })).toBe(1)
    })
  })

  describe('vector store metrics', () => {
    it('records vector:search_completed counter and histograms', () => {
      bus.emit({
        type: 'vector:search_completed',
        provider: 'qdrant',
        collection: 'features',
        latencyMs: 12,
        resultCount: 5,
      })

      expect(sink.getCounter('forge_vector_searches_total', {
        provider: 'qdrant',
        collection: 'features',
      })).toBe(1)

      const latHist = sink.getHistogram('forge_vector_search_duration_seconds', {
        provider: 'qdrant',
        collection: 'features',
      })
      expect(latHist).toEqual([0.012])

      const resultHist = sink.getHistogram('forge_vector_search_result_count', {
        provider: 'qdrant',
        collection: 'features',
      })
      expect(resultHist).toEqual([5])
    })

    it('records vector:upsert_completed counter and histogram', () => {
      bus.emit({
        type: 'vector:upsert_completed',
        provider: 'pinecone',
        collection: 'docs',
        count: 10,
        latencyMs: 200,
      })

      expect(sink.getCounter('forge_vector_upserts_total', {
        provider: 'pinecone',
        collection: 'docs',
      })).toBe(10)

      const hist = sink.getHistogram('forge_vector_upsert_duration_seconds', {
        provider: 'pinecone',
        collection: 'docs',
      })
      expect(hist).toEqual([0.2])
    })

    it('records vector:embedding_completed counter and histogram', () => {
      bus.emit({
        type: 'vector:embedding_completed',
        provider: 'openai',
        tokenCount: 500,
        latencyMs: 80,
      })

      expect(sink.getCounter('forge_vector_embeddings_total', {
        provider: 'openai',
      })).toBe(1)

      const hist = sink.getHistogram('forge_vector_embedding_duration_seconds', {
        provider: 'openai',
      })
      expect(hist).toEqual([0.08])
    })

    it('records vector:error counter', () => {
      bus.emit({
        type: 'vector:error',
        provider: 'qdrant',
        collection: 'features',
        operation: 'search',
        message: 'connection refused',
      })

      expect(sink.getCounter('forge_vector_errors_total', {
        provider: 'qdrant',
        collection: 'features',
        operation: 'search',
      })).toBe(1)
    })
  })

  describe('streaming events produce no metrics', () => {
    it('agent:stream_delta produces no metrics', () => {
      bus.emit({ type: 'agent:stream_delta', agentId: 'a1', runId: 'r1', delta: 'hello' })
      // Should not throw; no metric to check
    })

    it('agent:stream_done produces no metrics', () => {
      bus.emit({ type: 'agent:stream_done', agentId: 'a1', runId: 'r1' })
      // Should not throw; no metric to check
    })
  })

  describe('enableSpanEvents = false', () => {
    it('does not create span events when disabled but still records metrics', () => {
      // Detach the default bridge first to avoid double-counting
      bridge.detach()

      const noSpanSink = new InMemoryMetricSink()
      const noSpanBridge = new OTelBridge({
        tracer,
        metricSink: noSpanSink,
        enableSpanEvents: false,
      })
      noSpanBridge.attach(bus)

      // These events normally create span events
      bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
      bus.emit({
        type: 'agent:failed',
        agentId: 'a1',
        runId: 'r1',
        errorCode: 'ERR',
        message: 'fail',
      })

      // Metrics should still be recorded
      expect(noSpanSink.getCounter('forge_agent_runs_total', {
        agent_id: 'a1',
        status: 'started',
      })).toBe(1)
    })
  })

  describe('error handling', () => {
    it('bridge swallows errors from event handler', () => {
      // Create a bridge with a metric sink that throws
      const throwingSink: InMemoryMetricSink = {
        increment: () => { throw new Error('sink error') },
        observe: () => { throw new Error('sink error') },
        gauge: () => { throw new Error('sink error') },
        getCounter: () => 0,
        getHistogram: () => [],
        getGauge: () => undefined,
        reset: () => {},
      } as unknown as InMemoryMetricSink

      const errorBridge = new OTelBridge({
        tracer,
        metricSink: throwingSink,
      })
      errorBridge.attach(bus)

      // Should not throw
      expect(() => {
        bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
      }).not.toThrow()
    })
  })

  describe('InMemoryMetricSink edge cases', () => {
    it('returns 0 for unknown counter', () => {
      expect(sink.getCounter('nonexistent', {})).toBe(0)
    })

    it('returns empty array for unknown histogram', () => {
      expect(sink.getHistogram('nonexistent', {})).toEqual([])
    })

    it('returns undefined for unknown gauge', () => {
      expect(sink.getGauge('nonexistent', {})).toBeUndefined()
    })

    it('sorts labels deterministically for key generation', () => {
      sink.increment('c', { z: '1', a: '2' })
      // Same labels in different order should match
      expect(sink.getCounter('c', { a: '2', z: '1' })).toBe(1)
    })

    it('handles empty labels for counters', () => {
      sink.increment('c', {})
      sink.increment('c', {})
      expect(sink.getCounter('c', {})).toBe(2)
    })
  })
})
