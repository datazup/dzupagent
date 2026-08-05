/**
 * RunExecutor — isolated target faults must still decide the run's terminal state.
 *
 * ERR-C-25 made `runEvalSuite` isolate a throwing target into a zero-score case
 * so one bad case cannot discard a suite's other results. The suite therefore
 * resolves normally even when *nothing* succeeded, and `RunExecutor` recorded
 * such a run as `completed` — a wholly-failed run reported as a success, and
 * the reason two long-standing server retry tests began timing out waiting for
 * `failed`.
 *
 * These tests pin the boundary in both directions, because the interesting
 * property is not "faults fail the run" but *where* the threshold sits:
 * all-cases-faulted fails, any-lesser-number still completes. A `some`-shaped
 * threshold would pass the total-failure test while silently undoing ERR-C-25.
 */

import { describe, it, expect } from 'vitest'
import type {
  EvalRunRecord,
  EvalRunStore,
  EvalRunListFilter,
  EvalScorer,
  EvalSuite,
} from '@dzupagent/eval-contracts'
import { RunExecutor } from '../orchestrator/eval-orchestrator-runner.js'
import { QueueMetricsTracker } from '../orchestrator/eval-orchestrator-metrics.js'

const OWNER = 'owner-1'

class MemoryStore implements EvalRunStore {
  private runs = new Map<string, EvalRunRecord>()

  async saveRun(run: EvalRunRecord): Promise<void> {
    this.runs.set(run.id, { ...run })
  }
  async updateRun(runId: string, patch: Partial<EvalRunRecord>): Promise<void> {
    const cur = this.runs.get(runId)
    if (!cur) throw new Error(`run ${runId} missing`)
    this.runs.set(runId, { ...cur, ...patch })
  }
  async updateRunIf(
    runId: string,
    predicate: (run: EvalRunRecord) => boolean,
    patch: Partial<EvalRunRecord>,
  ): Promise<boolean> {
    const cur = this.runs.get(runId)
    if (!cur) throw new Error(`run ${runId} missing`)
    if (!predicate(cur)) return false
    this.runs.set(runId, { ...cur, ...patch })
    return true
  }
  async getRun(runId: string): Promise<EvalRunRecord | null> {
    const r = this.runs.get(runId)
    return r ? { ...r } : null
  }
  async listRuns(_filter?: EvalRunListFilter): Promise<EvalRunRecord[]> {
    return [...this.runs.values()].map((r) => ({ ...r }))
  }
  async listAllRuns(): Promise<EvalRunRecord[]> {
    return [...this.runs.values()].map((r) => ({ ...r }))
  }
}

/** Scorer that always passes, so a case's score reflects only the target. */
const alwaysPass: EvalScorer = {
  name: 'always-pass',
  async score() {
    return { score: 1, pass: true, reasoning: 'ok' }
  },
}

function makeSuite(caseIds: string[]): EvalSuite {
  return {
    name: 'toy-suite',
    cases: caseIds.map((id) => ({ id, input: id, expectedOutput: id.toUpperCase() })),
    scorers: [alwaysPass],
  }
}

function makeRun(suite: EvalSuite): EvalRunRecord {
  return {
    id: 'run-1',
    suiteId: suite.name,
    suite,
    status: 'running',
    createdAt: '2026-08-05T10:00:00.000Z',
    queuedAt: '2026-08-05T10:00:00.000Z',
    startedAt: '2026-08-05T10:00:01.000Z',
    attempts: 1,
    executionOwner: {
      ownerId: OWNER,
      claimedAt: '2026-08-05T10:00:01.000Z',
      leaseExpiresAt: '2026-08-05T11:00:00.000Z',
    },
  }
}

async function runWith(
  suite: EvalSuite,
  target: (input: string) => Promise<string>,
): Promise<{ store: MemoryStore; run: EvalRunRecord; metrics: QueueMetricsTracker }> {
  const store = new MemoryStore()
  const run = makeRun(suite)
  await store.saveRun(run)

  const metrics = new QueueMetricsTracker({
    store,
    pendingRunIds: [],
    pendingRunSet: new Set<string>(),
    activeRunControllers: new Map<string, AbortController>(),
  })

  const executor = new RunExecutor({
    store,
    ownerId: OWNER,
    queueMetrics: metrics,
    costCap: {},
    getExecuteTarget: () => async (input: string) => target(input),
  })

  await executor.execute(run, new AbortController())
  return { store, run, metrics }
}

describe('RunExecutor — isolated target faults', () => {
  it('fails the run when every case target throws', async () => {
    const { store } = await runWith(makeSuite(['case-1', 'case-2']), async () => {
      throw new Error('boom')
    })

    const final = await store.getRun('run-1')
    expect(final?.status).toBe('failed')
    // The thrown type survives isolation: `code` comes from `error.name`, so a
    // flattened generic code would mean the original error was reconstructed
    // rather than propagated.
    expect(final?.error?.code).toBe('Error')
    expect(final?.error?.message).toBe('boom')
    expect(final?.completedAt).toBeTruthy()
    expect(final?.attemptHistory?.[0]?.status).toBe('failed')
  })

  it('preserves a non-Error throw as an identifiable run failure', async () => {
    const { store } = await runWith(makeSuite(['case-1']), async () => {
      throw 'plain string'
    })

    const final = await store.getRun('run-1')
    expect(final?.status).toBe('failed')
    expect(final?.error?.code).toBe('UnknownError')
    expect(final?.error?.message).toBe('plain string')
  })

  it('still completes when only SOME cases fault, keeping ERR-C-25 isolation', async () => {
    // This is the mutation-sensitive case: an `every` -> `some` threshold would
    // fail this run, destroying the isolation ERR-C-25 exists to provide.
    const { store } = await runWith(makeSuite(['good', 'bad']), async (input) => {
      if (input === 'bad') throw new Error('boom')
      return input.toUpperCase()
    })

    const final = await store.getRun('run-1')
    expect(final?.status).toBe('completed')
    expect(final?.error).toBeUndefined()

    // The surviving case's result is retained rather than discarded, and the
    // faulted case is still reported as a fault rather than a plain zero.
    const results = final?.result?.results ?? []
    expect(results).toHaveLength(2)
    expect(results.find((r) => r.caseId === 'good')?.pass).toBe(true)
    const bad = results.find((r) => r.caseId === 'bad')
    expect(bad?.pass).toBe(false)
    expect(bad?.error?.name).toBe('Error')
    expect(bad?.error?.message).toBe('boom')
    // Half the cases passed — a run-level failure would have discarded this.
    expect(final?.result?.passRate).toBe(0.5)
  })

  it('completes a suite with no cases rather than treating it as total failure', async () => {
    const { store } = await runWith(makeSuite([]), async (input) => input)

    const final = await store.getRun('run-1')
    expect(final?.status).toBe('completed')
    expect(final?.error).toBeUndefined()
  })
})
