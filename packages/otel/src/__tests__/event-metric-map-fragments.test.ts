import { describe, it, expect } from 'vitest'
import { agentLifecycleMetricMap } from '../event-metric-map/agent-lifecycle.js'
import { toolLifecycleMetricMap } from '../event-metric-map/tool-lifecycle.js'
import { memoryCoreMetricMap } from '../event-metric-map/memory-core.js'
import { budgetMetricMap } from '../event-metric-map/budget.js'
import { governanceMetricMap } from '../event-metric-map/governance.js'
import { vectorMetricMap } from '../event-metric-map/vector.js'
import { delegationMetricMap } from '../event-metric-map/delegation.js'
import { flowCompileMetricMap } from '../event-metric-map/flow-compile.js'
import { supervisorMetricMap } from '../event-metric-map/supervisor.js'
import { pipelineRuntimeMetricMap } from '../event-metric-map/pipeline-runtime.js'
import { telemetryMetricMap } from '../event-metric-map/telemetry.js'
import { pipelineRetryMetricMap } from '../event-metric-map/pipeline-retry.js'
import { memoryRetrievalSourcesMetricMap } from '../event-metric-map/memory-retrieval-sources.js'
import { counter, histogram, gauge, getAllMetricNames } from '../event-metric-map/shared.js'
import { asEvent } from '../event-metric-map/types.js'
import { EVENT_METRIC_MAP } from '../event-metric-map.js'
import type { DzupEvent } from '@dzupagent/core'

// ------------------------------------------------------------------ Helpers

function extractFirst(mappings: { extract: (e: DzupEvent) => { value: number; labels: Record<string, string> } }[], event: DzupEvent) {
  return mappings[0]!.extract(event)
}

// ------------------------------------------------------------------ Tests

describe('agent-lifecycle metric map', () => {
  it('agent:started produces counter with agent_id and status=started', () => {
    const mappings = agentLifecycleMetricMap['agent:started']
    const result = extractFirst(mappings, { type: 'agent:started', agentId: 'planner', runId: 'r1' } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.agent_id).toBe('planner')
    expect(result.labels.status).toBe('started')
  })

  it('agent:completed produces counter and histogram', () => {
    const mappings = agentLifecycleMetricMap['agent:completed']
    expect(mappings).toHaveLength(2)

    const counterResult = mappings[0]!.extract({ type: 'agent:completed', agentId: 'coder', runId: 'r1', durationMs: 2500 } as DzupEvent)
    expect(counterResult.labels.status).toBe('completed')

    const histResult = mappings[1]!.extract({ type: 'agent:completed', agentId: 'coder', runId: 'r1', durationMs: 2500 } as DzupEvent)
    expect(histResult.value).toBeCloseTo(2.5) // 2500ms -> 2.5s
    expect(histResult.labels.agent_id).toBe('coder')
  })

  it('agent:failed produces counter with error_code label', () => {
    const mappings = agentLifecycleMetricMap['agent:failed']
    const result = extractFirst(mappings, { type: 'agent:failed', agentId: 'a1', runId: 'r1', errorCode: 'TIMEOUT', message: 'timed out' } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.error_code).toBe('TIMEOUT')
  })
})

describe('tool-lifecycle metric map', () => {
  it('tool:called increments forge_tool_calls_total', () => {
    const mappings = toolLifecycleMetricMap['tool:called']
    const result = extractFirst(mappings, { type: 'tool:called', toolName: 'read_file', input: {} } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.tool_name).toBe('read_file')
    expect(mappings[0]!.metricName).toBe('forge_tool_calls_total')
  })

  it('tool:result records duration in seconds', () => {
    const mappings = toolLifecycleMetricMap['tool:result']
    const result = extractFirst(mappings, { type: 'tool:result', toolName: 'write_file', durationMs: 350 } as DzupEvent)
    expect(result.value).toBeCloseTo(0.35)
    expect(result.labels.tool_name).toBe('write_file')
    expect(mappings[0]!.type).toBe('histogram')
  })

  it('tool:error records error_code label', () => {
    const mappings = toolLifecycleMetricMap['tool:error']
    const result = extractFirst(mappings, { type: 'tool:error', toolName: 'exec', errorCode: 'PERMISSION_DENIED', message: 'no' } as DzupEvent)
    expect(result.labels.error_code).toBe('PERMISSION_DENIED')
    expect(result.labels.tool_name).toBe('exec')
  })
})

describe('memory-core metric map', () => {
  it('memory:written labels by namespace', () => {
    const result = extractFirst(memoryCoreMetricMap['memory:written'], { type: 'memory:written', namespace: 'lessons', key: 'k1' } as DzupEvent)
    expect(result.labels.namespace).toBe('lessons')
  })

  it('memory:searched labels by namespace', () => {
    const result = extractFirst(memoryCoreMetricMap['memory:searched'], { type: 'memory:searched', namespace: 'facts', query: 'q', resultCount: 3 } as DzupEvent)
    expect(result.labels.namespace).toBe('facts')
  })

  it('memory:error labels by namespace', () => {
    const result = extractFirst(memoryCoreMetricMap['memory:error'], { type: 'memory:error', namespace: 'cache', message: 'oops' } as DzupEvent)
    expect(result.labels.namespace).toBe('cache')
  })
})

describe('budget metric map', () => {
  it('budget:warning labels by level', () => {
    const result = extractFirst(budgetMetricMap['budget:warning'], {
      type: 'budget:warning', level: 'critical', usage: { percent: 90 },
    } as DzupEvent)
    expect(result.labels.level).toBe('critical')
  })

  it('budget:exceeded labels by reason', () => {
    const result = extractFirst(budgetMetricMap['budget:exceeded'], {
      type: 'budget:exceeded', reason: 'tokens', usage: { percent: 100 },
    } as DzupEvent)
    expect(result.labels.reason).toBe('tokens')
  })
})

describe('governance metric map', () => {
  it('policy:evaluated records evaluation with effect label', () => {
    const mappings = governanceMetricMap['policy:evaluated']
    expect(mappings).toHaveLength(2)
    const result = mappings[0]!.extract({ type: 'policy:evaluated', policySetId: 'ps1', action: 'tool:call', effect: 'deny', durationUs: 200 } as DzupEvent)
    expect(result.labels.effect).toBe('deny')
  })

  it('policy:evaluated histogram records durationUs', () => {
    const mappings = governanceMetricMap['policy:evaluated']
    const result = mappings[1]!.extract({ type: 'policy:evaluated', policySetId: 'ps1', action: 'tool:call', effect: 'allow', durationUs: 150 } as DzupEvent)
    expect(result.value).toBe(150)
  })

  it('policy:denied records action label', () => {
    const result = extractFirst(governanceMetricMap['policy:denied'], { type: 'policy:denied', policySetId: 'ps1', action: 'write', reason: 'unauth' } as DzupEvent)
    expect(result.labels.action).toBe('write')
  })

  it('safety:violation records category and severity', () => {
    const result = extractFirst(governanceMetricMap['safety:violation'], { type: 'safety:violation', category: 'injection', severity: 'critical', message: 'x', agentId: 'a1' } as DzupEvent)
    expect(result.labels.category).toBe('injection')
    expect(result.labels.severity).toBe('critical')
  })

  it('safety:blocked records category and action', () => {
    const result = extractFirst(governanceMetricMap['safety:blocked'], { type: 'safety:blocked', category: 'exfil', action: 'tool:call', agentId: 'a1', message: 'blocked' } as DzupEvent)
    expect(result.labels.category).toBe('exfil')
    expect(result.labels.action).toBe('tool:call')
  })

  it('safety:kill_requested records agent_id', () => {
    const result = extractFirst(governanceMetricMap['safety:kill_requested'], { type: 'safety:kill_requested', agentId: 'bad-agent', reason: 'budget' } as DzupEvent)
    expect(result.labels.agent_id).toBe('bad-agent')
  })

  it('memory:threat_detected records threat_type and namespace', () => {
    const result = extractFirst(governanceMetricMap['memory:threat_detected'], { type: 'memory:threat_detected', threatType: 'poison', namespace: 'ns1', message: 'x' } as DzupEvent)
    expect(result.labels.threat_type).toBe('poison')
    expect(result.labels.namespace).toBe('ns1')
  })

  it('memory:quarantined records namespace', () => {
    const result = extractFirst(governanceMetricMap['memory:quarantined'], { type: 'memory:quarantined', namespace: 'ns1', key: 'k', reason: 'threat' } as DzupEvent)
    expect(result.labels.namespace).toBe('ns1')
  })
})

describe('vector metric map', () => {
  it('vector:search_completed produces 3 mappings (counter, latency hist, result count hist)', () => {
    const mappings = vectorMetricMap['vector:search_completed']
    expect(mappings).toHaveLength(3)

    const event = { type: 'vector:search_completed', provider: 'qdrant', collection: 'docs', latencyMs: 25, resultCount: 8 } as DzupEvent
    const counter = mappings[0]!.extract(event)
    expect(counter.value).toBe(1)
    expect(counter.labels.provider).toBe('qdrant')

    const latency = mappings[1]!.extract(event)
    expect(latency.value).toBeCloseTo(0.025)

    const count = mappings[2]!.extract(event)
    expect(count.value).toBe(8)
  })

  it('vector:upsert_completed records count as value', () => {
    const mappings = vectorMetricMap['vector:upsert_completed']
    const event = { type: 'vector:upsert_completed', provider: 'pinecone', collection: 'c1', count: 42, latencyMs: 100 } as DzupEvent
    const result = mappings[0]!.extract(event)
    expect(result.value).toBe(42)
  })

  it('vector:embedding_completed records provider label', () => {
    const event = { type: 'vector:embedding_completed', provider: 'openai', tokenCount: 200, latencyMs: 80 } as DzupEvent
    const result = extractFirst(vectorMetricMap['vector:embedding_completed'], event)
    expect(result.labels.provider).toBe('openai')
  })

  it('vector:error records operation label', () => {
    const event = { type: 'vector:error', provider: 'qdrant', collection: 'c1', operation: 'upsert', message: 'fail' } as DzupEvent
    const result = extractFirst(vectorMetricMap['vector:error'], event)
    expect(result.labels.operation).toBe('upsert')
  })
})

describe('delegation metric map', () => {
  it('delegation:started labels by target_agent_id', () => {
    const result = extractFirst(delegationMetricMap['delegation:started'], { type: 'delegation:started', parentRunId: 'r1', targetAgentId: 'worker', delegationId: 'd1' } as DzupEvent)
    expect(result.labels.target_agent_id).toBe('worker')
  })

  it('delegation:completed produces counter and histogram', () => {
    const mappings = delegationMetricMap['delegation:completed']
    expect(mappings).toHaveLength(2)

    const event = { type: 'delegation:completed', parentRunId: 'r1', targetAgentId: 'w', delegationId: 'd1', durationMs: 5000, success: true } as DzupEvent
    const counterResult = mappings[0]!.extract(event)
    expect(counterResult.labels.success).toBe('true')

    const histResult = mappings[1]!.extract(event)
    expect(histResult.value).toBe(5000)
  })

  it('delegation:failed labels by target_agent_id', () => {
    const result = extractFirst(delegationMetricMap['delegation:failed'], { type: 'delegation:failed', parentRunId: 'r1', targetAgentId: 'w2', delegationId: 'd2', error: 'err' } as DzupEvent)
    expect(result.labels.target_agent_id).toBe('w2')
  })

  it('delegation:timeout labels by target_agent_id', () => {
    const result = extractFirst(delegationMetricMap['delegation:timeout'], { type: 'delegation:timeout', parentRunId: 'r1', targetAgentId: 'w3', delegationId: 'd3', timeoutMs: 30000 } as DzupEvent)
    expect(result.labels.target_agent_id).toBe('w3')
  })

  it('delegation:cancelled labels by target_agent_id', () => {
    const result = extractFirst(delegationMetricMap['delegation:cancelled'], { type: 'delegation:cancelled', parentRunId: 'r1', targetAgentId: 'w4', delegationId: 'd4' } as DzupEvent)
    expect(result.labels.target_agent_id).toBe('w4')
  })
})

describe('supervisor metric map', () => {
  it('supervisor:delegating labels by specialist_id', () => {
    const result = extractFirst(supervisorMetricMap['supervisor:delegating'], { type: 'supervisor:delegating', specialistId: 'code-gen', task: 'write' } as DzupEvent)
    expect(result.labels.specialist_id).toBe('code-gen')
  })

  it('supervisor:delegation_complete includes success label as string', () => {
    const result = extractFirst(supervisorMetricMap['supervisor:delegation_complete'], { type: 'supervisor:delegation_complete', specialistId: 's1', task: 'test', success: false } as DzupEvent)
    expect(result.labels.success).toBe('false')
  })

  it('supervisor:plan_created labels by source', () => {
    const result = extractFirst(supervisorMetricMap['supervisor:plan_created'], { type: 'supervisor:plan_created', goal: 'build', assignments: [], source: 'llm' } as DzupEvent)
    expect(result.labels.source).toBe('llm')
  })

  it('supervisor:plan_created defaults source to unknown', () => {
    const result = extractFirst(supervisorMetricMap['supervisor:plan_created'], { type: 'supervisor:plan_created', goal: 'build', assignments: [] } as DzupEvent)
    expect(result.labels.source).toBe('unknown')
  })

  it('supervisor:llm_decompose_fallback returns empty labels', () => {
    const result = extractFirst(supervisorMetricMap['supervisor:llm_decompose_fallback'], { type: 'supervisor:llm_decompose_fallback', goal: 'x', error: 'y' } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels).toEqual({})
  })
})

describe('pipeline-runtime metric map', () => {
  it('pipeline:run_started labels with status=started', () => {
    const result = extractFirst(pipelineRuntimeMetricMap['pipeline:run_started'], { type: 'pipeline:run_started', pipelineId: 'p1', runId: 'r1' } as DzupEvent)
    expect(result.labels.status).toBe('started')
    expect(result.labels.pipeline_id).toBe('p1')
  })

  it('pipeline:node_completed records duration in seconds', () => {
    const result = extractFirst(pipelineRuntimeMetricMap['pipeline:node_completed'], { type: 'pipeline:node_completed', pipelineId: 'p1', nodeId: 'n1', durationMs: 3000 } as DzupEvent)
    expect(result.value).toBeCloseTo(3.0)
  })

  it('pipeline:run_completed produces counter with status=completed and histogram', () => {
    const mappings = pipelineRuntimeMetricMap['pipeline:run_completed']
    expect(mappings).toHaveLength(2)
    const event = { type: 'pipeline:run_completed', pipelineId: 'p1', runId: 'r1', durationMs: 10000 } as DzupEvent
    expect(mappings[0]!.extract(event).labels.status).toBe('completed')
    expect(mappings[1]!.extract(event).value).toBeCloseTo(10)
  })

  it('pipeline:run_failed labels with status=failed', () => {
    const result = extractFirst(pipelineRuntimeMetricMap['pipeline:run_failed'], { type: 'pipeline:run_failed', pipelineId: 'p1', runId: 'r1', message: 'err' } as DzupEvent)
    expect(result.labels.status).toBe('failed')
  })

  it('pipeline:run_cancelled labels with status=cancelled', () => {
    const result = extractFirst(pipelineRuntimeMetricMap['pipeline:run_cancelled'], { type: 'pipeline:run_cancelled', pipelineId: 'p1', runId: 'r1', reason: 'user' } as DzupEvent)
    expect(result.labels.status).toBe('cancelled')
  })

  it('pipeline:suspended records pipeline_id', () => {
    const result = extractFirst(pipelineRuntimeMetricMap['pipeline:suspended'], { type: 'pipeline:suspended', pipelineId: 'p2', reason: 'approval' } as DzupEvent)
    expect(result.labels.pipeline_id).toBe('p2')
  })

  it('pipeline:resumed records pipeline_id', () => {
    const result = extractFirst(pipelineRuntimeMetricMap['pipeline:resumed'], { type: 'pipeline:resumed', pipelineId: 'p2' } as DzupEvent)
    expect(result.labels.pipeline_id).toBe('p2')
  })
})

describe('flow-compile metric map', () => {
  it('flow:compile_started labels by input_kind', () => {
    const result = extractFirst(flowCompileMetricMap['flow:compile_started'], {
      type: 'flow:compile_started',
      compileId: 'c1',
      inputKind: 'json-string',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.input_kind).toBe('json-string')
  })

  it('flow:compile_result records warning and reason counts', () => {
    const mappings = flowCompileMetricMap['flow:compile_result']
    expect(mappings).toHaveLength(3)

    const event = {
      type: 'flow:compile_result',
      compileId: 'c2',
      target: 'pipeline',
      artifact: { nodes: [], edges: [] },
      warnings: [{ stage: 4, code: 'WARN_1', message: 'warn' }],
      reasons: [{ code: 'FOR_EACH_PRESENT', message: 'pipeline required' }],
    } as DzupEvent

    expect(mappings[0]!.extract(event)).toEqual({ value: 1, labels: { target: 'pipeline' } })
    expect(mappings[1]!.extract(event)).toEqual({ value: 1, labels: { target: 'pipeline' } })
    expect(mappings[2]!.extract(event)).toEqual({ value: 1, labels: { target: 'pipeline' } })
  })

  it('flow:compile_failed records stage and duration', () => {
    const mappings = flowCompileMetricMap['flow:compile_failed']
    expect(mappings).toHaveLength(3)

    const event = {
      type: 'flow:compile_failed',
      compileId: 'c3',
      stage: 3,
      errorCount: 2,
      durationMs: 60,
    } as DzupEvent

    expect(mappings[0]!.extract(event)).toEqual({ value: 1, labels: { stage: '3' } })
    expect(mappings[1]!.extract(event)).toEqual({ value: 2, labels: { stage: '3' } })
    expect(mappings[2]!.extract(event)).toEqual({ value: 60, labels: { stage: '3' } })
  })
})

describe('telemetry metric map', () => {
  it('tool:latency records durationMs as value', () => {
    const result = extractFirst(telemetryMetricMap['tool:latency'], { type: 'tool:latency', toolName: 'search', durationMs: 250 } as DzupEvent)
    expect(result.value).toBe(250)
    expect(result.labels.tool_name).toBe('search')
  })

  it('agent:stop_reason records reason label', () => {
    const result = extractFirst(telemetryMetricMap['agent:stop_reason'], { type: 'agent:stop_reason', agentId: 'a1', reason: 'max_iterations', iterations: 10, toolStats: [] } as DzupEvent)
    expect(result.labels.reason).toBe('max_iterations')
  })

  it('agent:stuck_detected records agent_id and reason', () => {
    const result = extractFirst(telemetryMetricMap['agent:stuck_detected'], { type: 'agent:stuck_detected', agentId: 'a2', reason: 'loop', recovery: 'reset', timestamp: Date.now() } as DzupEvent)
    expect(result.labels.agent_id).toBe('a2')
    expect(result.labels.reason).toBe('loop')
  })
})

describe('shared helpers', () => {
  it('counter() creates a counter MetricMapping', () => {
    const m = counter('test_counter', 'A test counter', ['l1'], () => ({ value: 1, labels: { l1: 'v1' } }))
    expect(m.type).toBe('counter')
    expect(m.metricName).toBe('test_counter')
    expect(m.labelKeys).toEqual(['l1'])
    expect(m.extract({} as DzupEvent)).toEqual({ value: 1, labels: { l1: 'v1' } })
  })

  it('histogram() creates a histogram MetricMapping', () => {
    const m = histogram('test_hist', 'A histogram', ['a'], () => ({ value: 42, labels: { a: 'b' } }))
    expect(m.type).toBe('histogram')
    expect(m.metricName).toBe('test_hist')
  })

  it('gauge() creates a gauge MetricMapping', () => {
    const m = gauge('test_gauge', 'A gauge', [], () => ({ value: 99, labels: {} }))
    expect(m.type).toBe('gauge')
    expect(m.extract({} as DzupEvent).value).toBe(99)
  })

  it('getAllMetricNames extracts unique names from a map', () => {
    const names = getAllMetricNames(EVENT_METRIC_MAP)
    expect(names.length).toBeGreaterThan(0)
    expect(new Set(names).size).toBe(names.length)
  })

  it('asEvent returns the same reference (type narrowing helper)', () => {
    const event = { type: 'agent:started', agentId: 'a1', runId: 'r1' } as DzupEvent
    const narrowed = asEvent<'agent:started'>(event)
    expect(narrowed).toBe(event)
  })
})
