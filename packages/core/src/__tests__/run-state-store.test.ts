import { describe, expect, it } from 'vitest'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import { InMemoryRunStateStore } from '../persistence/in-memory-run-state-store.js'
import type { DzupRunState } from '../persistence/run-state-store.js'

function snapshot(overrides: Partial<DzupRunState> = {}): DzupRunState {
  return {
    version: 1,
    runId: 'run-1',
    agentId: 'agent-1',
    tenantId: 'tenant-1',
    messages: [new HumanMessage('hello'), new AIMessage('done')],
    iteration: 1,
    cumulativeUsage: [{ model: 'gpt-4', inputTokens: 10, outputTokens: 5 }],
    budget: { iterations: 1, emittedThresholds: [0.5] },
    stuckDetector: { recentCallKeys: ['search:{}'], errorCount: 0 },
    pendingApproval: { approvalId: 'approval-1', requestedAt: 123 },
    snapshotAt: 456,
    ...overrides,
  }
}

describe('InMemoryRunStateStore', () => {
  it('saves, overwrites, lists, and deletes snapshots by run id', async () => {
    const store = new InMemoryRunStateStore()

    await store.save(snapshot({ runId: 'run-1', iteration: 1 }))
    await store.save(snapshot({ runId: 'run-2', iteration: 2 }))
    await store.save(snapshot({ runId: 'run-1', iteration: 3 }))

    await expect(store.load('run-1')).resolves.toMatchObject({ runId: 'run-1', iteration: 3 })
    await expect(store.load('missing')).resolves.toBeUndefined()
    await expect(store.listRunIds()).resolves.toEqual(['run-1', 'run-2'])
    expect(store.size).toBe(2)

    await store.delete('run-1')
    await expect(store.load('run-1')).resolves.toBeUndefined()
    await expect(store.listRunIds()).resolves.toEqual(['run-2'])
  })

  it('isolates stored snapshots from caller-side container mutations', async () => {
    const store = new InMemoryRunStateStore()
    const original = snapshot()

    await store.save(original)
    original.messages.push(new AIMessage('mutated'))
    original.cumulativeUsage.push({ model: 'gpt-4', inputTokens: 1, outputTokens: 1 })
    original.budget?.emittedThresholds.push(0.9)
    original.stuckDetector?.recentCallKeys.push('mutated')

    const loaded = await store.load('run-1')
    expect(loaded?.messages).toHaveLength(2)
    expect(loaded?.cumulativeUsage).toHaveLength(1)
    expect(loaded?.budget?.emittedThresholds).toEqual([0.5])
    expect(loaded?.stuckDetector?.recentCallKeys).toEqual(['search:{}'])
  })

  it('returns cloned snapshots from load so callers cannot mutate store state', async () => {
    const store = new InMemoryRunStateStore()
    await store.save(snapshot())

    const loaded = await store.load('run-1')
    loaded?.messages.push(new AIMessage('mutated'))
    loaded?.cumulativeUsage.push({ model: 'gpt-4', inputTokens: 1, outputTokens: 1 })
    loaded?.budget?.emittedThresholds.push(0.9)
    loaded?.stuckDetector?.recentCallKeys.push('mutated')

    const reloaded = await store.load('run-1')
    expect(reloaded?.messages).toHaveLength(2)
    expect(reloaded?.cumulativeUsage).toHaveLength(1)
    expect(reloaded?.budget?.emittedThresholds).toEqual([0.5])
    expect(reloaded?.stuckDetector?.recentCallKeys).toEqual(['search:{}'])
  })

  it('clear removes every snapshot', async () => {
    const store = new InMemoryRunStateStore()
    await store.save(snapshot({ runId: 'run-1' }))
    await store.save(snapshot({ runId: 'run-2' }))

    store.clear()

    expect(store.size).toBe(0)
    await expect(store.listRunIds()).resolves.toEqual([])
  })
})
