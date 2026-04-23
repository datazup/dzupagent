import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryReferenceTracker } from '../shared/reference-tracker.js'

describe('InMemoryReferenceTracker', () => {
  let tracker: InMemoryReferenceTracker

  beforeEach(() => {
    tracker = new InMemoryReferenceTracker()
  })

  // ─── trackReference dedup ─────────────────────────────────────

  it('trackReference increments only once for the same (run, entry) pair', async () => {
    await tracker.trackReference('run-1', 'entry-A', 'session')
    await tracker.trackReference('run-1', 'entry-A', 'session')
    await tracker.trackReference('run-1', 'entry-A', 'session')

    const results = await tracker.listEntriesAboveThreshold('session', 1)
    expect(results).toEqual([{ entryId: 'entry-A', runCount: 1 }])
  })

  it('multiple distinct runs increment the count independently', async () => {
    await tracker.trackReference('run-1', 'entry-A', 'session')
    await tracker.trackReference('run-2', 'entry-A', 'session')
    await tracker.trackReference('run-3', 'entry-A', 'session')

    const results = await tracker.listEntriesAboveThreshold('session', 1)
    expect(results).toEqual([{ entryId: 'entry-A', runCount: 3 }])
  })

  it('interleaves dedup and new-run increments correctly', async () => {
    await tracker.trackReference('run-1', 'entry-A', 'session')
    await tracker.trackReference('run-1', 'entry-A', 'session') // dup
    await tracker.trackReference('run-2', 'entry-A', 'session')
    await tracker.trackReference('run-2', 'entry-A', 'session') // dup
    await tracker.trackReference('run-3', 'entry-A', 'session')

    const results = await tracker.listEntriesAboveThreshold('session', 1)
    expect(results[0]!.runCount).toBe(3)
  })

  // ─── threshold filtering ───────────────────────────────────────

  it('threshold filtering returns only entries with runCount >= min', async () => {
    await tracker.trackReference('run-1', 'entry-A', 'session')
    await tracker.trackReference('run-2', 'entry-A', 'session')

    await tracker.trackReference('run-1', 'entry-B', 'session')

    const above2 = await tracker.listEntriesAboveThreshold('session', 2)
    expect(above2).toEqual([{ entryId: 'entry-A', runCount: 2 }])

    const above1 = await tracker.listEntriesAboveThreshold('session', 1)
    expect(above1.length).toBe(2)
  })

  it('threshold=1 returns all tracked entries in the namespace', async () => {
    await tracker.trackReference('run-1', 'entry-A', 'session')
    await tracker.trackReference('run-1', 'entry-B', 'session')
    await tracker.trackReference('run-1', 'entry-C', 'session')

    const results = await tracker.listEntriesAboveThreshold('session', 1)
    expect(results.length).toBe(3)
    expect(results.map(r => r.entryId).sort()).toEqual(['entry-A', 'entry-B', 'entry-C'])
  })

  it('high threshold returns empty when no entry qualifies', async () => {
    await tracker.trackReference('run-1', 'entry-A', 'session')
    await tracker.trackReference('run-2', 'entry-A', 'session')

    const results = await tracker.listEntriesAboveThreshold('session', 100)
    expect(results).toEqual([])
  })

  // ─── namespace isolation ───────────────────────────────────────

  it('namespace isolation: ns-A entries do not appear when querying ns-B', async () => {
    await tracker.trackReference('run-1', 'entry-A', 'ns-A')
    await tracker.trackReference('run-2', 'entry-A', 'ns-A')

    await tracker.trackReference('run-1', 'entry-B', 'ns-B')
    await tracker.trackReference('run-2', 'entry-B', 'ns-B')

    const nsA = await tracker.listEntriesAboveThreshold('ns-A', 1)
    expect(nsA).toEqual([{ entryId: 'entry-A', runCount: 2 }])

    const nsB = await tracker.listEntriesAboveThreshold('ns-B', 1)
    expect(nsB).toEqual([{ entryId: 'entry-B', runCount: 2 }])
  })

  it('no namespace filter (undefined) returns entries across every namespace', async () => {
    await tracker.trackReference('run-1', 'entry-A', 'ns-A')
    await tracker.trackReference('run-1', 'entry-B', 'ns-B')
    await tracker.trackReference('run-1', 'entry-C') // no namespace tag

    const all = await tracker.listEntriesAboveThreshold(undefined, 1)
    expect(all.length).toBe(3)
    expect(all.map(r => r.entryId).sort()).toEqual(['entry-A', 'entry-B', 'entry-C'])
  })

  it('results are sorted by descending runCount', async () => {
    await tracker.trackReference('r1', 'low', 'session')

    await tracker.trackReference('r1', 'med', 'session')
    await tracker.trackReference('r2', 'med', 'session')

    await tracker.trackReference('r1', 'hot', 'session')
    await tracker.trackReference('r2', 'hot', 'session')
    await tracker.trackReference('r3', 'hot', 'session')

    const results = await tracker.listEntriesAboveThreshold('session', 1)
    expect(results.map(r => r.entryId)).toEqual(['hot', 'med', 'low'])
    expect(results.map(r => r.runCount)).toEqual([3, 2, 1])
  })

  // ─── promoteEntry stub ─────────────────────────────────────────

  it('promoteEntry resolves without error', async () => {
    await expect(
      tracker.promoteEntry('entry-A', 'session', 'project'),
    ).resolves.toBeUndefined()
  })

  it('promoteEntry does not mutate reference counts', async () => {
    await tracker.trackReference('run-1', 'entry-A', 'session')
    await tracker.trackReference('run-2', 'entry-A', 'session')

    await tracker.promoteEntry('entry-A', 'session', 'project')

    const results = await tracker.listEntriesAboveThreshold('session', 1)
    expect(results).toEqual([{ entryId: 'entry-A', runCount: 2 }])
  })

  // ─── empty state ───────────────────────────────────────────────

  it('empty state returns an empty array for any threshold', async () => {
    const above0 = await tracker.listEntriesAboveThreshold('session', 0)
    const above1 = await tracker.listEntriesAboveThreshold('session', 1)
    const aboveNoNs = await tracker.listEntriesAboveThreshold(undefined, 1)

    expect(above0).toEqual([])
    expect(above1).toEqual([])
    expect(aboveNoNs).toEqual([])
  })

  // ─── edge cases ────────────────────────────────────────────────

  it('empty runId or entryId is ignored silently', async () => {
    await tracker.trackReference('', 'entry-A', 'session')
    await tracker.trackReference('run-1', '', 'session')

    const results = await tracker.listEntriesAboveThreshold('session', 1)
    expect(results).toEqual([])
  })

  it('later namespace argument overrides earlier namespace for the same entry', async () => {
    await tracker.trackReference('run-1', 'entry-A', 'ns-A')
    await tracker.trackReference('run-2', 'entry-A', 'ns-B')

    const nsA = await tracker.listEntriesAboveThreshold('ns-A', 1)
    const nsB = await tracker.listEntriesAboveThreshold('ns-B', 1)

    // Most-recent namespace wins; entry no longer visible in ns-A.
    expect(nsA).toEqual([])
    expect(nsB).toEqual([{ entryId: 'entry-A', runCount: 2 }])
  })

  it('tracking an entry without a namespace leaves it untagged', async () => {
    await tracker.trackReference('run-1', 'entry-A')
    await tracker.trackReference('run-2', 'entry-A')

    // Untagged entries don't match a namespace filter.
    const nsMatch = await tracker.listEntriesAboveThreshold('session', 1)
    expect(nsMatch).toEqual([])

    // But they do match a no-filter query.
    const anyNs = await tracker.listEntriesAboveThreshold(undefined, 1)
    expect(anyNs).toEqual([{ entryId: 'entry-A', runCount: 2 }])
  })

  it('multiple entries in the same namespace are all returned', async () => {
    for (let i = 0; i < 5; i++) {
      await tracker.trackReference(`run-${i}`, 'entry-hot', 'session')
    }
    for (let i = 0; i < 3; i++) {
      await tracker.trackReference(`run-${i}`, 'entry-warm', 'session')
    }
    await tracker.trackReference('run-0', 'entry-cold', 'session')

    const above3 = await tracker.listEntriesAboveThreshold('session', 3)
    expect(above3.map(r => r.entryId)).toEqual(['entry-hot', 'entry-warm'])
    expect(above3.map(r => r.runCount)).toEqual([5, 3])
  })
})
