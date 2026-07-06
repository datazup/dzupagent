import { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { PipelineRuntime } from '../pipeline/pipeline-runtime.js'
import { InMemoryPipelineCheckpointStore } from '../pipeline/in-memory-checkpoint-store.js'
import {
  RedisPipelineCheckpointStore,
  type RedisClientLike,
} from '../pipeline/redis-checkpoint-store.js'
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

  it('resumes a concurrent for_each failure from a Redis-backed checkpoint store', async () => {
    const store = new RedisPipelineCheckpointStore({
      client: new MockRedisClient(),
      keyPrefix: 'test:for-each',
    })
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
        throw new Error('simulated redis-backed for_each failure')
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

  const maybeLiveRedisIt = process.env.DZUPAGENT_REDIS_URL ? it : it.skip

  maybeLiveRedisIt(
    'resumes a concurrent for_each failure from a live Redis checkpoint store',
    async () => {
      const client = await LiveRedisClient.connect(process.env.DZUPAGENT_REDIS_URL!)
      const keyPrefix = `test:for-each-live:${Date.now()}`
      const store = new RedisPipelineCheckpointStore({
        client,
        keyPrefix,
      })
      try {
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
            throw new Error('simulated live redis for_each failure')
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
      } finally {
        await client.del(`${keyPrefix}:runs`)
        client.close()
      }
    },
    10_000,
  )
})

class MockRedisClient implements RedisClientLike {
  strings = new Map<string, string>()
  sortedSets = new Map<string, Map<string, number>>()
  sets = new Map<string, Set<string>>()

  async set(
    key: string,
    value: string,
    ..._modifiers: Array<string | number>
  ): Promise<'OK'> {
    this.strings.set(key, value)
    return 'OK'
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0
    for (const key of keys) {
      if (this.strings.delete(key)) count += 1
      if (this.sortedSets.delete(key)) count += 1
      if (this.sets.delete(key)) count += 1
    }
    return count
  }

  async zadd(key: string, ...scoreMembers: Array<string | number>): Promise<number> {
    let zset = this.sortedSets.get(key)
    if (!zset) {
      zset = new Map()
      this.sortedSets.set(key, zset)
    }
    let added = 0
    for (let index = 0; index < scoreMembers.length; index += 2) {
      const score = Number(scoreMembers[index])
      const member = String(scoreMembers[index + 1])
      if (!zset.has(member)) added += 1
      zset.set(member, score)
    }
    return added
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const zset = this.sortedSets.get(key)
    if (!zset) return []
    const sorted = [...zset.entries()]
      .sort((left, right) => left[1] - right[1])
      .map(([member]) => member)
    const end = stop === -1 ? sorted.length : stop + 1
    return sorted.slice(start, end)
  }

  async zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    const zset = this.sortedSets.get(key)
    if (!zset) return []
    const sorted = [...zset.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([member]) => member)
    const end = stop === -1 ? sorted.length : stop + 1
    return sorted.slice(start, end)
  }

  async zscore(key: string, member: string): Promise<string | null> {
    const score = this.sortedSets.get(key)?.get(member)
    return score === undefined ? null : String(score)
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const zset = this.sortedSets.get(key)
    if (!zset) return 0
    let removed = 0
    for (const member of members) {
      if (zset.delete(member)) removed += 1
    }
    return removed
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    let set = this.sets.get(key)
    if (!set) {
      set = new Set()
      this.sets.set(key, set)
    }
    let added = 0
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member)
        added += 1
      }
    }
    return added
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key)
    if (!set) return 0
    let removed = 0
    for (const member of members) {
      if (set.delete(member)) removed += 1
    }
    return removed
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])]
  }

  async exists(key: string): Promise<number> {
    return this.strings.has(key) || this.sortedSets.has(key) || this.sets.has(key)
      ? 1
      : 0
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    return 1
  }
}

class LiveRedisClient implements RedisClientLike {
  private pending = Promise.resolve()

  private constructor(private readonly socket: Socket) {}

  static async connect(rawUrl: string): Promise<LiveRedisClient> {
    const url = new URL(rawUrl)
    const socket = new Socket()
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.connect(Number(url.port || 6379), url.hostname || '127.0.0.1', () => {
        socket.off('error', reject)
        resolve()
      })
    })
    const client = new LiveRedisClient(socket)
    if (url.password) {
      await client.command('AUTH', url.password)
    }
    if (url.pathname && url.pathname !== '/') {
      await client.command('SELECT', url.pathname.slice(1))
    }
    return client
  }

  close(): void {
    this.socket.destroy()
  }

  set(
    key: string,
    value: string,
    ...modifiers: Array<string | number>
  ): Promise<unknown> {
    return this.command('SET', key, value, ...modifiers)
  }

  get(key: string): Promise<string | null> {
    return this.command('GET', key) as Promise<string | null>
  }

  del(...keys: string[]): Promise<number> {
    return this.command('DEL', ...keys) as Promise<number>
  }

  zadd(key: string, ...scoreMembers: Array<string | number>): Promise<unknown> {
    return this.command('ZADD', key, ...scoreMembers)
  }

  zrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.command('ZRANGE', key, start, stop) as Promise<string[]>
  }

  zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.command('ZREVRANGE', key, start, stop) as Promise<string[]>
  }

  zscore(key: string, member: string): Promise<string | null> {
    return this.command('ZSCORE', key, member) as Promise<string | null>
  }

  zrem(key: string, ...members: string[]): Promise<number> {
    return this.command('ZREM', key, ...members) as Promise<number>
  }

  sadd(key: string, ...members: string[]): Promise<number> {
    return this.command('SADD', key, ...members) as Promise<number>
  }

  srem(key: string, ...members: string[]): Promise<number> {
    return this.command('SREM', key, ...members) as Promise<number>
  }

  smembers(key: string): Promise<string[]> {
    return this.command('SMEMBERS', key) as Promise<string[]>
  }

  exists(key: string): Promise<number> {
    return this.command('EXISTS', key) as Promise<number>
  }

  expire(key: string, seconds: number): Promise<number> {
    return this.command('EXPIRE', key, seconds) as Promise<number>
  }

  private command(...parts: Array<string | number>): Promise<unknown> {
    const run = this.pending.then(() => this.writeCommand(parts))
    this.pending = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private writeCommand(parts: Array<string | number>): Promise<unknown> {
    const payload = encodeRedisCommand(parts)
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      const onData = (chunk: Buffer) => {
        chunks.push(chunk)
        const parsed = parseRedisReply(Buffer.concat(chunks))
        if (!parsed.complete) return
        cleanup()
        if (parsed.error) {
          reject(new Error(parsed.error))
        } else {
          resolve(parsed.value)
        }
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const cleanup = () => {
        this.socket.off('data', onData)
        this.socket.off('error', onError)
      }
      this.socket.on('data', onData)
      this.socket.once('error', onError)
      this.socket.write(payload)
    })
  }
}

function encodeRedisCommand(parts: Array<string | number>): string {
  const encoded = parts.map((part) => String(part))
  return [
    `*${encoded.length}`,
    ...encoded.flatMap((part) => [`$${Buffer.byteLength(part)}`, part]),
    '',
  ].join('\r\n')
}

function parseRedisReply(buffer: Buffer): {
  complete: boolean
  value?: unknown
  error?: string
} {
  const parsed = parseRedisValue(buffer, 0)
  if (!parsed) return { complete: false }
  return { complete: true, value: parsed.value, error: parsed.error }
}

function parseRedisValue(
  buffer: Buffer,
  offset: number,
): { value: unknown; offset: number; error?: string } | undefined {
  const type = String.fromCharCode(buffer[offset])
  const lineEnd = buffer.indexOf('\r\n', offset)
  if (lineEnd === -1) return undefined
  const line = buffer.toString('utf8', offset + 1, lineEnd)
  const next = lineEnd + 2
  if (type === '+') return { value: line, offset: next }
  if (type === '-') return { value: undefined, error: line, offset: next }
  if (type === ':') return { value: Number(line), offset: next }
  if (type === '$') {
    const length = Number(line)
    if (length === -1) return { value: null, offset: next }
    const end = next + length
    if (buffer.length < end + 2) return undefined
    return { value: buffer.toString('utf8', next, end), offset: end + 2 }
  }
  if (type === '*') {
    const length = Number(line)
    if (length === -1) return { value: null, offset: next }
    const values: unknown[] = []
    let cursor = next
    for (let index = 0; index < length; index += 1) {
      const child = parseRedisValue(buffer, cursor)
      if (!child) return undefined
      values.push(child.value)
      cursor = child.offset
    }
    return { value: values, offset: cursor }
  }
  return { value: undefined, error: `Unsupported Redis reply type: ${type}`, offset: next }
}
