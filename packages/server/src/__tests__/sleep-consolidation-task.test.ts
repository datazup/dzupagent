import { describe, it, expect, vi } from 'vitest'
import {
  createSleepConsolidationTask,
  type SleepConsolidatorLike,
  type SleepConsolidationReportLike,
} from '../runtime/sleep-consolidation-task.js'

function makeMockConsolidator(
  report: SleepConsolidationReportLike,
): SleepConsolidatorLike {
  return { run: vi.fn().mockResolvedValue(report) }
}

function makeReport(
  overrides: Partial<SleepConsolidationReportLike> = {},
): SleepConsolidationReportLike {
  return {
    namespaces: [
      {
        namespace: ['agent', 'session1'],
        deduplicated: 5,
        pruned: 3,
        contradictionsFound: 1,
        healed: 2,
        lessonsDeduplicated: 4,
        conventionsExtracted: 2,
        stalenessPruned: 1,
      },
      {
        namespace: ['agent', 'session2'],
        deduplicated: 2,
        pruned: 1,
        contradictionsFound: 0,
        healed: 1,
        lessonsDeduplicated: 0,
        conventionsExtracted: 1,
        stalenessPruned: 0,
      },
    ],
    totalLLMCalls: 12,
    durationMs: 450,
    phasesRun: ['dedup', 'decay-prune', 'heal'],
    ...overrides,
  }
}

describe('createSleepConsolidationTask', () => {
  it('maps SleepConsolidationReport to ConsolidationReport correctly', async () => {
    const report = makeReport()
    const consolidator = makeMockConsolidator(report)
    const store = {} // mock store
    const namespaces = [['agent', 'session1'], ['agent', 'session2']]

    const task = createSleepConsolidationTask({ consolidator, store, namespaces })
    const result = await task.run(new AbortController().signal)

    // ns1: pruned=3+stalenessPruned=1=4, ns2: pruned=1+stalenessPruned=0=1 => total pruned=5
    expect(result.pruned).toBe(5)

    // ns1: deduplicated=5+lessonsDeduplicated=4=9, ns2: deduplicated=2+lessonsDeduplicated=0=2 => total merged=11
    expect(result.merged).toBe(11)

    // ns1: 5+3+2+4+2+1+1=18, ns2: 2+1+0+1+0+1+0=5 => total recordsProcessed=23
    expect(result.recordsProcessed).toBe(23)

    expect(result.durationMs).toBe(450)
  })

  it('passes store and namespaces to the consolidator', async () => {
    const consolidator = makeMockConsolidator(makeReport({ namespaces: [] }))
    const store = { fake: true }
    const namespaces = [['ns1'], ['ns2']]

    const task = createSleepConsolidationTask({ consolidator, store, namespaces })
    await task.run(new AbortController().signal)

    expect(consolidator.run).toHaveBeenCalledWith(store, namespaces)
  })

  it('throws AbortError if signal is already aborted', async () => {
    const consolidator = makeMockConsolidator(makeReport())
    const task = createSleepConsolidationTask({
      consolidator,
      store: {},
      namespaces: [['a']],
    })

    const ac = new AbortController()
    ac.abort()

    await expect(task.run(ac.signal)).rejects.toThrow('Consolidation aborted before start')
    expect(consolidator.run).not.toHaveBeenCalled()
  })

  it('throws AbortError if signal is aborted during consolidation', async () => {
    let resolveConsolidation!: (v: SleepConsolidationReportLike) => void
    const consolidator: SleepConsolidatorLike = {
      run: vi.fn().mockImplementation(
        () => new Promise<SleepConsolidationReportLike>((resolve) => {
          resolveConsolidation = resolve
        }),
      ),
    }

    const ac = new AbortController()
    const task = createSleepConsolidationTask({
      consolidator,
      store: {},
      namespaces: [['a']],
    })

    const promise = task.run(ac.signal)

    // Abort while consolidation is "in progress"
    ac.abort()

    // Now resolve the consolidation — the task should still throw
    resolveConsolidation(makeReport({ namespaces: [] }))

    await expect(promise).rejects.toThrow('Consolidation aborted after completion')
  })

  it('handles empty namespaces report', async () => {
    const consolidator = makeMockConsolidator(
      makeReport({ namespaces: [], durationMs: 10 }),
    )
    const task = createSleepConsolidationTask({
      consolidator,
      store: {},
      namespaces: [],
    })

    const result = await task.run(new AbortController().signal)

    expect(result.recordsProcessed).toBe(0)
    expect(result.pruned).toBe(0)
    expect(result.merged).toBe(0)
    expect(result.durationMs).toBe(10)
  })

  it('propagates consolidator errors', async () => {
    const consolidator: SleepConsolidatorLike = {
      run: vi.fn().mockRejectedValue(new Error('LLM quota exceeded')),
    }

    const task = createSleepConsolidationTask({
      consolidator,
      store: {},
      namespaces: [['a']],
    })

    await expect(task.run(new AbortController().signal)).rejects.toThrow(
      'LLM quota exceeded',
    )
  })
})
