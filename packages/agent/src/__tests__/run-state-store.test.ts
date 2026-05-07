/**
 * Tests for MC-AGT-04 Phase 1 — DzupRunState snapshot interface and
 * the in-memory store, plus the agent's iteration-boundary wiring.
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  InMemoryRunStateStore,
  type DzupRunState,
  type DzupRunStateStore,
} from '@dzupagent/core'
import { DzupAgent } from '../agent/dzip-agent.js'
import type { DzupAgentConfig } from '../agent/agent-types.js'

function createSequencedModel(responses: AIMessage[]): BaseChatModel {
  let idx = 0
  const model: Record<string, unknown> = {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => {
      const resp = responses[idx] ?? responses.at(-1) ?? new AIMessage('done')
      idx++
      return resp
    }),
    bindTools: vi.fn().mockReturnThis(),
  }
  return model as unknown as BaseChatModel
}

function baseSnapshot(overrides: Partial<DzupRunState> = {}): DzupRunState {
  return {
    version: 1,
    runId: 'run-1',
    agentId: 'agent-1',
    messages: [new HumanMessage('hello')],
    iteration: 1,
    cumulativeUsage: [],
    snapshotAt: Date.now(),
    ...overrides,
  }
}

describe('InMemoryRunStateStore', () => {
  it('saves and loads snapshots by runId', async () => {
    const store = new InMemoryRunStateStore()
    const snap = baseSnapshot()

    await store.save(snap)
    const loaded = await store.load('run-1')

    expect(loaded).toBeDefined()
    expect(loaded?.runId).toBe('run-1')
    expect(loaded?.iteration).toBe(1)
    expect(loaded?.messages).toHaveLength(1)
  })

  it('returns undefined for unknown runId', async () => {
    const store = new InMemoryRunStateStore()
    expect(await store.load('missing')).toBeUndefined()
  })

  it('overwrites a snapshot when save is called twice', async () => {
    const store = new InMemoryRunStateStore()
    await store.save(baseSnapshot({ iteration: 1 }))
    await store.save(baseSnapshot({ iteration: 5 }))

    const loaded = await store.load('run-1')
    expect(loaded?.iteration).toBe(5)
  })

  it('deletes snapshots', async () => {
    const store = new InMemoryRunStateStore()
    await store.save(baseSnapshot())

    await store.delete('run-1')

    expect(await store.load('run-1')).toBeUndefined()
    expect(await store.listRunIds()).toEqual([])
  })

  it('listRunIds returns every saved run id', async () => {
    const store = new InMemoryRunStateStore()
    await store.save(baseSnapshot({ runId: 'run-a' }))
    await store.save(baseSnapshot({ runId: 'run-b' }))
    await store.save(baseSnapshot({ runId: 'run-c' }))

    const ids = await store.listRunIds()
    expect(ids.sort()).toEqual(['run-a', 'run-b', 'run-c'])
  })

  it('isolates the stored snapshot from caller mutations', async () => {
    const store = new InMemoryRunStateStore()
    const snap = baseSnapshot()
    await store.save(snap)

    // Mutate the original after save — the stored copy must not change.
    snap.messages.push(new HumanMessage('mutated'))
    snap.iteration = 999

    const loaded = await store.load('run-1')
    expect(loaded?.iteration).toBe(1)
    expect(loaded?.messages).toHaveLength(1)
  })
})

describe('DzupAgent run-state snapshot wiring', () => {
  function makeConfig(
    runStateStore: DzupRunStateStore,
    overrides: Partial<DzupAgentConfig> = {},
  ): DzupAgentConfig {
    return {
      id: 'snapshot-agent',
      instructions: 'You are a snapshot agent.',
      model: createSequencedModel([new AIMessage('done')]),
      runStateStore,
      ...overrides,
    }
  }

  it('writes a snapshot at iteration boundaries when configured', async () => {
    const store = new InMemoryRunStateStore()
    const saveSpy = vi.spyOn(store, 'save')

    const agent = new DzupAgent(
      makeConfig(store, {
        model: createSequencedModel([new AIMessage('reply')]),
      }),
    )

    const result = await agent.generate([new HumanMessage('hi')], {
      runId: 'run-snap-1',
    })

    expect(result.stopReason).toBe('complete')
    // At least one snapshot must have been recorded (iteration + final).
    expect(saveSpy).toHaveBeenCalled()

    // Wait for fire-and-forget writes to settle then verify the store.
    await new Promise((resolve) => setImmediate(resolve))

    const snapshot = await store.load('run-snap-1')
    expect(snapshot).toBeDefined()
    expect(snapshot?.agentId).toBe('snapshot-agent')
    expect(snapshot?.version).toBe(1)
    expect(snapshot?.messages.length).toBeGreaterThan(0)
  })

  it('does not call the store when runStateStore is omitted', async () => {
    const store = new InMemoryRunStateStore()
    const saveSpy = vi.spyOn(store, 'save')

    const agent = new DzupAgent({
      id: 'no-snapshot-agent',
      instructions: 'You are a quiet agent.',
      model: createSequencedModel([new AIMessage('reply')]),
    })

    await agent.generate([new HumanMessage('hi')], { runId: 'run-x' })

    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('completes the run normally even when the snapshot store throws', async () => {
    // Failing store: every save rejects. The run must still complete.
    const failingStore: DzupRunStateStore = {
      save: vi.fn(async () => {
        throw new Error('disk full')
      }),
      load: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      listRunIds: vi.fn(async () => []),
    }

    const agent = new DzupAgent(
      makeConfig(failingStore, {
        model: createSequencedModel([new AIMessage('still works')]),
      }),
    )

    const result = await agent.generate([new HumanMessage('hi')], {
      runId: 'run-fail-1',
    })

    expect(result.stopReason).toBe('complete')
    expect(result.content).toBe('still works')
    expect(failingStore.save).toHaveBeenCalled()
  })

  it('synthesises a runId from the agent id when none is supplied', async () => {
    const store = new InMemoryRunStateStore()

    const agent = new DzupAgent(
      makeConfig(store, {
        id: 'auto-id-agent',
        model: createSequencedModel([new AIMessage('ok')]),
      }),
    )

    await agent.generate([new HumanMessage('hi')])
    await new Promise((resolve) => setImmediate(resolve))

    const ids = await store.listRunIds()
    expect(ids).toContain('agent:auto-id-agent')
  })

  it('threads tenantId from memoryScope into the snapshot', async () => {
    const store = new InMemoryRunStateStore()

    const agent = new DzupAgent(
      makeConfig(store, {
        model: createSequencedModel([new AIMessage('ok')]),
        memoryScope: { tenantId: 'acme-corp' },
      }),
    )

    await agent.generate([new HumanMessage('hi')], { runId: 'run-tenant-1' })
    await new Promise((resolve) => setImmediate(resolve))

    const snapshot = await store.load('run-tenant-1')
    expect(snapshot?.tenantId).toBe('acme-corp')
  })

  it('records a terminal snapshot with the stop reason at run completion', async () => {
    const store = new InMemoryRunStateStore()

    const agent = new DzupAgent(
      makeConfig(store, {
        model: createSequencedModel([new AIMessage('terminal-ok')]),
      }),
    )

    await agent.generate([new HumanMessage('hi')], { runId: 'run-terminal-1' })
    await new Promise((resolve) => setImmediate(resolve))

    const snapshot = await store.load('run-terminal-1')
    expect(snapshot).toBeDefined()
    // The final write carries terminalReason; in-iteration writes do not.
    // We only assert that a terminal-tagged snapshot was recorded since
    // the in-memory store overwrites prior writes with the latest one.
    expect(snapshot?.terminalReason).toBe('complete')
  })
})
