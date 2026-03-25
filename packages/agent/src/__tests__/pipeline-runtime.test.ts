import { describe, it, expect, vi } from 'vitest'
import { PipelineRuntime } from '../pipeline/pipeline-runtime.js'
import { InMemoryPipelineCheckpointStore } from '../pipeline/in-memory-checkpoint-store.js'
import { executeLoop, stateFieldTruthy, qualityBelow, hasErrors } from '../pipeline/loop-executor.js'
import type {
  PipelineDefinition,
  PipelineNode,
  PipelineEdge,
  LoopNode,
} from '@forgeagent/core'
import type {
  NodeExecutor,
  NodeResult,
  PipelineRuntimeEvent,
  NodeExecutionContext,
} from '../pipeline/pipeline-runtime-types.js'

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

/** Simple executor that returns canned results keyed by node ID */
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

function collectEvents(events: PipelineRuntimeEvent[]): (event: PipelineRuntimeEvent) => void {
  return (event) => { events.push(event) }
}

// ---------------------------------------------------------------------------
// Linear pipeline
// ---------------------------------------------------------------------------

describe('PipelineRuntime — linear pipeline', () => {
  it('executes A -> B -> C in order', async () => {
    const events: PipelineRuntimeEvent[] = []
    const runtime = new PipelineRuntime({
      definition: makePipeline(),
      nodeExecutor: createMockExecutor(),
      onEvent: collectEvents(events),
    })

    const result = await runtime.execute()

    expect(result.state).toBe('completed')
    expect(result.pipelineId).toBe('test-pipeline')
    expect(result.nodeResults.size).toBe(3)
    expect(result.nodeResults.get('A')?.output).toBe('output-A')
    expect(result.nodeResults.get('B')?.output).toBe('output-B')
    expect(result.nodeResults.get('C')?.output).toBe('output-C')
    expect(runtime.getRunState()).toBe('completed')
  })

  it('emits events in correct order', async () => {
    const events: PipelineRuntimeEvent[] = []
    const runtime = new PipelineRuntime({
      definition: makePipeline(),
      nodeExecutor: createMockExecutor(),
      onEvent: collectEvents(events),
    })

    await runtime.execute()

    const types = events.map(e => e.type)
    expect(types[0]).toBe('pipeline:started')
    expect(types[types.length - 1]).toBe('pipeline:completed')

    // Each node should have started + completed
    const nodeStarted = events.filter(e => e.type === 'pipeline:node_started')
    const nodeCompleted = events.filter(e => e.type === 'pipeline:node_completed')
    expect(nodeStarted.length).toBe(3)
    expect(nodeCompleted.length).toBe(3)
  })

  it('passes initial state to node executor', async () => {
    const captured: Record<string, unknown>[] = []
    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      captured.push({ ...ctx.state })
      return { nodeId, output: null, durationMs: 0 }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline({
        nodes: [{ id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000 }],
        edges: [],
        entryNodeId: 'A',
      }),
      nodeExecutor: executor,
    })

    await runtime.execute({ foo: 'bar' })
    expect(captured[0]).toEqual({ foo: 'bar' })
  })
})

// ---------------------------------------------------------------------------
// Sequential edges route correctly
// ---------------------------------------------------------------------------

describe('PipelineRuntime — sequential edges', () => {
  it('follows sequential edges in order', async () => {
    const order: string[] = []
    const executor: NodeExecutor = async (nodeId, _node, _ctx) => {
      order.push(nodeId)
      return { nodeId, output: nodeId, durationMs: 0 }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline(),
      nodeExecutor: executor,
    })

    await runtime.execute()
    expect(order).toEqual(['A', 'B', 'C'])
  })
})

// ---------------------------------------------------------------------------
// Conditional edges
// ---------------------------------------------------------------------------

describe('PipelineRuntime — conditional edges', () => {
  it('evaluates predicate and follows matching branch', async () => {
    const order: string[] = []
    const executor: NodeExecutor = async (nodeId, _node, _ctx) => {
      order.push(nodeId)
      return { nodeId, output: nodeId, durationMs: 0 }
    }

    const definition = makePipeline({
      nodes: [
        { id: 'start', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
        { id: 'branch-true', type: 'agent', agentId: 'a2', timeoutMs: 5000 },
        { id: 'branch-false', type: 'agent', agentId: 'a3', timeoutMs: 5000 },
      ],
      edges: [
        {
          type: 'conditional',
          sourceNodeId: 'start',
          predicateName: 'isReady',
          branches: { true: 'branch-true', false: 'branch-false' },
        },
      ],
      entryNodeId: 'start',
    })

    const runtime = new PipelineRuntime({
      definition,
      nodeExecutor: executor,
      predicates: {
        isReady: () => true,
      },
    })

    await runtime.execute()
    expect(order).toEqual(['start', 'branch-true'])
  })

  it('follows false branch when predicate returns false', async () => {
    const order: string[] = []
    const executor: NodeExecutor = async (nodeId, _node, _ctx) => {
      order.push(nodeId)
      return { nodeId, output: nodeId, durationMs: 0 }
    }

    const definition = makePipeline({
      nodes: [
        { id: 'start', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
        { id: 'branch-true', type: 'agent', agentId: 'a2', timeoutMs: 5000 },
        { id: 'branch-false', type: 'agent', agentId: 'a3', timeoutMs: 5000 },
      ],
      edges: [
        {
          type: 'conditional',
          sourceNodeId: 'start',
          predicateName: 'isReady',
          branches: { true: 'branch-true', false: 'branch-false' },
        },
      ],
      entryNodeId: 'start',
    })

    const runtime = new PipelineRuntime({
      definition,
      nodeExecutor: executor,
      predicates: {
        isReady: () => false,
      },
    })

    await runtime.execute()
    expect(order).toEqual(['start', 'branch-false'])
  })
})

// ---------------------------------------------------------------------------
// Error edges
// ---------------------------------------------------------------------------

describe('PipelineRuntime — error edges', () => {
  it('routes to error handler on node failure', async () => {
    const order: string[] = []
    const executor: NodeExecutor = async (nodeId, _node, _ctx) => {
      order.push(nodeId)
      if (nodeId === 'B') {
        return { nodeId, output: null, durationMs: 0, error: 'B failed' }
      }
      return { nodeId, output: nodeId, durationMs: 0 }
    }

    const definition = makePipeline({
      nodes: [
        { id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
        { id: 'B', type: 'agent', agentId: 'a2', timeoutMs: 5000 },
        { id: 'C', type: 'agent', agentId: 'a3', timeoutMs: 5000 },
        { id: 'err-handler', type: 'agent', agentId: 'err', timeoutMs: 5000 },
      ],
      edges: [
        { type: 'sequential', sourceNodeId: 'A', targetNodeId: 'B' },
        { type: 'sequential', sourceNodeId: 'B', targetNodeId: 'C' },
        { type: 'error', sourceNodeId: 'B', targetNodeId: 'err-handler' },
      ],
    })

    const runtime = new PipelineRuntime({
      definition,
      nodeExecutor: executor,
    })

    const result = await runtime.execute()
    expect(order).toEqual(['A', 'B', 'err-handler'])
    expect(result.state).toBe('completed')
  })

  it('fails pipeline when no error handler exists', async () => {
    const executor: NodeExecutor = async (nodeId) => {
      if (nodeId === 'B') {
        return { nodeId, output: null, durationMs: 0, error: 'B exploded' }
      }
      return { nodeId, output: nodeId, durationMs: 0 }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline(),
      nodeExecutor: executor,
    })

    const result = await runtime.execute()
    expect(result.state).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// ForkNode / JoinNode
// ---------------------------------------------------------------------------

describe('PipelineRuntime — fork/join', () => {
  it('executes branches in parallel', async () => {
    const executed = new Set<string>()
    const executor: NodeExecutor = async (nodeId) => {
      executed.add(nodeId)
      return { nodeId, output: `result-${nodeId}`, durationMs: 1 }
    }

    const definition = makePipeline({
      entryNodeId: 'fork1',
      nodes: [
        { id: 'fork1', type: 'fork', forkId: 'f1', timeoutMs: 5000 },
        { id: 'branch-a', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
        { id: 'branch-b', type: 'agent', agentId: 'a2', timeoutMs: 5000 },
        { id: 'join1', type: 'join', forkId: 'f1', mergeStrategy: 'all', timeoutMs: 5000 },
        { id: 'after', type: 'agent', agentId: 'a3', timeoutMs: 5000 },
      ],
      edges: [
        { type: 'sequential', sourceNodeId: 'fork1', targetNodeId: 'branch-a' },
        { type: 'sequential', sourceNodeId: 'fork1', targetNodeId: 'branch-b' },
        { type: 'sequential', sourceNodeId: 'branch-a', targetNodeId: 'join1' },
        { type: 'sequential', sourceNodeId: 'branch-b', targetNodeId: 'join1' },
        { type: 'sequential', sourceNodeId: 'join1', targetNodeId: 'after' },
      ],
    })

    const runtime = new PipelineRuntime({
      definition,
      nodeExecutor: executor,
    })

    const result = await runtime.execute()
    expect(result.state).toBe('completed')
    expect(executed.has('branch-a')).toBe(true)
    expect(executed.has('branch-b')).toBe(true)
    expect(executed.has('after')).toBe(true)
    expect(result.nodeResults.get('branch-a')?.output).toBe('result-branch-a')
    expect(result.nodeResults.get('branch-b')?.output).toBe('result-branch-b')
  })
})

// ---------------------------------------------------------------------------
// SuspendNode
// ---------------------------------------------------------------------------

describe('PipelineRuntime — suspend', () => {
  it('suspends pipeline and returns suspended state', async () => {
    const events: PipelineRuntimeEvent[] = []
    const executor: NodeExecutor = async (nodeId) => {
      return { nodeId, output: nodeId, durationMs: 0 }
    }

    const definition = makePipeline({
      nodes: [
        { id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
        { id: 'pause', type: 'suspend', timeoutMs: 5000 },
        { id: 'B', type: 'agent', agentId: 'a2', timeoutMs: 5000 },
      ],
      edges: [
        { type: 'sequential', sourceNodeId: 'A', targetNodeId: 'pause' },
        { type: 'sequential', sourceNodeId: 'pause', targetNodeId: 'B' },
      ],
    })

    const store = new InMemoryPipelineCheckpointStore()
    const runtime = new PipelineRuntime({
      definition,
      nodeExecutor: executor,
      checkpointStore: store,
      onEvent: collectEvents(events),
    })

    const result = await runtime.execute()
    expect(result.state).toBe('suspended')
    expect(runtime.getRunState()).toBe('suspended')

    // Checkpoint should be saved
    const suspendEvents = events.filter(e => e.type === 'pipeline:suspended')
    expect(suspendEvents.length).toBe(1)

    const checkpointEvents = events.filter(e => e.type === 'pipeline:checkpoint_saved')
    expect(checkpointEvents.length).toBe(1)
  })

  it('GateNode with approval type suspends pipeline', async () => {
    const executor: NodeExecutor = async (nodeId) => {
      return { nodeId, output: nodeId, durationMs: 0 }
    }

    const definition = makePipeline({
      nodes: [
        { id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
        { id: 'gate', type: 'gate', gateType: 'approval', timeoutMs: 5000 },
        { id: 'B', type: 'agent', agentId: 'a2', timeoutMs: 5000 },
      ],
      edges: [
        { type: 'sequential', sourceNodeId: 'A', targetNodeId: 'gate' },
        { type: 'sequential', sourceNodeId: 'gate', targetNodeId: 'B' },
      ],
    })

    const runtime = new PipelineRuntime({
      definition,
      nodeExecutor: executor,
    })

    const result = await runtime.execute()
    expect(result.state).toBe('suspended')
  })
})

// ---------------------------------------------------------------------------
// Resume from checkpoint
// ---------------------------------------------------------------------------

describe('PipelineRuntime — resume', () => {
  it('resumes from checkpoint and continues execution', async () => {
    const order: string[] = []
    const executor: NodeExecutor = async (nodeId) => {
      order.push(nodeId)
      return { nodeId, output: nodeId, durationMs: 0 }
    }

    const definition = makePipeline({
      nodes: [
        { id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
        { id: 'pause', type: 'suspend', timeoutMs: 5000 },
        { id: 'B', type: 'agent', agentId: 'a2', timeoutMs: 5000 },
        { id: 'C', type: 'agent', agentId: 'a3', timeoutMs: 5000 },
      ],
      edges: [
        { type: 'sequential', sourceNodeId: 'A', targetNodeId: 'pause' },
        { type: 'sequential', sourceNodeId: 'pause', targetNodeId: 'B' },
        { type: 'sequential', sourceNodeId: 'B', targetNodeId: 'C' },
      ],
    })

    const store = new InMemoryPipelineCheckpointStore()

    // First run — will suspend
    const runtime1 = new PipelineRuntime({
      definition,
      nodeExecutor: executor,
      checkpointStore: store,
    })
    const result1 = await runtime1.execute()
    expect(result1.state).toBe('suspended')
    expect(order).toEqual(['A'])

    // Load checkpoint
    const checkpoint = await store.load(result1.runId)
    expect(checkpoint).toBeDefined()

    // Resume
    order.length = 0
    const runtime2 = new PipelineRuntime({
      definition,
      nodeExecutor: executor,
      checkpointStore: store,
    })
    const result2 = await runtime2.resume(checkpoint!)
    expect(result2.state).toBe('completed')
    expect(order).toEqual(['B', 'C'])
  })
})

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

describe('PipelineRuntime — cancel', () => {
  it('cancels execution via cancel()', async () => {
    let callCount = 0
    const executor: NodeExecutor = async (nodeId, _node, _ctx) => {
      callCount++
      if (callCount === 1) {
        // Cancel after first node completes
        runtime.cancel('test cancel')
      }
      return { nodeId, output: nodeId, durationMs: 0 }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline(),
      nodeExecutor: executor,
    })

    const result = await runtime.execute()
    expect(result.state).toBe('cancelled')
    expect(runtime.getRunState()).toBe('cancelled')
  })

  it('cancels execution via AbortSignal', async () => {
    const controller = new AbortController()
    let callCount = 0
    const executor: NodeExecutor = async (nodeId) => {
      callCount++
      if (callCount === 1) {
        controller.abort()
      }
      return { nodeId, output: nodeId, durationMs: 0 }
    }

    const runtime = new PipelineRuntime({
      definition: makePipeline(),
      nodeExecutor: executor,
      signal: controller.signal,
    })

    const result = await runtime.execute()
    expect(result.state).toBe('cancelled')
  })
})

// ---------------------------------------------------------------------------
// Checkpointing
// ---------------------------------------------------------------------------

describe('PipelineRuntime — checkpointing', () => {
  it('saves checkpoint after each node with after_each_node strategy', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const events: PipelineRuntimeEvent[] = []

    const runtime = new PipelineRuntime({
      definition: makePipeline({ checkpointStrategy: 'after_each_node' }),
      nodeExecutor: createMockExecutor(),
      checkpointStore: store,
      onEvent: collectEvents(events),
    })

    const result = await runtime.execute()
    expect(result.state).toBe('completed')

    const checkpointEvents = events.filter(e => e.type === 'pipeline:checkpoint_saved')
    expect(checkpointEvents.length).toBe(3) // one per node A, B, C

    // Verify checkpoint versions are incrementing
    const versions = await store.listVersions(result.runId)
    expect(versions.length).toBe(3)
    expect(versions[0]?.version).toBe(1)
    expect(versions[1]?.version).toBe(2)
    expect(versions[2]?.version).toBe(3)
  })

  it('does not save checkpoints with none strategy', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const events: PipelineRuntimeEvent[] = []

    const runtime = new PipelineRuntime({
      definition: makePipeline({ checkpointStrategy: 'none' }),
      nodeExecutor: createMockExecutor(),
      checkpointStore: store,
      onEvent: collectEvents(events),
    })

    await runtime.execute()

    const checkpointEvents = events.filter(e => e.type === 'pipeline:checkpoint_saved')
    expect(checkpointEvents.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('PipelineRuntime — validation', () => {
  it('throws on invalid pipeline', async () => {
    const runtime = new PipelineRuntime({
      definition: makePipeline({ entryNodeId: 'nonexistent' }),
      nodeExecutor: createMockExecutor(),
    })

    await expect(runtime.execute()).rejects.toThrow('Pipeline validation failed')
  })
})

// ---------------------------------------------------------------------------
// Loop executor
// ---------------------------------------------------------------------------

describe('executeLoop', () => {
  it('executes body nodes and terminates on condition', async () => {
    let iteration = 0
    const executor: NodeExecutor = async (nodeId) => {
      iteration++
      return { nodeId, output: `iter-${iteration}`, durationMs: 1 }
    }

    const loopNode: LoopNode = {
      id: 'loop1',
      type: 'loop',
      bodyNodeIds: ['body1'],
      maxIterations: 10,
      continuePredicateName: 'shouldContinue',
      timeoutMs: 5000,
    }

    const bodyNodes: PipelineNode[] = [
      { id: 'body1', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
    ]

    const state: Record<string, unknown> = { counter: 0 }
    const context: NodeExecutionContext = {
      state,
      previousResults: new Map(),
    }

    const events: PipelineRuntimeEvent[] = []
    const { result, metrics } = await executeLoop(
      loopNode,
      bodyNodes,
      executor,
      context,
      {
        shouldContinue: (s) => {
          const count = (s['counter'] as number | undefined) ?? 0
          s['counter'] = count + 1
          return count < 3
        },
      },
      collectEvents(events),
    )

    expect(result.error).toBeUndefined()
    expect(metrics.iterationCount).toBe(4) // 0,1,2 continue; 3 stops
    expect(metrics.converged).toBe(true)
    expect(metrics.terminationReason).toBe('condition_met')

    const loopEvents = events.filter(e => e.type === 'pipeline:loop_iteration')
    expect(loopEvents.length).toBe(4)
  })

  it('terminates at maxIterations', async () => {
    const executor: NodeExecutor = async (nodeId) => {
      return { nodeId, output: 'ok', durationMs: 0 }
    }

    const loopNode: LoopNode = {
      id: 'loop1',
      type: 'loop',
      bodyNodeIds: ['body1'],
      maxIterations: 3,
      continuePredicateName: 'alwaysTrue',
      timeoutMs: 5000,
    }

    const bodyNodes: PipelineNode[] = [
      { id: 'body1', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
    ]

    const context: NodeExecutionContext = {
      state: {},
      previousResults: new Map(),
    }

    const { metrics } = await executeLoop(
      loopNode,
      bodyNodes,
      executor,
      context,
      { alwaysTrue: () => true },
    )

    expect(metrics.iterationCount).toBe(3)
    expect(metrics.converged).toBe(false)
    expect(metrics.terminationReason).toBe('max_iterations')
  })

  it('fails when failOnMaxIterations is true', async () => {
    const executor: NodeExecutor = async (nodeId) => {
      return { nodeId, output: 'ok', durationMs: 0 }
    }

    const loopNode: LoopNode = {
      id: 'loop1',
      type: 'loop',
      bodyNodeIds: ['body1'],
      maxIterations: 2,
      continuePredicateName: 'alwaysTrue',
      failOnMaxIterations: true,
      timeoutMs: 5000,
    }

    const bodyNodes: PipelineNode[] = [
      { id: 'body1', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
    ]

    const context: NodeExecutionContext = {
      state: {},
      previousResults: new Map(),
    }

    const { result, metrics } = await executeLoop(
      loopNode,
      bodyNodes,
      executor,
      context,
      { alwaysTrue: () => true },
    )

    expect(result.error).toBeDefined()
    expect(result.error).toContain('maxIterations')
    expect(metrics.terminationReason).toBe('max_iterations')
  })

  it('throws when predicate is not found', async () => {
    const executor: NodeExecutor = async (nodeId) => {
      return { nodeId, output: 'ok', durationMs: 0 }
    }

    const loopNode: LoopNode = {
      id: 'loop1',
      type: 'loop',
      bodyNodeIds: ['body1'],
      maxIterations: 5,
      continuePredicateName: 'missing',
      timeoutMs: 5000,
    }

    const bodyNodes: PipelineNode[] = [
      { id: 'body1', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
    ]

    const context: NodeExecutionContext = {
      state: {},
      previousResults: new Map(),
    }

    await expect(
      executeLoop(loopNode, bodyNodes, executor, context, {}),
    ).rejects.toThrow('predicate "missing" not found')
  })
})

// ---------------------------------------------------------------------------
// Loop in pipeline runtime
// ---------------------------------------------------------------------------

describe('PipelineRuntime — loop node', () => {
  it('executes loop within pipeline', async () => {
    let bodyCallCount = 0
    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      if (nodeId === 'body1') {
        bodyCallCount++
        ctx.state['quality'] = bodyCallCount * 30
      }
      return { nodeId, output: `result-${nodeId}`, durationMs: 1 }
    }

    const definition = makePipeline({
      entryNodeId: 'start',
      nodes: [
        { id: 'start', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
        {
          id: 'loop1',
          type: 'loop',
          bodyNodeIds: ['body1'],
          maxIterations: 10,
          continuePredicateName: 'qualityCheck',
          timeoutMs: 5000,
        },
        { id: 'body1', type: 'agent', agentId: 'a2', timeoutMs: 5000 },
        { id: 'end', type: 'agent', agentId: 'a3', timeoutMs: 5000 },
      ],
      edges: [
        { type: 'sequential', sourceNodeId: 'start', targetNodeId: 'loop1' },
        { type: 'sequential', sourceNodeId: 'loop1', targetNodeId: 'end' },
      ],
    })

    const runtime = new PipelineRuntime({
      definition,
      nodeExecutor: executor,
      predicates: {
        qualityCheck: (state) => {
          const quality = state['quality'] as number | undefined
          return (quality ?? 0) < 80 // continue while quality < 80
        },
      },
    })

    const result = await runtime.execute()
    expect(result.state).toBe('completed')
    expect(bodyCallCount).toBe(3) // 30, 60, 90 (stops after 3rd iteration because 90 >= 80)
    expect(result.nodeResults.has('loop1')).toBe(true)
    expect(result.nodeResults.has('end')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Built-in predicate helpers
// ---------------------------------------------------------------------------

describe('Built-in predicate helpers', () => {
  describe('stateFieldTruthy', () => {
    it('returns true for truthy values', () => {
      const pred = stateFieldTruthy('active')
      expect(pred({ active: true })).toBe(true)
      expect(pred({ active: 1 })).toBe(true)
      expect(pred({ active: 'yes' })).toBe(true)
    })

    it('returns false for falsy values', () => {
      const pred = stateFieldTruthy('active')
      expect(pred({ active: false })).toBe(false)
      expect(pred({ active: 0 })).toBe(false)
      expect(pred({ active: '' })).toBe(false)
      expect(pred({ active: null })).toBe(false)
      expect(pred({})).toBe(false)
    })
  })

  describe('qualityBelow', () => {
    it('returns true when value is below threshold', () => {
      const pred = qualityBelow('score', 80)
      expect(pred({ score: 50 })).toBe(true)
      expect(pred({ score: 79 })).toBe(true)
    })

    it('returns false when value meets or exceeds threshold', () => {
      const pred = qualityBelow('score', 80)
      expect(pred({ score: 80 })).toBe(false)
      expect(pred({ score: 100 })).toBe(false)
    })

    it('returns true when field is missing or not a number', () => {
      const pred = qualityBelow('score', 80)
      expect(pred({})).toBe(true)
      expect(pred({ score: 'hello' })).toBe(true)
    })
  })

  describe('hasErrors', () => {
    it('returns true when array has elements', () => {
      const pred = hasErrors('errors')
      expect(pred({ errors: ['e1', 'e2'] })).toBe(true)
      expect(pred({ errors: [1] })).toBe(true)
    })

    it('returns false when array is empty', () => {
      const pred = hasErrors('errors')
      expect(pred({ errors: [] })).toBe(false)
    })

    it('returns false when field is not an array', () => {
      const pred = hasErrors('errors')
      expect(pred({})).toBe(false)
      expect(pred({ errors: 'not array' })).toBe(false)
      expect(pred({ errors: 42 })).toBe(false)
    })
  })
})
