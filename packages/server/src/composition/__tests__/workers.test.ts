/**
 * Unit B — maybeStartNodeLedgerReclaimer glue + composition smoke.
 *
 * Verifies the wiring contract: the reclaimer is only constructed when both a
 * node ledger and a run queue are present, is started at most once per ledger
 * instance, and — composed with buildRunReEnqueuer — re-enqueues the owning run
 * of a stale node back onto a real queue.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  InMemoryDurableNodeLedger,
  InMemoryRunStore,
} from '@dzupagent/core/persistence'
import { createEventBus } from '@dzupagent/core/events'

import { maybeStartNodeLedgerReclaimer } from '../workers.js'
import { buildRunReEnqueuer } from '../../runtime/run-reenqueuer.js'
import { NodeLedgerReclaimer } from '../../runtime/node-ledger-reclaimer.js'
import { InMemoryRunQueue } from '../../queue/run-queue.js'
import type { ForgeServerConfig } from '../types.js'

function baseConfig(
  overrides: Partial<ForgeServerConfig> = {}
): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    // agentStore / modelRegistry are unused by the reclaimer wiring; cast for
    // the narrow slice this glue actually reads.
    agentStore: {} as ForgeServerConfig['agentStore'],
    eventBus: createEventBus(),
    modelRegistry: {} as ForgeServerConfig['modelRegistry'],
    ...overrides,
  }
}

describe('maybeStartNodeLedgerReclaimer', () => {
  it('does nothing when no nodeLedger is configured', () => {
    const findStale = vi.fn().mockResolvedValue([])
    const config = baseConfig({
      runQueue: new InMemoryRunQueue(),
      // nodeLedger intentionally omitted
    })

    expect(() => maybeStartNodeLedgerReclaimer(config)).not.toThrow()
    expect(findStale).not.toHaveBeenCalled()
  })

  it('does nothing when no runQueue is configured', () => {
    const ledger = new InMemoryDurableNodeLedger()
    const spy = vi.spyOn(ledger, 'findStale')
    const config = baseConfig({ nodeLedger: ledger })

    expect(() => maybeStartNodeLedgerReclaimer(config)).not.toThrow()
    expect(spy).not.toHaveBeenCalled()
  })

  it('starts at most once per ledger instance (WeakSet idempotency)', () => {
    const ledger = new InMemoryDurableNodeLedger()
    const startSpy = vi.spyOn(NodeLedgerReclaimer.prototype, 'start')
    try {
      const config = baseConfig({
        nodeLedger: ledger,
        runQueue: new InMemoryRunQueue(),
      })

      maybeStartNodeLedgerReclaimer(config)
      maybeStartNodeLedgerReclaimer(config)

      expect(startSpy).toHaveBeenCalledTimes(1)
    } finally {
      startSpy.mockRestore()
    }
  })

  it('composes ledger + reenqueuer + queue: a stale node re-enqueues its run', async () => {
    const runStore = new InMemoryRunStore()
    const run = await runStore.create({
      agentId: 'agent-x',
      input: { resume: true },
    })

    const ledger = new InMemoryDurableNodeLedger()
    // Seed a lease and let it expire so findStale(now) returns it.
    await ledger.acquire(run.id, 'node-1', 'idem-1', 'worker-a', 1_000, 0)

    const runQueue = new InMemoryRunQueue()
    const reEnqueueRun = buildRunReEnqueuer({ runStore, runQueue })

    const reclaimer = new NodeLedgerReclaimer({
      ledger,
      reEnqueueRun,
      eventBus: createEventBus(),
      // `now` well past the 1_000ms lease so the node is stale.
      now: () => 10_000,
    })

    const result = await reclaimer.tick()

    expect(result.reclaimed).toBe(1)
    expect(runQueue.stats().pending).toBe(1)
  })

  it('does not re-enqueue a stale node whose run is terminal', async () => {
    const runStore = new InMemoryRunStore()
    const run = await runStore.create({
      agentId: 'agent-y',
      input: {},
    })
    await runStore.update(run.id, { status: 'completed' })

    const ledger = new InMemoryDurableNodeLedger()
    await ledger.acquire(run.id, 'node-1', 'idem-2', 'worker-b', 1_000, 0)

    const runQueue = new InMemoryRunQueue()
    const reEnqueueRun = buildRunReEnqueuer({ runStore, runQueue })

    const reclaimer = new NodeLedgerReclaimer({
      ledger,
      reEnqueueRun,
      eventBus: createEventBus(),
      now: () => 10_000,
    })

    await reclaimer.tick()

    expect(runQueue.stats().pending).toBe(0)
  })
})
