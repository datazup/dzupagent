/**
 * G2a — serialized checkpoint commits for `for_each`.
 *
 * Precondition 2 of the `for_each` admission gate
 * (`shape-validate-rules/for-each-admission.ts`). E1 shipped the
 * compare-and-set seam (`saveIfVersion`) and the store suites prove the seam
 * itself; what was unproven — and in fact broken — is what the *runtime* does
 * when it loses that race.
 *
 * Before G2a, `writeCheckpoint` resynchronized its version counter and
 * returned `undefined` on a lost CAS. Every call site discarded that return,
 * and `undefined` was additionally indistinguishable from "no checkpoint store
 * configured". So a for_each loop that lost a commit at an item boundary
 * carried on: it advanced its in-memory ordered prefix and retired the
 * mid-item frames that prefix covered, while the store still held the rival's
 * older checkpoint. A resume from that record replays committed body work with
 * no frame to resume from — silent duplicate side effects.
 *
 * These tests pin the fail-closed behaviour instead: a lost item-boundary
 * commit surfaces as `PipelineCheckpointCommitConflictError`, and the durable
 * record is left exactly as the winning writer left it.
 */
import { describe, expect, it } from 'vitest'
import { PipelineRuntime } from '../pipeline/pipeline-runtime.js'
import { InMemoryPipelineCheckpointStore } from '../pipeline/in-memory-checkpoint-store.js'
import {
  isPipelineCheckpointCommitConflictError,
  PipelineCheckpointCommitConflictError,
} from '../pipeline/pipeline-shared/checkpoint-integrity-error.js'
import {
  writeCheckpoint,
  lastWriteLostCommit,
  lastWriteOutcome,
  clearWriteOutcome,
} from '../pipeline/executor-internals/checkpoint-writer.js'
import { restoreLoopStateAfterLostCommit } from '../pipeline/executor-internals/stage-dispatch.js'
import type {
  PipelineCheckpoint,
  PipelineCheckpointCommitReceipt,
} from '@dzupagent/core/pipeline'
import type { PipelineDefinition, PipelineNode } from '@dzupagent/core'
import type { NodeExecutor } from '../pipeline/pipeline-runtime-types.js'

/**
 * A store that commits normally until the caller arms it, then loses exactly
 * one compare-and-set race — simulating a rival writer that claimed the run's
 * next version in between this writer's read and write.
 *
 * The loss is produced by the real `saveIfVersion` contract (a receipt with
 * `committed: false`), not by throwing, because a throw would take the
 * pre-existing integrity-error path and prove nothing about G2a.
 */
class RaceLosingCheckpointStore extends InMemoryPipelineCheckpointStore {
  /** Lose the next `saveIfVersion` whose checkpoint carries this iteration. */
  loseAtIteration: number | undefined
  /** Version reported as the rival's, observed by the loser. */
  readonly rivalVersion = 99
  /** Every iteration value this store was asked to commit. */
  readonly attemptedIterations: (number | undefined)[] = []
  lostCommits = 0

  override async saveIfVersion(
    checkpoint: PipelineCheckpoint,
    expectedVersion: number,
  ): Promise<PipelineCheckpointCommitReceipt> {
    const iteration = checkpoint.loopState?.['loop-items']?.iteration
    this.attemptedIterations.push(iteration)
    if (
      this.loseAtIteration !== undefined &&
      iteration === this.loseAtIteration
    ) {
      // Fire once: a permanently-losing store would mask whether the runtime
      // stopped, since every subsequent write would fail too.
      this.loseAtIteration = undefined
      this.lostCommits++
      return { committed: false, observedVersion: this.rivalVersion }
    }
    return super.saveIfVersion(checkpoint, expectedVersion)
  }
}

/** A for_each loop over three items with a two-node body. */
function forEachPipeline(): PipelineDefinition {
  return {
    id: 'for-each-serialized-commits',
    name: 'ForEachSerializedCommits',
    version: '1.0.0',
    schemaVersion: '1.0.0',
    entryNodeId: 'loop-items',
    checkpointStrategy: 'after_each_node',
    nodes: [
      {
        id: 'loop-items',
        type: 'loop',
        bodyNodeIds: ['step-a', 'step-b'],
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
    ],
    edges: [],
  }
}

/** Records every `(item, bodyNode)` pair that actually executed. */
function tracingExecutor(runs: string[]): NodeExecutor {
  return async (nodeId: string, _node: PipelineNode, ctx) => {
    const item = ctx.state['item'] as { id: string }
    runs.push(`${item.id}:${nodeId}`)
    ctx.state['itemStatus'] = `${item.id}:done`
    return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 }
  }
}

const ITEMS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

describe('for_each serialized checkpoint commits (G2a)', () => {
  it('fails closed when an item-boundary commit loses a CAS race', async () => {
    const store = new RaceLosingCheckpointStore()
    // Lose the commit that would record "item a is done" (ordered prefix 1).
    store.loseAtIteration = 1
    const runs: string[] = []
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      checkpointStore: store,
    })

    const result = await runtime.execute({ items: ITEMS })

    // The store really did reject a commit — otherwise everything below would
    // pass for the wrong reason on a run that never raced at all.
    expect(store.lostCommits).toBe(1)

    // Fail closed. Before G2a this run reported `completed`: the loop advanced
    // its in-memory prefix over a commit that never landed.
    expect(result.state).toBe('failed')

    // And it stopped at the boundary rather than running the remaining items.
    // Item 'a' ran both body nodes; 'b' and 'c' must never have started.
    expect(runs).toEqual(['a:step-a', 'a:step-b'])
    expect(runs.some(entry => entry.startsWith('b:'))).toBe(false)
    expect(runs.some(entry => entry.startsWith('c:'))).toBe(false)
  })

  it('reports the conflict as a checkpoint commit conflict, not a node error', async () => {
    const store = new RaceLosingCheckpointStore()
    store.loseAtIteration = 1
    let captured: unknown
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor([]),
      checkpointStore: store,
      onEvent: event => {
        if (event.type === 'pipeline:failed') captured = event
      },
    })

    const result = await runtime.execute({ items: ITEMS })
    expect(store.lostCommits).toBe(1)
    expect(result.state).toBe('failed')

    // Assert the event actually arrived before asserting on its contents:
    // `JSON.stringify(undefined)` is `undefined`, which would make the
    // `toContain` checks below throw rather than meaningfully fail.
    expect(captured).toBeDefined()

    // The failure must name the durability conflict. A generic node failure
    // here would mean the conflict was routed through an authored error edge —
    // exactly the recovery path checkpoint-integrity failures must bypass.
    const message = JSON.stringify(captured)
    expect(message).toContain('checkpoint commit conflict')
    // It must name the store's actual version so an operator can reconcile.
    expect(message).toContain(String(store.rivalVersion))
  })

  it('leaves the durable record at the last winning commit', async () => {
    const store = new RaceLosingCheckpointStore()
    store.loseAtIteration = 1
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor([]),
      checkpointStore: store,
    })

    const result = await runtime.execute({ items: ITEMS })
    expect(store.lostCommits).toBe(1)
    expect(result.state).toBe('failed')

    const checkpoint = await store.load(result.runId)
    const loopState = checkpoint?.loopState?.['loop-items']
    // The lost commit is the one that would have advanced the prefix to 1.
    // The durable record must therefore NOT claim item 'a' is retired.
    expect(loopState?.iteration ?? 0).toBe(0)
  })

  it('does not fail a run whose commits all win', async () => {
    // The negative control. Without it, a mutant that fails every for_each run
    // would pass all three tests above.
    const store = new RaceLosingCheckpointStore()
    store.loseAtIteration = undefined
    const runs: string[] = []
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      checkpointStore: store,
    })

    const result = await runtime.execute({ items: ITEMS })

    expect(store.lostCommits).toBe(0)
    expect(result.state).toBe('completed')
    // All three items ran to completion, in input order.
    expect(runs).toEqual([
      'a:step-a',
      'a:step-b',
      'b:step-a',
      'b:step-b',
      'c:step-a',
      'c:step-b',
    ])
    // The store was genuinely exercised through the CAS path, so the negative
    // control proves commits *won*, not that CAS was bypassed entirely.
    expect(store.attemptedIterations.length).toBeGreaterThan(0)
  })
})

describe('checkpoint write outcome (G2a)', () => {
  const CONFIG_BASE = {
    definition: forEachPipeline(),
    nodeExecutor: tracingExecutor([]),
  }

  function writeInput(
    store: InMemoryPipelineCheckpointStore | undefined,
    versionTracker: { version: number },
  ) {
    return {
      config: {
        ...CONFIG_BASE,
        ...(store === undefined ? {} : { checkpointStore: store }),
      } as never,
      runId: 'run-1',
      runState: {},
      nodeResults: new Map(),
      completedNodeIds: [],
      nodeIdempotencyKeys: {},
      loopState: {},
      forkState: {},
      eventLog: [],
      versionTracker,
      recoveryAttemptsUsed: 0,
      budgetTracker: { cumulativeCostCents: 0 } as never,
      emit: () => {},
    }
  }

  it('distinguishes a lost commit from an unconfigured store', async () => {
    // Both produce `undefined`; only one is a durability loss. Conflating them
    // is what let the loop treat a lost commit as "nothing to persist".
    const noStoreTracker = { version: 0 }
    const noStore = await writeCheckpoint(writeInput(undefined, noStoreTracker))
    expect(noStore).toBeUndefined()
    expect(lastWriteOutcome(noStoreTracker)).toEqual({ kind: 'no_store' })
    expect(lastWriteLostCommit(noStoreTracker)).toBe(false)

    const store = new InMemoryPipelineCheckpointStore()
    // A rival writer owns this run: the store already holds a real version,
    // and this writer expects a different one. Seeded through a winning write
    // so the version present is one the store genuinely produced.
    const rival = { version: 0 }
    await writeCheckpoint(writeInput(store, rival))
    expect(lastWriteOutcome(rival)?.kind).toBe('committed')

    const conflictTracker = { version: 41 }
    const lost = await writeCheckpoint(writeInput(store, conflictTracker))
    expect(lost).toBeUndefined()
    expect(lastWriteLostCommit(conflictTracker)).toBe(true)
    expect(lastWriteOutcome(conflictTracker)).toMatchObject({
      kind: 'conflict',
    })
  })

  it('does not treat a never-persisted run as a lost race', async () => {
    // `PipelineRuntime.resume` accepts a checkpoint OBJECT and does not require
    // the store to hold it. Such a write cannot match any stored version, but
    // no rival owns the run — failing it closed would break every resume from
    // an unpersisted checkpoint.
    const store = new InMemoryPipelineCheckpointStore()
    const tracker = { version: 7 }
    const written = await writeCheckpoint(writeInput(store, tracker))
    expect(written).toBeUndefined()
    expect(lastWriteOutcome(tracker)?.kind).toBe('unpersisted_run')
    expect(lastWriteLostCommit(tracker)).toBe(false)
  })

  it('does not let a conflict latch go stale', async () => {
    // The latch is read *after* a write, so a stale `conflict` would fail a
    // boundary whose own commit never lost. Every real write path overwrites
    // the entry; this pins that, and `clearWriteOutcome` covers the paths
    // where a write is skipped entirely.
    const store = new InMemoryPipelineCheckpointStore()
    const seed = { version: 0 }
    await writeCheckpoint(writeInput(store, seed))

    const tracker = { version: 41 }
    await writeCheckpoint(writeInput(store, tracker))
    expect(lastWriteLostCommit(tracker)).toBe(true)

    // The conflict resynchronized the tracker, so this write wins — and the
    // latch must follow it rather than persisting the earlier loss.
    await writeCheckpoint(writeInput(store, tracker))
    expect(lastWriteLostCommit(tracker)).toBe(false)
    expect(lastWriteOutcome(tracker)?.kind).toBe('committed')
  })

  it('clearWriteOutcome forgets a recorded outcome', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const tracker = { version: 0 }
    await writeCheckpoint(writeInput(store, tracker))
    expect(lastWriteOutcome(tracker)?.kind).toBe('committed')

    clearWriteOutcome(tracker)
    expect(lastWriteOutcome(tracker)).toBeUndefined()
    expect(lastWriteLostCommit(tracker)).toBe(false)
  })

  it('records a winning write as committed', async () => {
    const store = new InMemoryPipelineCheckpointStore()
    const tracker = { version: 0 }
    const checkpoint = await writeCheckpoint(writeInput(store, tracker))
    expect(checkpoint).toBeDefined()
    expect(lastWriteLostCommit(tracker)).toBe(false)
    expect(lastWriteOutcome(tracker)?.kind).toBe('committed')
  })

  it('keeps outcomes separate per run', async () => {
    // Two concurrent runs must not observe each other's conflict — the whole
    // point of keying on the frame's own version tracker.
    const store = new InMemoryPipelineCheckpointStore()
    const winner = { version: 0 }
    await writeCheckpoint(writeInput(store, winner))
    // The store now holds a real version, so this second tracker meets a
    // genuine rival rather than an empty run.
    const loser = { version: 41 }
    await writeCheckpoint(writeInput(store, loser))
    expect(lastWriteLostCommit(winner)).toBe(false)
    expect(lastWriteLostCommit(loser)).toBe(true)
  })
})

describe('restoreLoopStateAfterLostCommit (G2a)', () => {
  /**
   * Unit-tested rather than end-to-end, deliberately. A lost item-boundary
   * commit aborts the run before any further checkpoint is written (verified:
   * the conflicting CAS is the last write the store receives), so the restored
   * in-memory entry is never re-read within that run and a mutant deleting the
   * rollback survives the suite above. The same construction as the G1
   * mid-item merge; both owe an end-to-end test to the N>1 slice.
   */
  it('restores the prior entry so memory matches the durable record', () => {
    const previous = { iteration: 0, itemFrames: { '0': { itemIndex: 0 } } }
    const loopState = {
      // What the retirement wrote before the commit was lost: prefix advanced
      // to 1 and item 0's frame retired.
      'loop-items': { iteration: 1 },
    } as never as Parameters<typeof restoreLoopStateAfterLostCommit>[0]

    restoreLoopStateAfterLostCommit(
      loopState,
      'loop-items',
      previous as never,
    )

    // The advanced cursor must be gone, not merely supplemented.
    expect(loopState['loop-items']).toEqual(previous)
    expect(loopState['loop-items']?.iteration).toBe(0)
  })

  it('removes the entry when the loop had no prior state', () => {
    const loopState = {
      'loop-items': { iteration: 1 },
    } as never as Parameters<typeof restoreLoopStateAfterLostCommit>[0]

    restoreLoopStateAfterLostCommit(loopState, 'loop-items', undefined)

    // Assigning `undefined` would leave an own key holding undefined, which
    // `LoopState` does not permit and which serializes into the checkpoint.
    expect('loop-items' in loopState).toBe(false)
  })

  it('leaves other loops untouched', () => {
    const loopState = {
      'loop-items': { iteration: 1 },
      'other-loop': { iteration: 5 },
    } as never as Parameters<typeof restoreLoopStateAfterLostCommit>[0]

    restoreLoopStateAfterLostCommit(loopState, 'loop-items', undefined)

    expect(loopState['other-loop']?.iteration).toBe(5)
  })
})

describe('PipelineCheckpointCommitConflictError', () => {
  it('names the node, the lost prefix, and the observed version', () => {
    const error = new PipelineCheckpointCommitConflictError('loop-items', {
      completedIterations: 3,
      observedVersion: 7,
    })
    expect(isPipelineCheckpointCommitConflictError(error)).toBe(true)
    expect(error.message).toContain('loop-items')
    expect(error.message).toContain('3')
    expect(error.message).toContain('7')
  })

  it('does not classify an unrelated error as a commit conflict', () => {
    expect(isPipelineCheckpointCommitConflictError(new Error('nope'))).toBe(
      false,
    )
  })
})
