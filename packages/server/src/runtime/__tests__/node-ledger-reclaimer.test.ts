/**
 * Tests for {@link NodeLedgerReclaimer}.
 *
 * The reclaimer detects stale (lease-expired) durable nodes via
 * `ledger.findStale`, re-enqueues each owning run AT MOST ONCE per tick, and
 * emits a `node:reclaimed` event per stale node. It mirrors the lifecycle
 * conventions of {@link MailDlqWorker}: injected narrow dependencies, an
 * injected clock, `start()`/`stop()`/`tick()`, a re-entrancy guard, and
 * constructor validation.
 *
 * Where practical we seed the real {@link InMemoryDurableNodeLedger} with
 * expired leases (acquire with a short ttl, then advance `now`) rather than
 * mocking `findStale`. A hand-rolled stub is used only where the test needs to
 * control timing precisely (re-entrancy) or assert the exact `limit` argument.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  InMemoryDurableNodeLedger,
  type DurableNodeLease,
} from '@dzupagent/core/persistence'
import type { DzupEvent } from '@dzupagent/core/events'
import { NodeLedgerReclaimer } from '../node-ledger-reclaimer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed a real in-memory ledger with `count` leased nodes for a run, all sharing
 * the same owner and a `ttlMs` lease acquired at `acquiredAt`. The caller then
 * advances `now` past `acquiredAt + ttlMs` to make them stale.
 */
async function seedLeases(
  ledger: InMemoryDurableNodeLedger,
  runId: string,
  nodeIds: string[],
  owner: string,
  ttlMs: number,
  acquiredAt: number
): Promise<void> {
  for (const nodeId of nodeIds) {
    await ledger.acquire(
      runId,
      nodeId,
      `${runId}:${nodeId}`,
      owner,
      ttlMs,
      acquiredAt
    )
  }
}

function collectReclaimed(events: DzupEvent[]): Array<{
  runId: string
  nodeId: string
  previousOwner: string
}> {
  const out: Array<{ runId: string; nodeId: string; previousOwner: string }> =
    []
  for (const e of events) {
    if (e.type === 'node:reclaimed') {
      out.push({
        runId: e.runId,
        nodeId: e.nodeId,
        previousOwner: e.previousOwner,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NodeLedgerReclaimer', () => {
  // 1. No stale nodes → reEnqueueRun never called, reclaimed: 0.
  it('does nothing when there are no stale nodes', async () => {
    const ledger = new InMemoryDurableNodeLedger()
    // Acquire a fresh lease that is NOT yet expired at tick time.
    await seedLeases(ledger, 'run-A', ['n1'], 'worker-1', 60_000, 1_000)

    const enqueued: string[] = []
    const events: DzupEvent[] = []
    const reclaimer = new NodeLedgerReclaimer({
      ledger,
      reEnqueueRun: (runId) => {
        enqueued.push(runId)
      },
      eventBus: { emit: (e) => events.push(e) },
      now: () => 5_000, // lease expires at 61_000 → not stale
    })

    const result = await reclaimer.tick()
    expect(result).toEqual({ reclaimed: 0 })
    expect(enqueued).toEqual([])
    expect(events).toHaveLength(0)
  })

  // 2. Stale nodes across 2 runs (run-A: 2 nodes, run-B: 1 node) →
  //    reEnqueueRun deduped per runId (2 calls), node:reclaimed per node (3),
  //    onReclaimed called 3×, previousOwner correct.
  it('re-enqueues each run once but emits node:reclaimed per stale node', async () => {
    const ledger = new InMemoryDurableNodeLedger()
    await seedLeases(ledger, 'run-A', ['n1', 'n2'], 'worker-A', 1_000, 0)
    await seedLeases(ledger, 'run-B', ['n3'], 'worker-B', 1_000, 0)

    const enqueued: string[] = []
    const events: DzupEvent[] = []
    const reclaimedLeases: DurableNodeLease[] = []
    const reclaimer = new NodeLedgerReclaimer({
      ledger,
      reEnqueueRun: (runId) => {
        enqueued.push(runId)
      },
      eventBus: { emit: (e) => events.push(e) },
      onReclaimed: (lease) => reclaimedLeases.push(lease),
      now: () => 10_000, // all leases (expire at 1_000) are stale
    })

    const result = await reclaimer.tick()
    expect(result).toEqual({ reclaimed: 3 })

    // reEnqueueRun deduped: exactly one call per unique runId.
    expect(enqueued.sort()).toEqual(['run-A', 'run-B'])

    // node:reclaimed emitted once per stale node (3 events).
    const reclaimedEvents = collectReclaimed(events)
    expect(reclaimedEvents).toHaveLength(3)
    expect(reclaimedEvents).toContainEqual({
      runId: 'run-A',
      nodeId: 'n1',
      previousOwner: 'worker-A',
    })
    expect(reclaimedEvents).toContainEqual({
      runId: 'run-A',
      nodeId: 'n2',
      previousOwner: 'worker-A',
    })
    expect(reclaimedEvents).toContainEqual({
      runId: 'run-B',
      nodeId: 'n3',
      previousOwner: 'worker-B',
    })

    // onReclaimed invoked per node.
    expect(reclaimedLeases).toHaveLength(3)
  })

  // 3. reEnqueueRun throws for one run → other runs still re-enqueued, onError
  //    called, no exception escapes tick.
  it('continues re-enqueuing other runs when one run throws', async () => {
    const ledger = new InMemoryDurableNodeLedger()
    await seedLeases(ledger, 'run-bad', ['n1'], 'worker-X', 1_000, 0)
    await seedLeases(ledger, 'run-good', ['n2'], 'worker-Y', 1_000, 0)

    const enqueued: string[] = []
    const errors: unknown[] = []
    const events: DzupEvent[] = []
    const reclaimer = new NodeLedgerReclaimer({
      ledger,
      reEnqueueRun: (runId) => {
        if (runId === 'run-bad') {
          throw new Error('queue is down')
        }
        enqueued.push(runId)
      },
      eventBus: { emit: (e) => events.push(e) },
      onError: (err) => errors.push(err),
      now: () => 10_000,
    })

    // Must not throw.
    const result = await reclaimer.tick()

    // The good run was still re-enqueued.
    expect(enqueued).toEqual(['run-good'])
    // The bad run surfaced via onError.
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('queue is down')
    // Both nodes were still observed/emitted regardless of enqueue outcome.
    expect(collectReclaimed(events)).toHaveLength(2)
    // reclaimed counts only the successfully re-enqueued run's node.
    expect(result).toEqual({ reclaimed: 1 })
  })

  // 4. Re-entrancy: a second tick while the first is in-flight is a no-op.
  it('is re-entrant safe: overlapping tick returns reclaimed: 0', async () => {
    const ledger = new InMemoryDurableNodeLedger()
    await seedLeases(ledger, 'run-A', ['n1'], 'worker-A', 1_000, 0)

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    let enqueueCalls = 0
    const reclaimer = new NodeLedgerReclaimer({
      ledger,
      reEnqueueRun: async () => {
        enqueueCalls += 1
        await gate // hold the first tick open
      },
      eventBus: { emit: () => {} },
      now: () => 10_000,
    })

    const first = reclaimer.tick()
    // Second tick fires while the first is still awaiting the gate.
    const second = await reclaimer.tick()
    expect(second).toEqual({ reclaimed: 0 })
    expect(enqueueCalls).toBe(1)

    release()
    const firstResult = await first
    expect(firstResult).toEqual({ reclaimed: 1 })
  })

  // 5. batchSize is passed through to findStale as the limit.
  it('passes batchSize through to findStale as the limit', async () => {
    const findStale = vi.fn(
      async (_now: number, _limit: number): Promise<DurableNodeLease[]> => []
    )
    const reclaimer = new NodeLedgerReclaimer({
      ledger: { findStale },
      reEnqueueRun: () => {},
      eventBus: { emit: () => {} },
      batchSize: 7,
      now: () => 42,
    })

    await reclaimer.tick()
    expect(findStale).toHaveBeenCalledTimes(1)
    expect(findStale).toHaveBeenCalledWith(42, 7)
  })

  // 6. Constructor validation.
  it('rejects intervalMs <= 0', () => {
    expect(
      () =>
        new NodeLedgerReclaimer({
          ledger: { findStale: async () => [] },
          reEnqueueRun: () => {},
          eventBus: { emit: () => {} },
          intervalMs: 0,
        })
    ).toThrow(/intervalMs/)
  })

  it('rejects batchSize <= 0', () => {
    expect(
      () =>
        new NodeLedgerReclaimer({
          ledger: { findStale: async () => [] },
          reEnqueueRun: () => {},
          eventBus: { emit: () => {} },
          batchSize: 0,
        })
    ).toThrow(/batchSize/)
  })

  // 7. Lifecycle idempotency.
  it('start() and stop() are idempotent', async () => {
    const findStale = vi.fn(
      async (_now: number, _limit: number): Promise<DurableNodeLease[]> => []
    )
    const reclaimer = new NodeLedgerReclaimer({
      ledger: { findStale },
      reEnqueueRun: () => {},
      eventBus: { emit: () => {} },
      intervalMs: 10_000,
    })

    // Calling start twice must not create two timers. We assert this by
    // verifying that after two starts + a single stop, no further ticks run.
    reclaimer.start()
    reclaimer.start()
    await reclaimer.stop()
    await reclaimer.stop()

    // Manually trigger one tick to prove the instance is still usable.
    await reclaimer.tick()
    expect(findStale).toHaveBeenCalledTimes(1)
  })
})
