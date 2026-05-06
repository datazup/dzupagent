import { describe, it, expect } from 'vitest'
import type {
  EvalRunListFilter,
  EvalRunRecord,
  EvalRunStore,
  EvalSuite,
  EvalScorer,
} from '@dzupagent/eval-contracts'
import { EvalOrchestrator, EvalCostExceededError } from '../orchestrator/eval-orchestrator.js'

class MockRunStore implements EvalRunStore {
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
    return Array.from(this.runs.values()).map((r) => ({ ...r }))
  }
  async listAllRuns(): Promise<EvalRunRecord[]> {
    return Array.from(this.runs.values()).map((r) => ({ ...r }))
  }
}

const noopScorer: EvalScorer = {
  name: 'noop',
  async score() {
    return { score: 1, pass: true, reasoning: 'ok' }
  },
}

function buildSuite(): EvalSuite {
  return {
    name: 'cost-cap-suite',
    description: 'Test suite for cost cap',
    cases: [
      { id: 'a', input: 'first', expectedOutput: 'first' },
      { id: 'b', input: 'second', expectedOutput: 'second' },
      { id: 'c', input: 'third', expectedOutput: 'third' },
    ],
    scorers: [noopScorer],
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('waitFor timed out')
}

describe('EvalOrchestrator — costCapCents (QF-24)', () => {
  it('aborts the suite as failed when accumulated cost exceeds the cap', async () => {
    const store = new MockRunStore()
    // Simulate cost already past the cap on the very first case.
    const orchestrator = new EvalOrchestrator({
      store,
      executeTarget: async (input) => input,
      costCapCents: 100,
      getAccumulatedCostCents: () => 250,
    })

    const run = await orchestrator.queueRun({ suite: buildSuite() })

    // Wait until the run reaches a terminal state.
    await waitFor(async () => {
      const cur = await store.getRun(run.id)
      return cur?.status === 'completed' || cur?.status === 'failed'
    })

    const final = await store.getRun(run.id)
    expect(final?.status).toBe('failed')
    expect(final?.error?.code).toBe('EvalCostExceededError')
    expect(final?.error?.message).toContain('exceeded cost cap')
  })

  it('runs to completion when cost stays under the cap', async () => {
    const store = new MockRunStore()

    const orchestrator = new EvalOrchestrator({
      store,
      executeTarget: async (input) => input,
      costCapCents: 1000,
      getAccumulatedCostCents: () => 5,
    })

    const run = await orchestrator.queueRun({ suite: buildSuite() })

    await waitFor(async () => {
      const cur = await store.getRun(run.id)
      return cur?.status === 'completed' || cur?.status === 'failed'
    })

    const final = await store.getRun(run.id)
    expect(final?.status).toBe('completed')
  })

  it('exposes EvalCostExceededError class with code', () => {
    const err = new EvalCostExceededError('boom', 100, 200)
    expect(err.code).toBe('EVAL_COST_CAP_EXCEEDED')
    expect(err.capCents).toBe(100)
    expect(err.observedCents).toBe(200)
  })
})
