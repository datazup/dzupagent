import { describe, expect, it } from 'vitest'
import { PipelineRuntime } from '../pipeline/pipeline-runtime.js'
import { InMemoryPipelineCheckpointStore } from '../pipeline/in-memory-checkpoint-store.js'
import type { PipelineDefinition, PipelineNode } from '@dzupagent/core'
import type {
  NodeExecutor,
  PipelineRuntimeEvent,
} from '../pipeline/pipeline-runtime-types.js'

function forEachPipeline(concurrency = 1): PipelineDefinition {
  return {
    id: 'for-each-runtime',
    name: 'ForEachRuntime',
    version: '1.0.0',
    schemaVersion: '1.0.0',
    entryNodeId: 'loop-items',
    nodes: [
      {
        id: 'loop-items',
        type: 'loop',
        bodyNodeIds: ['classify-item'],
        maxIterations: 1000,
        continuePredicateName: 'forEach__item__predicate',
        forEach: {
          source: '$.items',
          as: 'item',
          order: 'input',
          collect: {
            from: 'itemStatus',
            into: 'itemStatuses',
            order: 'input',
          },
          concurrency,
          empty: {
            body: 'skip',
            aggregate: 'empty-array',
          },
        },
      },
      {
        id: 'classify-item',
        type: 'agent',
        agentId: 'classifier',
        timeoutMs: 5000,
      },
    ],
    edges: [],
  }
}

function forEachAccumulatorPipeline(concurrency = 1): PipelineDefinition {
  return {
    id: 'for-each-accumulator-runtime',
    name: 'ForEachAccumulatorRuntime',
    version: '1.0.0',
    schemaVersion: '1.0.0',
    entryNodeId: 'loop-items',
    nodes: [
      {
        id: 'loop-items',
        type: 'loop',
        bodyNodeIds: ['enrich-item'],
        maxIterations: 1000,
        continuePredicateName: 'forEach__item__predicate',
        forEach: {
          source: '$.items',
          as: 'item',
          order: 'input',
          attachAs: 'processed',
          accumulator: {
            key: 'recentItems',
            window: 2,
            initialValue: [{ id: 'seed', processed: 'seed:ok' }],
          },
          concurrency,
          empty: {
            body: 'skip',
            aggregate: 'empty-array',
          },
        },
      },
      {
        id: 'enrich-item',
        type: 'agent',
        agentId: 'enricher',
        timeoutMs: 5000,
      },
    ],
    edges: [],
  }
}

function aggregateEvents(events: PipelineRuntimeEvent[]): Array<{
  type: string
  nodeId: string
  aggregateKey?: string
  aggregateKeys?: string[]
  source?: string
  attachAs?: string
  accumulatorKey?: string
  count?: number
  order?: string
  empty?: boolean
}> {
  return events.filter(
    (event): event is {
      type: string
      nodeId: string
      aggregateKey?: string
      aggregateKeys?: string[]
      source?: string
      attachAs?: string
      accumulatorKey?: string
      count?: number
      order?: string
      empty?: boolean
    } => event.type === 'pipeline:for_each_aggregate',
  )
}

describe('PipelineRuntime — lowered for_each collect', () => {
  it('skips the body for an empty collection and initializes the aggregate to []', async () => {
    const events: PipelineRuntimeEvent[] = []
    const calls: string[] = []
    const executor: NodeExecutor = async (nodeId) => {
      calls.push(nodeId)
      return { nodeId, output: null, durationMs: 1 }
    }
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: executor,
      onEvent: (event) => events.push(event),
    })

    const result = await runtime.execute({ items: [] })

    expect(result.state).toBe('completed')
    expect(calls).toEqual([])
    expect(result.nodeResults.get('loop-items')?.output).toEqual({
      loopOutput: [],
      metrics: {
        iterationCount: 0,
        iterationDurations: [],
        converged: true,
        terminationReason: 'condition_met',
      },
    })
    expect(
      (result.nodeResults.get('loop-items')?.output as { loopOutput: unknown })
        .loopOutput,
    ).toEqual([])
    expect(aggregateEvents(events)).toEqual([
      {
        type: 'pipeline:for_each_aggregate',
        nodeId: 'loop-items',
        aggregateKey: 'itemStatuses',
        aggregateKeys: ['itemStatuses'],
        source: '$.items',
        count: 0,
        order: 'input',
        empty: true,
      },
    ])
  })

  it('collects body state output in source order while running with bounded concurrency', async () => {
    const events: PipelineRuntimeEvent[] = []
    const started: string[] = []
    let active = 0
    let maxActive = 0
    const delays: Record<string, number> = { a: 30, b: 5, c: 15, d: 1 }
    const executor: NodeExecutor = async (
      nodeId: string,
      _node: PipelineNode,
      ctx,
    ) => {
      const item = ctx.state['item'] as { id: string; status: string }
      started.push(item.id)
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, delays[item.id] ?? 0))
      ctx.state['itemStatus'] = `${item.id}:${item.status}`
      active -= 1
      return { nodeId, output: ctx.state['itemStatus'], durationMs: 1 }
    }
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(2),
      nodeExecutor: executor,
      onEvent: (event) => events.push(event),
    })

    const result = await runtime.execute({
      items: [
        { id: 'a', status: 'ready' },
        { id: 'b', status: 'blocked' },
        { id: 'c', status: 'ready' },
        { id: 'd', status: 'blocked' },
      ],
    })

    expect(result.state).toBe('completed')
    expect(started).toEqual(['a', 'b', 'c', 'd'])
    expect(maxActive).toBe(2)
    expect(result.nodeResults.get('loop-items')?.output).toEqual({
      loopOutput: ['a:ready', 'b:blocked', 'c:ready', 'd:blocked'],
      metrics: {
        iterationCount: 4,
        iterationDurations: expect.arrayContaining([
          expect.any(Number),
          expect.any(Number),
          expect.any(Number),
          expect.any(Number),
        ]),
        converged: true,
        terminationReason: 'condition_met',
      },
    })
    expect(aggregateEvents(events)).toEqual([
      {
        type: 'pipeline:for_each_aggregate',
        nodeId: 'loop-items',
        aggregateKey: 'itemStatuses',
        aggregateKeys: ['itemStatuses'],
        source: '$.items',
        count: 4,
        order: 'input',
        empty: false,
      },
    ])
  })

  it('enriches source items with attachAs and maintains a windowed accumulator', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const events: PipelineRuntimeEvent[] = []
    const executor: NodeExecutor = async (
      nodeId: string,
      _node: PipelineNode,
      ctx,
    ) => {
      const item = ctx.state['item'] as { id: string; status: string }
      ctx.state['item'] = {
        ...item,
        processed: `${item.id}:${item.status}`,
      }
      return { nodeId, output: ctx.state['item'], durationMs: 1 }
    }
    const runtime = new PipelineRuntime({
      definition: {
        ...forEachAccumulatorPipeline(),
        checkpointStrategy: 'after_each_node',
      },
      nodeExecutor: executor,
      checkpointStore: store,
      onEvent: (event) => events.push(event),
    })

    const result = await runtime.execute({
      items: [
        { id: 'a', status: 'ready' },
        { id: 'b', status: 'blocked' },
        { id: 'c', status: 'ready' },
      ],
    })

    expect(result.state).toBe('completed')
    expect(result.nodeResults.get('loop-items')?.output).toEqual({
      loopOutput: [
        {
          id: 'a',
          status: 'ready',
          processed: { id: 'a', status: 'ready', processed: 'a:ready' },
        },
        {
          id: 'b',
          status: 'blocked',
          processed: { id: 'b', status: 'blocked', processed: 'b:blocked' },
        },
        {
          id: 'c',
          status: 'ready',
          processed: { id: 'c', status: 'ready', processed: 'c:ready' },
        },
      ],
      metrics: {
        iterationCount: 3,
        iterationDurations: expect.arrayContaining([
          expect.any(Number),
          expect.any(Number),
          expect.any(Number),
        ]),
        converged: true,
        terminationReason: 'condition_met',
      },
    })
    const finalCheckpoint = await store.load(result.runId)
    expect(finalCheckpoint?.state['items']).toEqual([
      {
        id: 'a',
        status: 'ready',
        processed: { id: 'a', status: 'ready', processed: 'a:ready' },
      },
      {
        id: 'b',
        status: 'blocked',
        processed: { id: 'b', status: 'blocked', processed: 'b:blocked' },
      },
      {
        id: 'c',
        status: 'ready',
        processed: { id: 'c', status: 'ready', processed: 'c:ready' },
      },
    ])
    expect(finalCheckpoint?.state['recentItems']).toEqual([
      { id: 'b', status: 'blocked', processed: 'b:blocked' },
      { id: 'c', status: 'ready', processed: 'c:ready' },
    ])
    expect(aggregateEvents(events)).toEqual([
      {
        type: 'pipeline:for_each_aggregate',
        nodeId: 'loop-items',
        aggregateKeys: ['$.items.processed', 'recentItems'],
        source: '$.items',
        attachAs: 'processed',
        accumulatorKey: 'recentItems',
        count: 3,
        order: 'input',
        empty: false,
      },
    ])
  })

  it('checkpoints a contiguous for_each item cursor and resumes without re-running completed items', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const bodyRuns: string[] = []
    const crashingExecutor: NodeExecutor = async (
      nodeId: string,
      _node: PipelineNode,
      ctx,
    ) => {
      const item = ctx.state['item'] as { id: string; status: string }
      bodyRuns.push(item.id)
      if (item.id === 'c') {
        throw new Error('simulated crash mid-for-each')
      }
      ctx.state['itemStatus'] = `${item.id}:${item.status}`
      return { nodeId, output: ctx.state['itemStatus'], durationMs: 1 }
    }
    const first = new PipelineRuntime({
      definition: {
        ...forEachPipeline(),
        checkpointStrategy: 'after_each_node',
      },
      nodeExecutor: crashingExecutor,
      checkpointStore: store,
    })

    const firstResult = await first.execute({
      items: [
        { id: 'a', status: 'ready' },
        { id: 'b', status: 'blocked' },
        { id: 'c', status: 'ready' },
      ],
    })

    expect(firstResult.state).toBe('failed')
    expect(bodyRuns).toEqual(['a', 'b', 'c'])
    const checkpoint = await store.load(firstResult.runId)
    expect(checkpoint?.loopState?.['loop-items']).toEqual({ iteration: 2 })
    expect(checkpoint?.state['itemStatuses']).toEqual([
      'a:ready',
      'b:blocked',
    ])

    const resumeRuns: string[] = []
    const healthyExecutor: NodeExecutor = async (
      nodeId: string,
      _node: PipelineNode,
      ctx,
    ) => {
      const item = ctx.state['item'] as { id: string; status: string }
      resumeRuns.push(item.id)
      ctx.state['itemStatus'] = `${item.id}:${item.status}`
      return { nodeId, output: ctx.state['itemStatus'], durationMs: 1 }
    }
    const second = new PipelineRuntime({
      definition: {
        ...forEachPipeline(),
        checkpointStrategy: 'after_each_node',
      },
      nodeExecutor: healthyExecutor,
      checkpointStore: store,
    })

    const resumed = await second.resume(checkpoint!)

    expect(resumed.state).toBe('completed')
    expect(resumeRuns).toEqual(['c'])
    expect(resumed.nodeResults.get('loop-items')?.output).toMatchObject({
      loopOutput: ['a:ready', 'b:blocked', 'c:ready'],
      metrics: {
        iterationCount: 3,
        converged: true,
        terminationReason: 'condition_met',
      },
    })
  })

  it('persists only the contiguous completed prefix when concurrent items finish out of order before failure', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const bodyRuns: string[] = []
    const delays: Record<string, number> = { a: 35, b: 5, c: 10, d: 1 }
    const crashingExecutor: NodeExecutor = async (
      nodeId: string,
      _node: PipelineNode,
      ctx,
    ) => {
      const item = ctx.state['item'] as { id: string; status: string }
      bodyRuns.push(item.id)
      await new Promise((resolve) => setTimeout(resolve, delays[item.id] ?? 0))
      if (item.id === 'c') {
        throw new Error('simulated out-of-order for_each failure')
      }
      ctx.state['itemStatus'] = `${item.id}:${item.status}`
      return { nodeId, output: ctx.state['itemStatus'], durationMs: 1 }
    }
    const first = new PipelineRuntime({
      definition: {
        ...forEachPipeline(3),
        checkpointStrategy: 'after_each_node',
      },
      nodeExecutor: crashingExecutor,
      checkpointStore: store,
    })

    const firstResult = await first.execute({
      items: [
        { id: 'a', status: 'ready' },
        { id: 'b', status: 'blocked' },
        { id: 'c', status: 'ready' },
        { id: 'd', status: 'blocked' },
      ],
    })

    expect(firstResult.state).toBe('failed')
    expect(bodyRuns).toEqual(['a', 'b', 'c', 'd'])
    const checkpoint = await store.load(firstResult.runId)
    expect(checkpoint?.loopState?.['loop-items']).toEqual({ iteration: 2 })
    expect(checkpoint?.state['itemStatuses']).toEqual([
      'a:ready',
      'b:blocked',
    ])

    const resumeRuns: string[] = []
    const healthyExecutor: NodeExecutor = async (
      nodeId: string,
      _node: PipelineNode,
      ctx,
    ) => {
      const item = ctx.state['item'] as { id: string; status: string }
      resumeRuns.push(item.id)
      ctx.state['itemStatus'] = `${item.id}:${item.status}`
      return { nodeId, output: ctx.state['itemStatus'], durationMs: 1 }
    }
    const second = new PipelineRuntime({
      definition: {
        ...forEachPipeline(3),
        checkpointStrategy: 'after_each_node',
      },
      nodeExecutor: healthyExecutor,
      checkpointStore: store,
    })

    const resumed = await second.resume(checkpoint!)

    expect(resumed.state).toBe('completed')
    expect(resumeRuns).toEqual(['c', 'd'])
    expect(resumed.nodeResults.get('loop-items')?.output).toMatchObject({
      loopOutput: ['a:ready', 'b:blocked', 'c:ready', 'd:blocked'],
      metrics: {
        iterationCount: 4,
        converged: true,
        terminationReason: 'condition_met',
      },
    })
  })
})
