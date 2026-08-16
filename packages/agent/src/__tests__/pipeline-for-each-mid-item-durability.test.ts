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
import type { PipelineCheckpoint, PipelineDefinition, PipelineNode } from '@dzupagent/core'
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
  it('persists an item frame when a crash lands inside an item', async () => {
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
    // G1: frames are keyed by item index. Item 'b' is the only one in flight.
    expect(Object.keys(loopState?.itemFrames ?? {})).toEqual(['1'])
    expect(loopState?.itemFrames?.['1']).toMatchObject({
      itemIndex: 1,
      nextBodyNodeIndex: 2,
    })
    expect(
      Object.keys(loopState?.itemFrames?.['1']?.bodyResults ?? {}).sort()
    ).toEqual(['step-a', 'step-b'])
    // The superseded singular spelling must not be written alongside it.
    expect(loopState?.itemFrame).toBeUndefined()
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

  it('clears the item frames once the item completes', async () => {
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
    expect(checkpoint?.loopState?.['loop-items']?.itemFrames).toBeUndefined()
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

  it('keys duplicate-valued items by index, not by item value', async () => {
    // doc 27 §8 minimum proof 1 — duplicate-value index identity.
    //
    // The test above uses distinct items (`{id:'a'}`, `{id:'b'}`), so it cannot
    // separate "keyed by index" from "keyed by index *and* value": both give two
    // distinct keys. Deep-equal items make index the ONLY distinguishing input,
    // so a key that folds in the item value collapses these two onto one key and
    // a per-item ledger dedupes item 1 against item 0 — a 2-invoice loop charges
    // one invoice. Duplicate values are the realistic case, not a corner case.
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
    // Deep-equal, distinct object identities: neither value nor reference
    // identity can separate them, so only `itemIndex` can.
    await runtime.execute({ items: [{ id: 'dup' }, { id: 'dup' }] })

    expect(keys).toHaveLength(2)
    expect(keys[0]).toBeDefined()
    expect(keys[0]).not.toEqual(keys[1])
    expect(keys[0]).toContain('item:loop-items:0')
    expect(keys[1]).toContain('item:loop-items:1')
  })

  it.each(['before-save', 'save-then-throw'] as const)(
    'fails closed when the mid-item frame write fails (%s)',
    async (failureMode) => {
      // doc 27 §8 minimum proof 7 — before-save / save-then-throw fault
      // injection. The idiom is used for predicate and graph loops, but no
      // for_each test injected a checkpoint fault, so the item-frame write had
      // no proof it fails closed.
      //
      // The two modes differ in what the STORE ends up holding, which is the
      // whole point: `before-save` loses the write entirely, `save-then-throw`
      // persists it and only then reports failure — the ambiguous-outcome case
      // where the run must not assume its write was lost.
      class ItemFrameFailureStore extends InMemoryPipelineCheckpointStore {
        private failed = false

        override async save(checkpoint: PipelineCheckpoint): Promise<void> {
          const frames = checkpoint.loopState?.['loop-items']?.itemFrames
          // Target the first write that carries a mid-item frame, so the fault
          // lands strictly inside an item rather than on an item boundary.
          if (!this.failed && frames !== undefined && Object.keys(frames).length > 0) {
            this.failed = true
            if (failureMode === 'save-then-throw') {
              await super.save(checkpoint)
            }
            throw new Error(`simulated item-frame ${failureMode}`)
          }
          await super.save(checkpoint)
        }
      }

      const store = new ItemFrameFailureStore()
      const runs: string[] = []
      const result = await new PipelineRuntime({
        definition: threeBodyForEachPipeline(),
        nodeExecutor: tracingExecutor(runs),
        checkpointStore: store,
      }).execute({ items: ITEMS })

      // Fail closed: a lost or ambiguous item-frame write must not be reported
      // as a completed run.
      expect(result.state).toBe('failed')

      const checkpoint = await store.load(result.runId)
      if (failureMode === 'before-save') {
        // The write never landed, so no frame for the in-flight item exists.
        expect(
          Object.keys(checkpoint?.loopState?.['loop-items']?.itemFrames ?? {})
        ).toEqual([])
        return
      }

      // save-then-throw: the frame IS durable despite the reported failure, so
      // a resume can pick the item up mid-body instead of re-running it.
      expect(
        Object.keys(checkpoint?.loopState?.['loop-items']?.itemFrames ?? {})
      ).not.toEqual([])
    }
  )
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

  it('binds the forEach contract itself, not merely the nodes around it', async () => {
    // The sibling digest tests mutate a plain agent node, which would still be
    // caught if `forEach` were dropped from the canonical digest input. This
    // one mutates ONLY the forEach block, so it goes red if a canonicalization
    // change ever stops covering the loop contract. Sub-part (c) of doc 27 §8
    // proof 5 is covered by construction; this is the evidence for it.
    const store = new InMemoryPipelineCheckpointStore()
    const first = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor([], { item: 'b', nodeId: 'step-c' }),
      checkpointStore: store,
    })
    const firstResult = await first.execute({ items: ITEMS })
    const checkpoint = await store.load(firstResult.runId)

    const mutated = threeBodyForEachPipeline()
    const loop = mutated.nodes[0] as { forEach: { as: string } }
    // Rebinding the item variable changes what every body node reads as
    // `item` — the retained prefix was computed under the old binding.
    loop.forEach.as = 'element'

    const second = new PipelineRuntime({
      definition: mutated,
      nodeExecutor: tracingExecutor([]),
      checkpointStore: store,
    })

    await expect(second.resume(checkpoint!)).rejects.toThrow(
      PipelineSourceBindingMismatchError,
    )
  })
})

describe('for_each cursor integrity (E3 defect 2)', () => {
  /** Run to a mid-item crash and hand back the checkpoint it left behind. */
  async function crashedCheckpoint(
    store: InMemoryPipelineCheckpointStore,
  ): Promise<PipelineCheckpoint> {
    const first = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor([], { item: 'b', nodeId: 'step-c' }),
      checkpointStore: store,
    })
    const firstResult = await first.execute({ items: ITEMS })
    return (await store.load(firstResult.runId))!
  }

  it('refuses a completed prefix longer than the source, instead of clamping it', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const checkpoint = await crashedCheckpoint(store)
    // Corrupt the durable cursor: claim 99 of 2 items finished. Clamping this
    // to 2 would report a successful run that dispatched nothing.
    const corrupt = structuredClone(checkpoint)
    corrupt.loopState!['loop-items']!.iteration = 99
    delete corrupt.loopState!['loop-items']!.itemFrames

    const resumeRuns: string[] = []
    const second = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor(resumeRuns),
      checkpointStore: store,
    })

    const resumed = await second.resume(corrupt)
    expect(resumed.state).toBe('failed')
    // The load-bearing half: rejected before any item body was dispatched.
    expect(resumeRuns).toEqual([])
    // ...and it failed for THIS reason, not incidentally.
    expect(resumed.error).toMatch(/completed prefix of 99 item\(s\)/)
  })

  it('refuses an in-flight frame whose itemIndex disagrees with its key', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const checkpoint = await crashedCheckpoint(store)
    // `readItemFrames` keys a pre-G1 singular frame by its own `itemIndex`, so
    // downstream code assumes the two agree. A frame filed at '1' that reports
    // index 0 would restore item 'b' body results onto item 'a'.
    //
    // Caught by `PipelineCheckpointSchema` on the way in, EARLIER than the
    // cursor guard, so the run never starts and there is no run result to
    // inspect. Pinned at the boundary that actually rejects it.
    const corrupt = structuredClone(checkpoint)
    corrupt.loopState!['loop-items']!.itemFrames!['1']!.itemIndex = 0

    const resumeRuns: string[] = []
    const second = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor(resumeRuns),
      checkpointStore: store,
    })

    await expect(second.resume(corrupt)).rejects.toThrow(
      /does not match its frame's itemIndex/,
    )
    expect(resumeRuns).toEqual([])
  })

  it('refuses an in-flight frame indexed outside the source', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const checkpoint = await crashedCheckpoint(store)
    const corrupt = structuredClone(checkpoint)
    const frames = corrupt.loopState!['loop-items']!.itemFrames!
    delete frames['1']
    frames['7'] = { itemIndex: 7, nextBodyNodeIndex: 1, bodyResults: {} }

    const resumeRuns: string[] = []
    const second = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor(resumeRuns),
      checkpointStore: store,
    })

    const resumed = await second.resume(corrupt)
    expect(resumed.state).toBe('failed')
    expect(resumeRuns).toEqual([])
    expect(resumed.error).toMatch(/names index 7, which is outside the 2 item/)
  })

  it('admits an intact cursor, including a prefix that exactly equals the source', async () => {
    // The control. The guard rejects only genuine corruption — an untouched
    // checkpoint still resumes, and `iteration === itemCount` (every item done)
    // is a legal boundary, not an overrun. Without this, a guard that rejected
    // everything would pass the three tests above.
    const store = new InMemoryPipelineCheckpointStore()
    const checkpoint = await crashedCheckpoint(store)

    const resumeRuns: string[] = []
    const second = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor(resumeRuns),
      checkpointStore: store,
    })
    const resumed = await second.resume(structuredClone(checkpoint))
    expect(resumed.state).toBe('completed')
    // Item 'b' resumed at its last body node; item 'a' was not re-run.
    expect(resumeRuns).toEqual(['b:step-c'])

    const boundary = structuredClone(checkpoint)
    boundary.loopState!['loop-items']!.iteration = 2
    delete boundary.loopState!['loop-items']!.itemFrames
    const third = new PipelineRuntime({
      definition: threeBodyForEachPipeline(),
      nodeExecutor: tracingExecutor([]),
      checkpointStore: store,
    })
    expect((await third.resume(boundary)).state).toBe('completed')
  })
})
