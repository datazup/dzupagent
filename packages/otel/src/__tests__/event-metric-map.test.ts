import { describe, it, expect, expectTypeOf } from 'vitest'
import type { DzupEvent } from '@dzupagent/core'
import { EVENT_METRIC_MAP, getAllMetricNames } from '../event-metric-map.js'
import type { MetricMapping } from '../event-metric-map.js'

type EventMetricMapKeys = keyof typeof EVENT_METRIC_MAP
type MissingEventMetricMappings = Exclude<DzupEvent['type'], EventMetricMapKeys>
type UnexpectedEventMetricMappings = Exclude<EventMetricMapKeys, DzupEvent['type']>

describe('EVENT_METRIC_MAP', () => {
  it('has a mapping entry for every DzupEvent type', () => {
    // All keys should be strings (event type names)
    const keys = Object.keys(EVENT_METRIC_MAP)
    expect(keys.length).toBeGreaterThan(0)

    // Each value should be an array
    for (const key of keys) {
      const mappings = EVENT_METRIC_MAP[key as keyof typeof EVENT_METRIC_MAP]
      expect(Array.isArray(mappings)).toBe(true)
    }
  })

  it('stays type-aligned with DzupEvent', () => {
    expectTypeOf<MissingEventMetricMappings>().toEqualTypeOf<never>()
    expectTypeOf<UnexpectedEventMetricMappings>().toEqualTypeOf<never>()
  })

  it('every mapping has required fields', () => {
    for (const [eventType, mappings] of Object.entries(EVENT_METRIC_MAP)) {
      for (const mapping of mappings) {
        expect(mapping.metricName).toBeTruthy()
        expect(['counter', 'histogram', 'gauge']).toContain(mapping.type)
        expect(mapping.description).toBeTruthy()
        expect(Array.isArray(mapping.labelKeys)).toBe(true)
        expect(typeof mapping.extract).toBe('function')
      }
    }
  })

  it('metric names follow supported prefix conventions', () => {
    for (const mappings of Object.values(EVENT_METRIC_MAP)) {
      for (const mapping of mappings) {
        expect(mapping.metricName).toMatch(/^(forge_|dzip_)/)
      }
    }
  })

  it('previously empty events now have real metric producers', () => {
    const populatedEvents = [
      'hook:error',
      'plugin:registered',
      'agent:stream_delta',
      'agent:stream_done',
      'agent:progress',
      'recovery:cancelled',
      'recovery:attempt_started',
      'recovery:succeeded',
      'recovery:exhausted',
      'correction:iteration',
      'quality:degraded',
      'quality:adjusted',
      'system:degraded',
      'system:consolidation_started',
      'system:consolidation_completed',
      'system:consolidation_failed',
      'cache:degraded',
      'memory:index_failed',
      'context:transfer_partial',
      'flow:compile_result',
    ] as const

    for (const eventType of populatedEvents) {
      const mappings = EVENT_METRIC_MAP[eventType]
      expect(mappings.length, `${eventType} should have at least one metric`).toBeGreaterThan(0)
    }
  })

  describe('extract functions return valid shape', () => {
    const testEvents: Record<string, Record<string, unknown>> = {
      'agent:started': { type: 'agent:started', agentId: 'a1', runId: 'r1' },
      'agent:completed': { type: 'agent:completed', agentId: 'a1', runId: 'r1', durationMs: 1000 },
      'agent:failed': { type: 'agent:failed', agentId: 'a1', runId: 'r1', errorCode: 'ERR', message: 'fail' },
      'tool:called': { type: 'tool:called', toolName: 't1', input: {} },
      'tool:result': { type: 'tool:result', toolName: 't1', durationMs: 100 },
      'tool:error': { type: 'tool:error', toolName: 't1', errorCode: 'ERR', message: 'fail' },
      'memory:written': { type: 'memory:written', namespace: 'ns', key: 'k' },
      'memory:searched': { type: 'memory:searched', namespace: 'ns', query: 'q', resultCount: 1 },
      'memory:error': { type: 'memory:error', namespace: 'ns', message: 'err' },
      'budget:warning': { type: 'budget:warning', level: 'warn', usage: { percent: 80 } },
      'budget:exceeded': { type: 'budget:exceeded', reason: 'cost', usage: { percent: 100 } },
      'pipeline:phase_changed': { type: 'pipeline:phase_changed', phase: 'gen', previousPhase: 'plan' },
      'pipeline:validation_failed': { type: 'pipeline:validation_failed', phase: 'validate', errors: [] },
      'approval:requested': { type: 'approval:requested', runId: 'r1', plan: {} },
      'approval:granted': { type: 'approval:granted', runId: 'r1' },
      'approval:rejected': { type: 'approval:rejected', runId: 'r1', reason: 'x' },
      'mcp:connected': { type: 'mcp:connected', serverName: 's1', toolCount: 5 },
      'mcp:disconnected': { type: 'mcp:disconnected', serverName: 's1' },
      'provider:failed': { type: 'provider:failed', provider: 'p1', tier: 'primary', message: 'x' },
      'provider:circuit_opened': { type: 'provider:circuit_opened', provider: 'p1' },
      'provider:circuit_closed': { type: 'provider:circuit_closed', provider: 'p1' },
      'identity:resolved': { type: 'identity:resolved', agentId: 'a1', method: 'jwt' },
      'identity:failed': { type: 'identity:failed', agentId: 'a1', reason: 'x' },
      'identity:credential_expired': { type: 'identity:credential_expired', agentId: 'a1', credentialType: 'key' },
      'identity:trust_updated': { type: 'identity:trust_updated', agentId: 'a1', previousScore: 0.5, newScore: 0.9 },
      'identity:delegation_issued': { type: 'identity:delegation_issued', delegator: 'd1', delegate: 'd2', scopes: [] },
      'registry:agent_registered': { type: 'registry:agent_registered', agentId: 'a1', capabilities: [] },
      'registry:agent_deregistered': { type: 'registry:agent_deregistered', agentId: 'a1' },
      'registry:agent_updated': { type: 'registry:agent_updated', agentId: 'a1', fields: [] },
      'registry:health_changed': { type: 'registry:health_changed', agentId: 'a1', previousStatus: 'healthy', newStatus: 'degraded' },
      'registry:capability_added': { type: 'registry:capability_added', agentId: 'a1', capability: 'code-gen' },
      'protocol:message_sent': { type: 'protocol:message_sent', protocol: 'a2a', messageType: 'task', targetAgent: 'w' },
      'protocol:message_received': { type: 'protocol:message_received', protocol: 'mcp', messageType: 'resp', sourceAgent: 's' },
      'protocol:error': { type: 'protocol:error', protocol: 'a2a', message: 'err', errorCode: 'TIMEOUT' },
      'protocol:connected': { type: 'protocol:connected', protocol: 'a2a', remoteAgent: 'w' },
      'protocol:disconnected': { type: 'protocol:disconnected', protocol: 'a2a', remoteAgent: 'w', reason: 'timeout' },
      'protocol:state_changed': { type: 'protocol:state_changed', protocol: 'a2a', previousState: 'connecting', newState: 'ready' },
      'pipeline:run_started': { type: 'pipeline:run_started', pipelineId: 'p1', runId: 'r1' },
      'pipeline:node_started': { type: 'pipeline:node_started', pipelineId: 'p1', nodeId: 'n1', nodeType: 'agent' },
      'pipeline:node_completed': { type: 'pipeline:node_completed', pipelineId: 'p1', nodeId: 'n1', durationMs: 1000 },
      'pipeline:node_failed': { type: 'pipeline:node_failed', pipelineId: 'p1', nodeId: 'n1', message: 'err' },
      'pipeline:node_skipped': { type: 'pipeline:node_skipped', pipelineId: 'p1', nodeId: 'n1', reason: 'cond' },
      'pipeline:suspended': { type: 'pipeline:suspended', pipelineId: 'p1', reason: 'approval' },
      'pipeline:resumed': { type: 'pipeline:resumed', pipelineId: 'p1' },
      'pipeline:loop_iteration': { type: 'pipeline:loop_iteration', pipelineId: 'p1', nodeId: 'n1', iteration: 1 },
      'pipeline:checkpoint_saved': { type: 'pipeline:checkpoint_saved', pipelineId: 'p1', nodeId: 'n1' },
      'pipeline:run_completed': { type: 'pipeline:run_completed', pipelineId: 'p1', runId: 'r1', durationMs: 5000 },
      'pipeline:run_failed': { type: 'pipeline:run_failed', pipelineId: 'p1', runId: 'r1', message: 'err' },
      'pipeline:run_cancelled': { type: 'pipeline:run_cancelled', pipelineId: 'p1', runId: 'r1', reason: 'user' },
      'policy:evaluated': { type: 'policy:evaluated', policySetId: 'ps1', action: 'tool:call', effect: 'allow', durationUs: 100 },
      'policy:denied': { type: 'policy:denied', policySetId: 'ps1', action: 'write', reason: 'unauth' },
      'policy:set_updated': { type: 'policy:set_updated', policySetId: 'ps1', version: 2 },
      'safety:violation': { type: 'safety:violation', category: 'injection', severity: 'critical', message: 'x', agentId: 'a1' },
      'safety:blocked': { type: 'safety:blocked', category: 'exfil', action: 'tool:call', agentId: 'a1', message: 'x' },
      'safety:kill_requested': { type: 'safety:kill_requested', agentId: 'a1', reason: 'budget' },
      'memory:threat_detected': { type: 'memory:threat_detected', threatType: 'poison', namespace: 'ns', message: 'x' },
      'memory:quarantined': { type: 'memory:quarantined', namespace: 'ns', key: 'k', reason: 'threat' },
      'vector:search_completed': { type: 'vector:search_completed', provider: 'qdrant', collection: 'c', latencyMs: 10, resultCount: 5 },
      'vector:upsert_completed': { type: 'vector:upsert_completed', provider: 'qdrant', collection: 'c', count: 10, latencyMs: 20 },
      'vector:embedding_completed': { type: 'vector:embedding_completed', provider: 'openai', tokenCount: 100, latencyMs: 50 },
      'vector:error': { type: 'vector:error', provider: 'qdrant', collection: 'c', operation: 'search', message: 'err' },
      'memory:retrieval_source_failed': { type: 'memory:retrieval_source_failed', source: 'vector', error: 'timeout', durationMs: 500, query: 'q' },
      'memory:retrieval_source_succeeded': { type: 'memory:retrieval_source_succeeded', source: 'vector', resultCount: 3, durationMs: 200 },
      'pipeline:node_retry': { type: 'pipeline:node_retry', pipelineId: 'p1', runId: 'r1', nodeId: 'n1', attempt: 2, maxAttempts: 3, error: 'err', backoffMs: 1000 },
      'tool:latency': { type: 'tool:latency', toolName: 't1', durationMs: 150 },
      'agent:stop_reason': { type: 'agent:stop_reason', agentId: 'a1', reason: 'budget', iterations: 5, toolStats: [] },
      'agent:stuck_detected': { type: 'agent:stuck_detected', agentId: 'a1', reason: 'loop', recovery: 'reset', timestamp: Date.now() },
      'delegation:started': { type: 'delegation:started', parentRunId: 'r1', targetAgentId: 'a2', delegationId: 'd1' },
      'delegation:completed': { type: 'delegation:completed', parentRunId: 'r1', targetAgentId: 'a2', delegationId: 'd1', durationMs: 3000, success: true },
      'delegation:failed': { type: 'delegation:failed', parentRunId: 'r1', targetAgentId: 'a2', delegationId: 'd1', error: 'err' },
      'delegation:timeout': { type: 'delegation:timeout', parentRunId: 'r1', targetAgentId: 'a2', delegationId: 'd1', timeoutMs: 30000 },
      'delegation:cancelled': { type: 'delegation:cancelled', parentRunId: 'r1', targetAgentId: 'a2', delegationId: 'd1' },
      'supervisor:delegating': { type: 'supervisor:delegating', specialistId: 's1', task: 'codegen' },
      'supervisor:delegation_complete': { type: 'supervisor:delegation_complete', specialistId: 's1', task: 'codegen', success: true },
      'supervisor:plan_created': { type: 'supervisor:plan_created', goal: 'build', assignments: [{ task: 'code', specialistId: 's1' }], source: 'llm' },
      'supervisor:llm_decompose_fallback': { type: 'supervisor:llm_decompose_fallback', goal: 'build', error: 'parse fail' },
      // --- Previously-empty events now with real metrics ---
      'hook:error': { type: 'hook:error', hookName: 'onBefore', message: 'failed' },
      'plugin:registered': { type: 'plugin:registered', pluginName: 'cache-plugin' },
      'agent:stream_delta': { type: 'agent:stream_delta', agentId: 'a1', runId: 'r1', content: 'chunk' },
      'agent:stream_done': { type: 'agent:stream_done', agentId: 'a1', runId: 'r1', finalContent: 'done' },
      'agent:progress': { type: 'agent:progress', agentId: 'a1', phase: 'planning', percentage: 50, message: 'halfway', timestamp: Date.now() },
      'recovery:cancelled': { type: 'recovery:cancelled', agentId: 'a1', runId: 'r1', attempts: 3, durationMs: 5000, reason: 'user' },
      'recovery:attempt_started': { type: 'recovery:attempt_started', agentId: 'a1', runId: 'r1', attempt: 1, maxAttempts: 3, strategy: 'retry', timestamp: Date.now() },
      'recovery:succeeded': { type: 'recovery:succeeded', agentId: 'a1', runId: 'r1', attempt: 2, strategy: 'retry', durationMs: 1200 },
      'recovery:exhausted': { type: 'recovery:exhausted', agentId: 'a1', runId: 'r1', attempts: 3, strategies: ['retry', 'fallback'], durationMs: 10000 },
      'correction:iteration': { type: 'correction:iteration', nodeId: 'n1', iteration: 2, passed: true, qualityScore: 0.85, durationMs: 300 },
      'quality:degraded': { type: 'quality:degraded', metric: 'latency', value: 500, threshold: 200, recommendation: 'scale up', details: {} },
      'quality:adjusted': { type: 'quality:adjusted', adjustment: 'batch_size', reason: 'high latency', previousValue: 10, newValue: 5, reversible: true },
      'system:degraded': { type: 'system:degraded', subsystem: 'cache', reason: 'redis down', timestamp: Date.now(), recoverable: true },
      'system:consolidation_started': { type: 'system:consolidation_started', timestamp: Date.now() },
      'system:consolidation_completed': { type: 'system:consolidation_completed', durationMs: 2000, recordsProcessed: 150, pruned: 10, merged: 5, timestamp: Date.now() },
      'system:consolidation_failed': { type: 'system:consolidation_failed', error: 'disk full', durationMs: 500, timestamp: Date.now() },
      'cache:degraded': { type: 'cache:degraded', operation: 'get', key: 'k1', reason: 'timeout', timestamp: Date.now(), recoverable: true },
      'memory:index_failed': { type: 'memory:index_failed', namespace: 'ns', key: 'k1', reason: 'corrupt', timestamp: Date.now(), recoverable: false },
      'context:transfer_partial': { type: 'context:transfer_partial', sessionId: 's1', reason: 'truncated', timestamp: Date.now(), recoverable: true },
      'flow:compile_result': {
        type: 'flow:compile_result',
        compileId: 'c1',
        target: 'pipeline',
        artifact: { nodes: [], edges: [] },
        warnings: [{ stage: 4, code: 'WARN_1', message: 'minor issue' }],
        reasons: [{ code: 'FOR_EACH_PRESENT', message: 'Loop semantics are present; routed to pipeline.' }],
      },
    }

    for (const [eventType, event] of Object.entries(testEvents)) {
      const mappings = EVENT_METRIC_MAP[eventType as keyof typeof EVENT_METRIC_MAP]

      if (!mappings || mappings.length === 0) continue

      for (const mapping of mappings) {
        it(`${eventType} -> ${mapping.metricName} extract returns {value, labels}`, () => {
          const result = mapping.extract(event as never)
          expect(typeof result.value).toBe('number')
          expect(typeof result.labels).toBe('object')
          // All label values should be strings
          for (const [k, v] of Object.entries(result.labels)) {
            expect(typeof v).toBe('string')
          }
        })
      }
    }
  })
})

describe('getAllMetricNames', () => {
  it('returns an array of unique metric names', () => {
    const names = getAllMetricNames()
    expect(names.length).toBeGreaterThan(0)
    // All unique
    expect(new Set(names).size).toBe(names.length)
  })

  it('all names start with a supported prefix', () => {
    const names = getAllMetricNames()
    for (const name of names) {
      expect(name).toMatch(/^(forge_|dzip_)/)
    }
  })

  it('includes expected well-known metric names', () => {
    const names = getAllMetricNames()
    expect(names).toContain('dzip_agent_runs_total')
    expect(names).toContain('forge_tool_calls_total')
    expect(names).toContain('forge_memory_writes_total')
    expect(names).toContain('forge_vector_searches_total')
    expect(names).toContain('forge_policy_evaluations_total')
  })
})
