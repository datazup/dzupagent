/**
 * Tests that PipelineRuntime auto-wires the correct checkpoint store when
 * `checkpointStore` is not explicitly provided in config:
 *   - redisClient present → RedisPipelineCheckpointStore
 *   - pgClient present    → PostgresPipelineCheckpointStore
 *   - neither             → InMemoryPipelineCheckpointStore
 */

import { describe, it, expect, vi } from 'vitest'
import { PipelineRuntime } from '../pipeline/pipeline-runtime.js'
import { InMemoryPipelineCheckpointStore } from '../pipeline/in-memory-checkpoint-store.js'
import { PostgresPipelineCheckpointStore } from '../pipeline/postgres-checkpoint-store.js'
import { RedisPipelineCheckpointStore } from '../pipeline/redis-checkpoint-store.js'
import type { PipelineDefinition, PipelineNode, PipelineEdge } from '@dzupagent/core'
import type { NodeExecutor, NodeResult } from '../pipeline/pipeline-runtime-types.js'
import type { RedisClientLike } from '../pipeline/redis-checkpoint-store.js'
import type { PostgresClientLike } from '../pipeline/postgres-checkpoint-store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePipeline(id = 'pipe-1'): PipelineDefinition {
  const nodes: PipelineNode[] = [
    { id: 'A', type: 'agent', agentId: 'a1', timeoutMs: 5000 },
  ]
  const edges: PipelineEdge[] = []
  return {
    id,
    name: 'Test',
    version: '1.0.0',
    schemaVersion: '1.0.0',
    entryNodeId: 'A',
    nodes,
    edges,
  }
}

const okExecutor: NodeExecutor = async (nodeId): Promise<NodeResult> => ({
  nodeId,
  output: 'ok',
  durationMs: 1,
})

function makeRedisClient(): RedisClientLike {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(0),
    zadd: vi.fn().mockResolvedValue(0),
    zrange: vi.fn().mockResolvedValue([]),
    zrevrange: vi.fn().mockResolvedValue([]),
    zscore: vi.fn().mockResolvedValue(null),
    zrem: vi.fn().mockResolvedValue(0),
    sadd: vi.fn().mockResolvedValue(0),
    srem: vi.fn().mockResolvedValue(0),
    smembers: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(0),
    expire: vi.fn().mockResolvedValue(0),
  } as unknown as RedisClientLike
}

function makePgClient(): PostgresClientLike {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PipelineRuntime checkpoint store auto-wiring', () => {
  it('uses InMemoryPipelineCheckpointStore when no client is provided', async () => {
    const runtime = new PipelineRuntime({
      definition: makePipeline(),
      nodeExecutor: okExecutor,
    })

    // Run to completion and verify checkpointStore was wired (accessible via the
    // checkpoint event — if the store were missing, saveCheckpoint would be skipped).
    // We verify by checking the internal config via a known checkpoint event.
    const events: string[] = []
    const runtimeWithEvents = new PipelineRuntime({
      definition: { ...makePipeline(), checkpointStrategy: 'after_each_node' },
      nodeExecutor: okExecutor,
      onEvent: (e) => events.push(e.type),
    })

    const result = await runtimeWithEvents.execute()
    expect(result.state).toBe('completed')
    // checkpoint_saved should fire because InMemory store is auto-wired
    expect(events).toContain('pipeline:checkpoint_saved')

    void runtime
  })

  it('uses RedisPipelineCheckpointStore when redisClient is provided', () => {
    const redisClient = makeRedisClient()
    const runtime = new PipelineRuntime({
      definition: makePipeline(),
      nodeExecutor: okExecutor,
      redisClient,
    })

    // The store type is verified via instanceof — access via a snapshot of the
    // config. We reach it through the fact that save() is called on execute.
    // Indirect check: spy on the redisClient.set call triggered by checkpointing.
    expect(runtime).toBeDefined()

    // Build a second runtime that actually runs so we can observe the Redis calls.
    const runtimeRun = new PipelineRuntime({
      definition: { ...makePipeline('pipe-redis'), checkpointStrategy: 'after_each_node' },
      nodeExecutor: okExecutor,
      redisClient,
    })

    // Verify the internal config uses a RedisPipelineCheckpointStore.
    // Access via a type-check on the auto-wired store captured by the runtime.
    // Since checkpointStore is private, we validate indirectly via the class used
    // during construction by inspecting the mock calls after a run.
    return runtimeRun.execute().then((result) => {
      expect(result.state).toBe('completed')
      // Redis `set` is called by RedisPipelineCheckpointStore.save()
      expect(redisClient.set as ReturnType<typeof vi.fn>).toHaveBeenCalled()
    })
  })

  it('uses PostgresPipelineCheckpointStore when pgClient is provided (and no redisClient)', () => {
    const pgClient = makePgClient()
    const runtimeRun = new PipelineRuntime({
      definition: { ...makePipeline('pipe-pg'), checkpointStrategy: 'after_each_node' },
      nodeExecutor: okExecutor,
      pgClient,
    })

    return runtimeRun.execute().then((result) => {
      expect(result.state).toBe('completed')
      // Postgres `query` is called by PostgresPipelineCheckpointStore.save()
      expect(pgClient.query as ReturnType<typeof vi.fn>).toHaveBeenCalled()
    })
  })

  it('prefers redisClient over pgClient when both are provided', () => {
    const redisClient = makeRedisClient()
    const pgClient = makePgClient()

    const runtimeRun = new PipelineRuntime({
      definition: { ...makePipeline('pipe-both'), checkpointStrategy: 'after_each_node' },
      nodeExecutor: okExecutor,
      redisClient,
      pgClient,
    })

    return runtimeRun.execute().then((result) => {
      expect(result.state).toBe('completed')
      expect(redisClient.set as ReturnType<typeof vi.fn>).toHaveBeenCalled()
      // pg should NOT have been used for checkpointing
      expect(pgClient.query as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    })
  })

  it('explicit checkpointStore takes precedence over redisClient', () => {
    const redisClient = makeRedisClient()
    const explicitStore = new InMemoryPipelineCheckpointStore()
    const saveSpy = vi.spyOn(explicitStore, 'save')

    const runtimeRun = new PipelineRuntime({
      definition: { ...makePipeline('pipe-explicit'), checkpointStrategy: 'after_each_node' },
      nodeExecutor: okExecutor,
      checkpointStore: explicitStore,
      redisClient,
    })

    return runtimeRun.execute().then((result) => {
      expect(result.state).toBe('completed')
      expect(saveSpy).toHaveBeenCalled()
      // Redis was NOT used because explicit store takes priority
      expect(redisClient.set as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    })
  })

  it('exported store classes are constructable', () => {
    const pgClient = makePgClient()
    const redisClient = makeRedisClient()

    expect(() => new PostgresPipelineCheckpointStore({ client: pgClient })).not.toThrow()
    expect(() => new RedisPipelineCheckpointStore({ client: redisClient })).not.toThrow()
    expect(() => new InMemoryPipelineCheckpointStore()).not.toThrow()
  })
})
