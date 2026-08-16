import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryPipelineCheckpointStore } from '../pipeline/in-memory-checkpoint-store.js'
import type { PipelineCheckpoint } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheckpoint(overrides: Partial<PipelineCheckpoint> = {}): PipelineCheckpoint {
  return {
    pipelineRunId: 'run-1',
    pipelineId: 'pipeline-1',
    version: 1,
    schemaVersion: '1.0.0',
    completedNodeIds: ['start'],
    state: { result: 'ok' },
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InMemoryPipelineCheckpointStore', () => {
  let store: InMemoryPipelineCheckpointStore

  beforeEach(() => {
    store = new InMemoryPipelineCheckpointStore()
  })

  it('save/load round-trip', async () => {
    const cp = makeCheckpoint()
    await store.save(cp)
    const loaded = await store.load('run-1')
    expect(loaded).toBeDefined()
    expect(loaded!.pipelineRunId).toBe('run-1')
    expect(loaded!.version).toBe(1)
    expect(loaded!.state).toEqual({ result: 'ok' })
  })

  it('load returns latest version', async () => {
    await store.save(makeCheckpoint({ version: 1, completedNodeIds: ['start'] }))
    await store.save(makeCheckpoint({ version: 2, completedNodeIds: ['start', 'middle'] }))
    await store.save(makeCheckpoint({ version: 3, completedNodeIds: ['start', 'middle', 'end'] }))

    const latest = await store.load('run-1')
    expect(latest).toBeDefined()
    expect(latest!.version).toBe(3)
    expect(latest!.completedNodeIds).toEqual(['start', 'middle', 'end'])
  })

  it('loadVersion returns specific version', async () => {
    await store.save(makeCheckpoint({ version: 1, state: { step: 1 } }))
    await store.save(makeCheckpoint({ version: 2, state: { step: 2 } }))
    await store.save(makeCheckpoint({ version: 3, state: { step: 3 } }))

    const v2 = await store.loadVersion('run-1', 2)
    expect(v2).toBeDefined()
    expect(v2!.version).toBe(2)
    expect(v2!.state).toEqual({ step: 2 })
  })

  it('loadVersion returns undefined for nonexistent version', async () => {
    await store.save(makeCheckpoint({ version: 1 }))
    const result = await store.loadVersion('run-1', 99)
    expect(result).toBeUndefined()
  })

  it('load returns undefined for nonexistent run', async () => {
    const result = await store.load('nonexistent')
    expect(result).toBeUndefined()
  })

  it('listVersions returns all versions sorted ascending', async () => {
    await store.save(makeCheckpoint({ version: 3, completedNodeIds: ['a', 'b', 'c'], createdAt: '2026-01-03T00:00:00Z' }))
    await store.save(makeCheckpoint({ version: 1, completedNodeIds: ['a'], createdAt: '2026-01-01T00:00:00Z' }))
    await store.save(makeCheckpoint({ version: 2, completedNodeIds: ['a', 'b'], createdAt: '2026-01-02T00:00:00Z' }))

    const versions = await store.listVersions('run-1')
    expect(versions).toHaveLength(3)
    expect(versions[0]!.version).toBe(1)
    expect(versions[1]!.version).toBe(2)
    expect(versions[2]!.version).toBe(3)
    expect(versions[2]!.completedNodeCount).toBe(3)
  })

  it('listVersions returns empty array for nonexistent run', async () => {
    const versions = await store.listVersions('nonexistent')
    expect(versions).toEqual([])
  })

  it('delete removes all versions', async () => {
    await store.save(makeCheckpoint({ version: 1 }))
    await store.save(makeCheckpoint({ version: 2 }))
    await store.save(makeCheckpoint({ version: 3 }))

    await store.delete('run-1')

    const loaded = await store.load('run-1')
    expect(loaded).toBeUndefined()

    const versions = await store.listVersions('run-1')
    expect(versions).toEqual([])
  })

  it('prune removes old entries and returns count', async () => {
    const old = new Date(Date.now() - 60_000).toISOString()  // 60s ago
    const recent = new Date().toISOString()

    await store.save(makeCheckpoint({ pipelineRunId: 'old-run', version: 1, createdAt: old }))
    await store.save(makeCheckpoint({ pipelineRunId: 'old-run', version: 2, createdAt: old }))
    await store.save(makeCheckpoint({ pipelineRunId: 'new-run', version: 1, createdAt: recent }))

    // Prune entries older than 30s
    const pruned = await store.prune(30_000)
    expect(pruned).toBe(2)

    // Old run should be gone
    expect(await store.load('old-run')).toBeUndefined()

    // New run should still be there
    const newRun = await store.load('new-run')
    expect(newRun).toBeDefined()
    expect(newRun!.pipelineRunId).toBe('new-run')
  })

  it('structuredClone isolation — modifying returned object does not affect store', async () => {
    await store.save(makeCheckpoint({ version: 1, state: { count: 0 } }))

    const loaded = await store.load('run-1')
    expect(loaded).toBeDefined()

    // Mutate the returned object
    loaded!.state['count'] = 999
    loaded!.completedNodeIds.push('mutated')

    // Re-load — should be unaffected
    const fresh = await store.load('run-1')
    expect(fresh!.state['count']).toBe(0)
    expect(fresh!.completedNodeIds).toEqual(['start'])
  })

  it('structuredClone isolation — modifying input after save does not affect store', async () => {
    const cp = makeCheckpoint({ version: 1, state: { value: 'original' } })
    await store.save(cp)

    // Mutate the input object after save
    cp.state['value'] = 'mutated'

    const loaded = await store.load('run-1')
    expect(loaded!.state['value']).toBe('original')
  })

  // -------------------------------------------------------------------------
  // E1 — compare-and-set writes
  // -------------------------------------------------------------------------

  describe('saveIfVersion (CAS)', () => {
    it('commits when the observed version matches, and reports the written version', async () => {
      const receipt = await store.saveIfVersion(makeCheckpoint({ version: 1 }), 0)

      expect(receipt).toEqual({ committed: true, observedVersion: 1 })
      expect((await store.load('run-1'))!.version).toBe(1)
    })

    it('an empty run observes 0, which is what the first write expects', async () => {
      // The writer starts its tracker at 0 and pre-increments, so version 1 is
      // the first checkpoint ever written. A stale expectation must still lose.
      const stale = await store.saveIfVersion(makeCheckpoint({ version: 2 }), 1)

      expect(stale).toEqual({ committed: false, observedVersion: 0 })
      expect(await store.load('run-1')).toBeUndefined()
    })

    it('rejects a stale expected version without writing', async () => {
      await store.saveIfVersion(makeCheckpoint({ version: 1, state: { by: 'first' } }), 0)

      const conflict = await store.saveIfVersion(
        makeCheckpoint({ version: 2, state: { by: 'stale' } }),
        0, // expects the pre-write world; the store is already at 1
      )

      expect(conflict).toEqual({ committed: false, observedVersion: 1 })
      const loaded = await store.load('run-1')
      expect(loaded!.version).toBe(1)
      expect(loaded!.state).toEqual({ by: 'first' })
    })

    it('two writers racing one version: exactly one commits, the loser observes the winner', async () => {
      // The real interleaving, not an assertion about a receipt in isolation.
      // Both writers read the same expected version and are dispatched before
      // either resolves, which is precisely the clobber `save` cannot detect.
      const expectedVersion = 0

      const [a, b] = await Promise.all([
        store.saveIfVersion(
          makeCheckpoint({ version: 1, state: { by: 'writer-a' } }),
          expectedVersion,
        ),
        store.saveIfVersion(
          makeCheckpoint({ version: 1, state: { by: 'writer-b' } }),
          expectedVersion,
        ),
      ])

      const winners = [a, b].filter(r => r.committed)
      const losers = [a, b].filter(r => !r.committed)
      expect(winners).toHaveLength(1)
      expect(losers).toHaveLength(1)

      // The loser must observe the winner's version, not its own attempt.
      expect(losers[0]!.observedVersion).toBe(1)

      // Only one checkpoint landed — the other did not clobber it.
      expect(await store.listVersions('run-1')).toHaveLength(1)
      const survivor = await store.load('run-1')
      const winnerName = winners[0] === a ? 'writer-a' : 'writer-b'
      expect(survivor!.state).toEqual({ by: winnerName })
    })

    it('does not throw on conflict', async () => {
      await store.saveIfVersion(makeCheckpoint({ version: 1 }), 0)

      await expect(
        store.saveIfVersion(makeCheckpoint({ version: 2 }), 99),
      ).resolves.toEqual({ committed: false, observedVersion: 1 })
    })

    it('clones on commit — mutating the input afterwards does not affect the store', async () => {
      const cp = makeCheckpoint({ version: 1, state: { value: 'original' } })
      await store.saveIfVersion(cp, 0)

      cp.state['value'] = 'mutated'

      expect((await store.load('run-1'))!.state['value']).toBe('original')
    })
  })
})
