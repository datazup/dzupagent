import { describe, it, expect, vi } from 'vitest'
import { PipelineRuntime } from '../pipeline/pipeline-runtime.js'
import type {
  PipelineDefinition,
  PipelineNode,
  PipelineEdge,
  ForkNode,
  JoinNode,
} from '@dzipagent/core'
import type {
  NodeExecutor,
  NodeResult,
  NodeExecutionContext,
  PipelineTracer,
  OTelSpanLike,
} from '../pipeline/pipeline-runtime-types.js'

// ---------------------------------------------------------------------------
// Mock tracer factory
// ---------------------------------------------------------------------------

interface SpanRecord {
  phase: string
  attributes: Record<string, string | number> | undefined
  ended: boolean
  status: 'ok' | 'error' | 'pending'
  error?: unknown
}

function createMockTracer(): { tracer: PipelineTracer; spans: SpanRecord[] } {
  const spans: SpanRecord[] = []
  // Map span objects to their records for identity-based lookup
  const spanToRecord = new WeakMap<object, SpanRecord>()

  const tracer: PipelineTracer = {
    startPhaseSpan(phase: string, options?: { attributes?: Record<string, string | number> }): OTelSpanLike {
      const record: SpanRecord = {
        phase,
        attributes: options?.attributes ? { ...options.attributes } : undefined,
        ended: false,
        status: 'pending',
      }
      spans.push(record)
      const spanObj: OTelSpanLike = {
        setAttribute(key: string, value: string | number | boolean) {
          if (!record.attributes) record.attributes = {}
          record.attributes[key] = value as string | number
        },
        end() {
          record.ended = true
        },
      }
      spanToRecord.set(spanObj, record)
      return spanObj
    },
    endSpanOk(span: OTelSpanLike) {
      const record = spanToRecord.get(span as object)
      if (record) {
        record.status = 'ok'
        record.ended = true
      }
      span.end()
    },
    endSpanWithError(span: OTelSpanLike, error: unknown) {
      const record = spanToRecord.get(span as object)
      if (record) {
        record.status = 'error'
        record.error = error
        record.ended = true
      }
      span.end()
    },
  }

  return { tracer, spans }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePipeline(
  overrides: Partial<PipelineDefinition> & {
    nodes?: PipelineNode[]
    edges?: PipelineEdge[]
  } = {},
): PipelineDefinition {
  return {
    id: 'test-pipeline',
    name: 'Test',
    version: '1.0.0',
    schemaVersion: '1.0.0',
    entryNodeId: 'A',
    nodes: [
      { id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
      { id: 'B', type: 'agent', agentId: 'a2', timeoutMs: 5000 },
      { id: 'C', type: 'agent', agentId: 'a3', timeoutMs: 5000 },
    ],
    edges: [
      { type: 'sequential', sourceNodeId: 'A', targetNodeId: 'B' },
      { type: 'sequential', sourceNodeId: 'B', targetNodeId: 'C' },
    ],
    ...overrides,
  }
}

function createMockExecutor(
  results?: Record<string, Partial<NodeResult>>,
): NodeExecutor {
  return async (nodeId: string, _node: PipelineNode, _ctx: NodeExecutionContext): Promise<NodeResult> => {
    const override = results?.[nodeId]
    return {
      nodeId,
      output: override?.output ?? `output-${nodeId}`,
      durationMs: override?.durationMs ?? 1,
      error: override?.error,
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PipelineRuntime — OTel trace propagation', () => {
  it('creates and ends a span for each node on success', async () => {
    const { tracer, spans } = createMockTracer()
    const runtime = new PipelineRuntime({
      definition: makePipeline(),
      nodeExecutor: createMockExecutor(),
      tracer,
    })

    const result = await runtime.execute()

    expect(result.state).toBe('completed')
    // Should have spans for nodes A, B, C
    const nodePhases = spans.filter(s => ['A', 'B', 'C'].includes(s.phase))
    expect(nodePhases).toHaveLength(3)
    for (const span of nodePhases) {
      expect(span.ended).toBe(true)
      expect(span.status).toBe('ok')
    }
  })

  it('calls endSpanWithError when a node fails', async () => {
    const { tracer, spans } = createMockTracer()
    const runtime = new PipelineRuntime({
      definition: makePipeline(),
      nodeExecutor: createMockExecutor({
        B: { error: 'node B exploded' },
      }),
      tracer,
    })

    const result = await runtime.execute()

    expect(result.state).toBe('failed')

    // A should succeed
    const spanA = spans.find(s => s.phase === 'A')
    expect(spanA?.status).toBe('ok')

    // B should fail
    const spanB = spans.find(s => s.phase === 'B')
    expect(spanB?.status).toBe('error')
    expect(spanB?.error).toBe('node B exploded')
    expect(spanB?.ended).toBe(true)
  })

  it('works without tracer (graceful degradation)', async () => {
    const runtime = new PipelineRuntime({
      definition: makePipeline(),
      nodeExecutor: createMockExecutor(),
      // no tracer
    })

    const result = await runtime.execute()

    expect(result.state).toBe('completed')
    expect(result.nodeResults.size).toBe(3)
  })

  it('span attributes include node ID and type', async () => {
    const { tracer, spans } = createMockTracer()
    const runtime = new PipelineRuntime({
      definition: makePipeline(),
      nodeExecutor: createMockExecutor(),
      tracer,
    })

    await runtime.execute()

    const spanA = spans.find(s => s.phase === 'A')
    expect(spanA).toBeDefined()
    expect(spanA?.attributes).toEqual({
      'forge.pipeline.node_type': 'agent',
      'forge.pipeline.phase': 'A',
    })
  })

  it('parallel (fork) nodes each get their own span', async () => {
    const forkNode: ForkNode = { id: 'F', type: 'fork', forkId: 'f1', timeoutMs: 5000 }
    const joinNode: JoinNode = { id: 'J', type: 'join', forkId: 'f1', timeoutMs: 5000 }

    const definition = makePipeline({
      entryNodeId: 'F',
      nodes: [
        forkNode,
        { id: 'B1', type: 'agent', agentId: 'b1', timeoutMs: 5000 },
        { id: 'B2', type: 'agent', agentId: 'b2', timeoutMs: 5000 },
        joinNode,
        { id: 'END', type: 'agent', agentId: 'end', timeoutMs: 5000 },
      ],
      edges: [
        { type: 'sequential', sourceNodeId: 'F', targetNodeId: 'B1' },
        { type: 'sequential', sourceNodeId: 'F', targetNodeId: 'B2' },
        { type: 'sequential', sourceNodeId: 'B1', targetNodeId: 'J' },
        { type: 'sequential', sourceNodeId: 'B2', targetNodeId: 'J' },
        { type: 'sequential', sourceNodeId: 'J', targetNodeId: 'END' },
      ],
    })

    const { tracer, spans } = createMockTracer()
    const runtime = new PipelineRuntime({
      definition,
      nodeExecutor: createMockExecutor(),
      tracer,
    })

    const result = await runtime.execute()

    expect(result.state).toBe('completed')

    // Should have a fork parent span
    const forkSpan = spans.find(s => s.phase === 'fork:f1')
    expect(forkSpan).toBeDefined()
    expect(forkSpan?.attributes?.['forge.pipeline.node_type']).toBe('fork')
    expect(forkSpan?.ended).toBe(true)

    // Should have branch spans for B1 and B2
    const branchSpanB1 = spans.find(s => s.phase === 'branch:B1')
    const branchSpanB2 = spans.find(s => s.phase === 'branch:B2')
    expect(branchSpanB1).toBeDefined()
    expect(branchSpanB2).toBeDefined()
    expect(branchSpanB1?.status).toBe('ok')
    expect(branchSpanB2?.status).toBe('ok')

    // Should also have the END node span
    const endSpan = spans.find(s => s.phase === 'END')
    expect(endSpan).toBeDefined()
    expect(endSpan?.status).toBe('ok')
  })

  it('ends span with error when nodeExecutor throws', async () => {
    const { tracer, spans } = createMockTracer()
    const throwingExecutor: NodeExecutor = async (nodeId) => {
      if (nodeId === 'B') throw new Error('unexpected crash')
      return { nodeId, output: `output-${nodeId}`, durationMs: 1 }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline(),
      nodeExecutor: throwingExecutor,
      tracer,
    })

    const result = await runtime.execute()

    expect(result.state).toBe('failed')

    // B span should be ended with error
    const spanB = spans.find(s => s.phase === 'B')
    expect(spanB?.status).toBe('error')
    expect(spanB?.ended).toBe(true)
  })
})
