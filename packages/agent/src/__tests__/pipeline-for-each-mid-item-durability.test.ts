/**
 * E3 — `for_each` mid-item durability and bound resume.
 *
 * The existing for-each runtime suite exercises resume at *item* boundaries
 * with a single-body-node loop, which cannot express "item 2 got through two
 * of its three body nodes". These tests use a three-body-node loop so a crash
 * lands strictly inside an item.
 */
import { describe, expect, it } from 'vitest'
import { PipelineRuntime } from '../pipeline/pipeline-runtime.js'
import { InMemoryPipelineCheckpointStore } from '../pipeline/in-memory-checkpoint-store.js'
import { PipelineSourceBindingMismatchError } from '../pipeline/pipeline-runtime-lifecycle/resume-context.js'
import type { PipelineDefinition, PipelineNode } from '@dzupagent/core'
import type { NodeExecutor } from '../pipeline/pipeline-runtime-types.js'

/** A for_each loop whose body is three sequential nodes. */
function threeBodyForEachPipeline(): PipelineDefinition {
  return {
    id: 'for-each-mid-item',
    name: 'ForEachMidItem',
    version: '1.0.0',
    schemaVersion: '1.0.0',
    entryNodeId: 'loop-items',
    checkpointStrategy: 'after_each_node',
    nodes: [
      {
        id: 'loop-items',
        type: 'loop',
        bodyNodeIds: ['step-a', 'step-b', 'step-c'],
        maxIterations: 1000,
        continuePredicateName: 'forEach__item__predicate',
        forEach: {
          source: '$.items',
          as: 'item',
          order: 'input',
          collect: { from: 'itemStatus', into: 'itemStatuses', order: 'input' },
          concurrency: 1,
          empty: { body: 'skip', aggregate: 'empty-array' },
        },
      },
      { id: 'step-a', type: 'agent', agentId: 'a', timeoutMs: 5000 },
      { id: 'step-b', type: 'agent', agentId: 'b', timeoutMs: 5000 },
      { id: 'step-c', type: 'agent', agentId: 'c', timeoutMs: 5000 },
    ],
    edges: [],
  }
}

/** Records every `(item, bodyNode)` pair that actually executed. */
function tracingExecutor(
  runs: string[],
  crashOn?: { item: string; nodeId: string },
): NodeExecutor {
  return async (nodeId: string, _node: PipelineNode, ctx) => {
    const item = ctx.state['item'] as { id: string }
    runs.push(`${item.id}:${nodeId}`)
    if (crashOn && item.id === crashOn.item && nodeId === crashOn.nodeId) {
      throw new Error(`simulated crash at ${item.id}/${nodeId}`)
    }
    ctx.state['itemStatus'] = `${item.id}:done`
    return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 }
  }
}

const ITEMS = [{ id: 'a' }, { id: 'b' }]

describe('for_each mid-item durability (E3)', () => {
  it('persists an itemFrame when a crash lands inside an item', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const runs: string[] = []
    const runtime = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor(runs, { item: 'b', nodeId: 'step-c' }),
      checkpointStore: store,
    })

    const result = await runtime.execute({ items: ITEMS })
    expect(result.state).toBe('failed')

    const checkpoint = await store.load(result.runId)
    const loopState = checkpoint?.loopState?.['loop-items']
    // Item 'a' completed, so the ordered prefix is 1. Item 'b' (index 1) got
    // through step-a and step-b, so the frame points at step-c.
    expect(loopState?.iteration).toBe(1)
    expect(loopState?.itemFrame).toMatchObject({
      itemIndex: 1,
      nextBodyNodeIndex: 2,
    })
    expect(Object.keys(loopState?.itemFrame?.bodyResults ?? {}).sort()).toEqual([
      'step-a',
      'step-b',
    ])
  })

  it('resumes at the next body node instead of re-running the whole item', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const firstRuns: string[] = []
    const first = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor(firstRuns, { item: 'b', nodeId: 'step-c' }),
      checkpointStore: store,
    })
    const firstResult = await first.execute({ items: ITEMS })
    expect(firstResult.state).toBe('failed')
    expect(firstRuns).toEqual([
      'a:step-a',
      'a:step-b',
      'a:step-c',
      'b:step-a',
      'b:step-b',
      'b:step-c',
    ])

    const resumeRuns: string[] = []
    const second = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor(resumeRuns),
      checkpointStore: store,
    })
    const checkpoint = await store.load(firstResult.runId)
    const resumed = await second.resume(checkpoint!)

    expect(resumed.state).toBe('completed')
    // THE POINT OF E3: item 'a' is not re-run (ordered prefix), and item 'b'
    // resumes at step-c rather than repeating step-a and step-b, whose side
    // effects already committed.
    expect(resumeRuns).toEqual(['b:step-c'])
  })

  it('clears the itemFrame once the item completes', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const runtime = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor([]),
      checkpointStore: store,
    })
    const result = await runtime.execute({ items: ITEMS })
    expect(result.state).toBe('completed')

    const checkpoint = await store.load(result.runId)
    // A retained frame after the loop finished would resume into a completed
    // item on the next restore.
    expect(checkpoint?.loopState?.['loop-items']?.itemFrame).toBeUndefined()
  })

  it('gives each item a distinct idempotency key for the same body node', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const keys: Array<string | undefined> = []
    const runtime = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: async (nodeId: string, _node: PipelineNode, ctx) => {
        if (nodeId === 'step-a') keys.push(ctx.idempotencyKey)
        ctx.state['itemStatus'] = 'ok'
        return { nodeId, output: 'ok', durationMs: 1 }
      },
      checkpointStore: store,
    })
    await runtime.execute({ items: ITEMS })

    expect(keys).toHaveLength(2)
    expect(keys[0]).toBeDefined()
    // Pre-E3 both items shared one key for `step-a`, so a per-item ledger
    // deduped item 2 against item 1's entry.
    expect(keys[0]).not.toEqual(keys[1])
    expect(keys[0]).toContain('item:loop-items:0')
    expect(keys[1]).toContain('item:loop-items:1')
  })
})

describe('checkpoint source binding (E3 defect 1)', () => {
  it('records the definition digest and per-loop item-source digest', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const runtime = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor([]),
      checkpointStore: store,
    })
    const result = await runtime.execute({ items: ITEMS })
    const checkpoint = await store.load(result.runId)

    expect(checkpoint?.sourceBinding?.definitionDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(
      checkpoint?.sourceBinding?.loopSourceDigests?.['loop-items'],
    ).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('rejects a resume whose definition digest disagrees', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const first = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor([], { item: 'b', nodeId: 'step-c' }),
      checkpointStore: store,
    })
    const firstResult = await first.execute({ items: ITEMS })
    const checkpoint = await store.load(firstResult.runId)

    // Same pipeline id, different compiled content — exactly the case
    // `pipelineId` alone cannot detect.
    const mutated = threeBodyForEachPipeline()
    ;(mutated.nodes[1] as { agentId: string }).agentId = 'replaced-agent'
    const second = new PipelineRuntime({
      definition: mutated,
      nodeExecutor: tracingExecutor([]),
      checkpointStore: store,
    })

    await expect(second.resume(checkpoint!)).rejects.toThrow(
      PipelineSourceBindingMismatchError,
    )
  })

  it('fails closed on a resume whose for_each item source was reordered', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const first = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor([], { item: 'b', nodeId: 'step-c' }),
      checkpointStore: store,
    })
    const firstResult = await first.execute({ items: ITEMS })
    const checkpoint = await store.load(firstResult.runId)

    const resumeRuns: string[] = []
    const second = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor(resumeRuns),
      checkpointStore: store,
    })
    // Reordering makes the retained ordered prefix name a different item:
    // an admitted resume would skip 'b' as "already done" and re-run 'a'.
    // The loop-stage guard throws; the runtime's uniform graph-walk contract
    // turns any throw into a failed run, so fail-closed surfaces as `failed`
    // rather than a rejection.
    const resumed = await second.resume(checkpoint!, {
      items: [{ id: 'b' }, { id: 'a' }],
    })
    expect(resumed.state).toBe('failed')
    // The load-bearing half: nothing re-executed against the changed source.
    expect(resumeRuns).toEqual([])
  })

  it('still resumes a pre-E3 checkpoint that carries no binding', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const first = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor([], { item: 'b', nodeId: 'step-c' }),
      checkpointStore: store,
    })
    const firstResult = await first.execute({ items: ITEMS })
    const checkpoint = await store.load(firstResult.runId)

    // Absence must be "unprovable", not a hard failure — otherwise every
    // in-flight run written before E3 starts rejecting on restart.
    const legacy = { ...checkpoint! }
    delete (legacy as { sourceBinding?: unknown }).sourceBinding

    const second = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor([]),
      checkpointStore: store,
    })
    const resumed = await second.resume(legacy)
    expect(resumed.state).toBe('completed')
  })
})
