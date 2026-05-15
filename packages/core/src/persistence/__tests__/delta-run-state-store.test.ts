import { describe, it, expect, beforeEach } from 'vitest'
import { DeltaRunStateStore } from '../delta-run-state-store.js'
import type { DzupRunState } from '../run-state-store.js'

function makeState(overrides: Partial<DzupRunState> = {}): DzupRunState {
  return {
    version: 1,
    runId: 'run-1',
    agentId: 'agent-1',
    messages: [],
    cumulativeUsage: [],
    iteration: 0,
    snapshotAt: Date.now(),
    ...overrides,
  }
}

describe('DeltaRunStateStore', () => {
  let store: DeltaRunStateStore

  beforeEach(() => {
    store = new DeltaRunStateStore({ fullSnapshotInterval: 3 })
  })

  it('returns undefined for unknown runId', async () => {
    expect(await store.load('no-such-run')).toBeUndefined()
  })

  it('saves and loads a single state', async () => {
    const s = makeState({ iteration: 1 })
    await store.save(s)
    const loaded = await store.load('run-1')
    expect(loaded?.iteration).toBe(1)
    expect(loaded?.runId).toBe('run-1')
  })

  it('accumulates messages across deltas', async () => {
    const msg1 = { lc_serializable: true, content: 'hi', _getType: () => 'human' } as never
    const msg2 = { lc_serializable: true, content: 'hello', _getType: () => 'ai' } as never

    // First save: state has 1 message
    await store.save(makeState({ messages: [msg1], iteration: 1 }))
    // Second save: state has 2 messages (cumulative — delta = [msg2])
    await store.save(makeState({ messages: [msg1, msg2], iteration: 2 }))

    const loaded = await store.load('run-1')
    // Delta store replays: [] + [msg1] + [msg2] = 2 messages
    expect(loaded?.messages).toHaveLength(2)
    expect(loaded?.iteration).toBe(2)
  })

  it('accumulates usage across deltas', async () => {
    const u1 = { model: 'c', inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    const u2 = { model: 'c', inputTokens: 20, outputTokens: 8, totalTokens: 28 }

    // First save has 1 usage record
    await store.save(makeState({ cumulativeUsage: [u1] }))
    // Second save has 2 usage records (cumulative — delta = [u2])
    await store.save(makeState({ cumulativeUsage: [u1, u2] }))

    const loaded = await store.load('run-1')
    expect(loaded?.cumulativeUsage).toHaveLength(2)
  })

  it('records a full snapshot every N saves', async () => {
    for (let i = 1; i <= 4; i++) {
      await store.save(makeState({ iteration: i }))
    }
    // interval=3 → snapshot at save #3
    expect(store.snapshotCount('run-1')).toBe(1)
    expect(store.deltaCount('run-1')).toBe(4)
  })

  it('deletes all state for a run', async () => {
    await store.save(makeState())
    await store.delete('run-1')
    expect(await store.load('run-1')).toBeUndefined()
    expect(store.deltaCount('run-1')).toBe(0)
  })

  it('lists run IDs', async () => {
    await store.save(makeState({ runId: 'a' }))
    await store.save(makeState({ runId: 'b' }))
    const ids = await store.listRunIds()
    expect(ids).toContain('a')
    expect(ids).toContain('b')
  })

  it('replays correctly past a full snapshot boundary', async () => {
    for (let i = 1; i <= 6; i++) {
      await store.save(makeState({ iteration: i }))
    }
    // snapshots at seq 3 and 6
    expect(store.snapshotCount('run-1')).toBe(2)
    const loaded = await store.load('run-1')
    expect(loaded?.iteration).toBe(6)
  })

  it('updates scalar fields (terminalReason)', async () => {
    await store.save(makeState({ iteration: 1 }))
    await store.save(makeState({ iteration: 2, terminalReason: 'done' }))
    const loaded = await store.load('run-1')
    expect(loaded?.terminalReason).toBe('done')
  })
})
