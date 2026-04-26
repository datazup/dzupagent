import { describe, expect, it } from 'vitest'
import type {
  BenchmarkCategory,
  BenchmarkComparison,
  BenchmarkResult,
  BenchmarkRunRecord,
  BenchmarkSuite,
  DatasetMetadata,
  EvalCase,
  EvalDatasetLike,
  EvalEntry,
  EvalExecutionContext,
  EvalOrchestratorLike,
  EvalResult,
  EvalRunListFilter,
  EvalRunRecord,
  EvalRunStatus,
  EvalRunStore,
  EvalScorer,
  EvalSuite,
  ScorerConfigLike,
} from '../index.js'

// ---------------------------------------------------------------------------
// Helpers: build minimal valid records so field requirements are explicit
// ---------------------------------------------------------------------------

function makeEvalRunRecord(overrides: Partial<EvalRunRecord> = {}): EvalRunRecord {
  const suite: EvalSuite = {
    name: 'test-suite',
    cases: [],
    scorers: [],
  }
  return {
    id: 'run-001',
    suiteId: 'suite-001',
    suite,
    status: 'queued',
    createdAt: '2026-04-26T00:00:00.000Z',
    queuedAt: '2026-04-26T00:00:00.000Z',
    attempts: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// EvalResult
// ---------------------------------------------------------------------------

describe('@dzupagent/eval-contracts', () => {
  describe('EvalResult', () => {
    it('holds score, pass, and reasoning', () => {
      const result: EvalResult = {
        score: 0.85,
        pass: true,
        reasoning: 'Output matched criteria',
      }

      expect(result.score).toBe(0.85)
      expect(result.pass).toBe(true)
      expect(result.reasoning).toBe('Output matched criteria')
      expect(result.metadata).toBeUndefined()
    })

    it('accepts optional metadata', () => {
      const result: EvalResult = {
        score: 0.0,
        pass: false,
        reasoning: 'No match',
        metadata: { detail: 'missing keyword' },
      }

      expect(result.metadata).toEqual({ detail: 'missing keyword' })
    })
  })

  // ---------------------------------------------------------------------------
  // EvalScorer
  // ---------------------------------------------------------------------------

  describe('EvalScorer', () => {
    it('is satisfied by a minimal async implementation', async () => {
      const scorer: EvalScorer = {
        name: 'always-pass',
        score: async (_input, _output, _reference) => ({
          score: 1.0,
          pass: true,
          reasoning: 'stub',
        }),
      }

      const result = await scorer.score('prompt', 'response')
      expect(result.score).toBe(1.0)
      expect(result.pass).toBe(true)
    })

    it('receives reference argument when provided', async () => {
      const received: string[] = []
      const scorer: EvalScorer = {
        name: 'capture',
        score: async (input, output, reference) => {
          received.push(input, output, reference ?? 'NO_REF')
          return { score: 0.5, pass: false, reasoning: 'captured' }
        },
      }

      await scorer.score('q', 'a', 'expected-answer')
      expect(received).toEqual(['q', 'a', 'expected-answer'])
    })
  })

  // ---------------------------------------------------------------------------
  // EvalCase and EvalSuite
  // ---------------------------------------------------------------------------

  describe('EvalCase', () => {
    it('requires id and input; all other fields optional', () => {
      const c: EvalCase = { id: 'c-1', input: 'what is 2+2?' }

      expect(c.id).toBe('c-1')
      expect(c.expectedOutput).toBeUndefined()
      expect(c.metadata).toBeUndefined()
    })
  })

  describe('EvalSuite', () => {
    it('holds name, cases, and scorers', () => {
      const suite: EvalSuite = {
        name: 'arithmetic',
        description: 'Basic math tests',
        cases: [{ id: 'c-1', input: '1+1', expectedOutput: '2' }],
        scorers: [],
        passThreshold: 0.9,
      }

      expect(suite.name).toBe('arithmetic')
      expect(suite.cases).toHaveLength(1)
      expect(suite.passThreshold).toBe(0.9)
    })
  })

  // ---------------------------------------------------------------------------
  // EvalRunRecord
  // ---------------------------------------------------------------------------

  describe('EvalRunRecord', () => {
    it('can be constructed with required fields', () => {
      const run = makeEvalRunRecord()

      expect(run.id).toBe('run-001')
      expect(run.suiteId).toBe('suite-001')
      expect(run.status).toBe('queued')
      expect(run.attempts).toBe(0)
      expect(run.startedAt).toBeUndefined()
      expect(run.completedAt).toBeUndefined()
      expect(run.result).toBeUndefined()
    })

    it('accepts all optional fields', () => {
      const run = makeEvalRunRecord({
        status: 'completed',
        startedAt: '2026-04-26T00:01:00.000Z',
        completedAt: '2026-04-26T00:02:00.000Z',
        attempts: 1,
        metadata: { triggeredBy: 'ci' },
        error: undefined,
        recovery: undefined,
        executionOwner: {
          ownerId: 'worker-1',
          claimedAt: '2026-04-26T00:01:00.000Z',
          leaseExpiresAt: '2026-04-26T00:06:00.000Z',
        },
      })

      expect(run.status).toBe('completed')
      expect(run.executionOwner?.ownerId).toBe('worker-1')
      expect(run.metadata).toEqual({ triggeredBy: 'ci' })
    })

    it('status values are the expected EvalRunStatus union', () => {
      const statuses: EvalRunStatus[] = [
        'queued',
        'running',
        'completed',
        'failed',
        'cancelled',
      ]

      for (const status of statuses) {
        const run = makeEvalRunRecord({ status })
        expect(run.status).toBe(status)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // EvalRunListFilter
  // ---------------------------------------------------------------------------

  describe('EvalRunListFilter', () => {
    it('accepts empty filter', () => {
      const filter: EvalRunListFilter = {}
      expect(filter.suiteId).toBeUndefined()
      expect(filter.status).toBeUndefined()
      expect(filter.limit).toBeUndefined()
    })

    it('accepts fully-populated filter', () => {
      const filter: EvalRunListFilter = {
        suiteId: 'suite-1',
        status: 'failed',
        limit: 20,
      }
      expect(filter.suiteId).toBe('suite-1')
      expect(filter.status).toBe('failed')
      expect(filter.limit).toBe(20)
    })
  })

  // ---------------------------------------------------------------------------
  // EvalRunStore
  // ---------------------------------------------------------------------------

  describe('EvalRunStore', () => {
    it('updateRunIf predicate signature works end-to-end', async () => {
      const store = new Map<string, EvalRunRecord>()

      const inMemoryStore: EvalRunStore = {
        async saveRun(run) {
          store.set(run.id, run)
        },
        async updateRun(runId, patch) {
          const existing = store.get(runId)
          if (existing) store.set(runId, { ...existing, ...patch })
        },
        async updateRunIf(runId, predicate, patch) {
          const existing = store.get(runId)
          if (!existing || !predicate(existing)) return false
          store.set(runId, { ...existing, ...patch })
          return true
        },
        async getRun(runId) {
          return store.get(runId) ?? null
        },
        async listRuns(filter) {
          const all = Array.from(store.values())
          if (filter?.status) return all.filter((r) => r.status === filter.status)
          if (filter?.suiteId) return all.filter((r) => r.suiteId === filter.suiteId)
          return all
        },
        async listAllRuns() {
          return Array.from(store.values())
        },
      }

      const run = makeEvalRunRecord({ id: 'r-1', status: 'queued' })
      await inMemoryStore.saveRun(run)

      // updateRunIf — predicate matches
      const patched = await inMemoryStore.updateRunIf(
        'r-1',
        (r) => r.status === 'queued',
        { status: 'running' },
      )
      expect(patched).toBe(true)
      expect((await inMemoryStore.getRun('r-1'))?.status).toBe('running')

      // updateRunIf — predicate does not match
      const skipped = await inMemoryStore.updateRunIf(
        'r-1',
        (r) => r.status === 'queued', // run is now 'running'
        { status: 'completed' },
      )
      expect(skipped).toBe(false)
      expect((await inMemoryStore.getRun('r-1'))?.status).toBe('running')
    })
  })

  // ---------------------------------------------------------------------------
  // EvalOrchestratorLike
  // ---------------------------------------------------------------------------

  describe('EvalOrchestratorLike', () => {
    it('is satisfied by a minimal mock implementation', async () => {
      const runs = new Map<string, EvalRunRecord>()

      const orchestrator: EvalOrchestratorLike = {
        canExecute: () => true,
        async queueRun({ suite }) {
          const run = makeEvalRunRecord({
            id: `run-${Date.now()}`,
            suiteId: suite.name,
            suite,
          })
          runs.set(run.id, run)
          return run
        },
        async cancelRun(runId) {
          const run = runs.get(runId)!
          const updated = { ...run, status: 'cancelled' as EvalRunStatus }
          runs.set(runId, updated)
          return updated
        },
        async retryRun(runId) {
          const run = runs.get(runId)!
          const updated = { ...run, status: 'queued' as EvalRunStatus, attempts: run.attempts + 1 }
          runs.set(runId, updated)
          return updated
        },
        async getRun(runId) {
          return runs.get(runId) ?? null
        },
        async listRuns(filter) {
          const all = Array.from(runs.values())
          if (filter?.status) return all.filter((r) => r.status === filter.status)
          return all
        },
        async getQueueStats() {
          return {
            pending: 0,
            active: 0,
            oldestPendingAgeMs: null,
            enqueued: 0,
            started: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
            retried: 0,
            recovered: 0,
            requeued: 0,
          }
        },
      }

      expect(orchestrator.canExecute()).toBe(true)

      const suite: EvalSuite = { name: 'mock-suite', cases: [], scorers: [] }
      const queued = await orchestrator.queueRun({ suite })
      expect(queued.suiteId).toBe('mock-suite')
      expect(queued.status).toBe('queued')

      const cancelled = await orchestrator.cancelRun(queued.id)
      expect(cancelled.status).toBe('cancelled')

      const retried = await orchestrator.retryRun(queued.id)
      expect(retried.status).toBe('queued')
      expect(retried.attempts).toBe(1)

      const fetched = await orchestrator.getRun(queued.id)
      expect(fetched).not.toBeNull()

      const stats = await orchestrator.getQueueStats()
      expect(stats.pending).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // EvalExecutionContext
  // ---------------------------------------------------------------------------

  describe('EvalExecutionContext', () => {
    it('can be constructed with all required and optional fields', () => {
      const ctx: EvalExecutionContext = {
        suiteId: 'suite-1',
        runId: 'run-1',
        attempt: 1,
        metadata: { env: 'ci' },
        signal: new AbortController().signal,
      }

      expect(ctx.suiteId).toBe('suite-1')
      expect(ctx.attempt).toBe(1)
      expect(ctx.metadata).toEqual({ env: 'ci' })
    })

    it('accepts context without optional metadata', () => {
      const ctx: EvalExecutionContext = {
        suiteId: 'suite-1',
        runId: 'run-1',
        attempt: 0,
        signal: new AbortController().signal,
      }

      expect(ctx.metadata).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // EvalDatasetLike
  // ---------------------------------------------------------------------------

  describe('EvalDatasetLike', () => {
    it('is satisfied by a minimal implementation', () => {
      const entries: EvalEntry[] = [
        { id: 'e-1', input: 'hello', expectedOutput: 'world' },
        { id: 'e-2', input: 'foo' },
      ]
      const meta: DatasetMetadata = {
        name: 'test-dataset',
        totalEntries: entries.length,
        tags: ['smoke'],
      }

      const dataset: EvalDatasetLike = {
        metadata: meta,
        entries: () => entries,
        size: () => entries.length,
      }

      expect(dataset.size()).toBe(2)
      expect(dataset.entries()).toHaveLength(2)
      expect(dataset.metadata.name).toBe('test-dataset')
      expect(dataset.metadata.tags).toContain('smoke')
    })
  })

  // ---------------------------------------------------------------------------
  // BenchmarkSuite and BenchmarkCategory
  // ---------------------------------------------------------------------------

  describe('BenchmarkSuite', () => {
    it('accepts all required benchmark fields', () => {
      const scorerConfig: ScorerConfigLike = {
        id: 'sc-1',
        name: 'exact-match',
        type: 'deterministic',
        threshold: 0.8,
      }

      const suite: BenchmarkSuite = {
        id: 'bench-1',
        name: 'Code Gen Bench',
        description: 'Tests code generation quality',
        category: 'code-gen',
        dataset: [{ id: 'e-1', input: 'write a hello world function' }],
        scorers: [scorerConfig],
        baselineThresholds: { 'sc-1': 0.75 },
      }

      expect(suite.id).toBe('bench-1')
      expect(suite.category).toBe('code-gen')
      expect(suite.scorers).toHaveLength(1)
      expect(suite.baselineThresholds['sc-1']).toBe(0.75)
    })

    it('valid benchmark categories satisfy the union type', () => {
      const categories: BenchmarkCategory[] = [
        'code-gen',
        'qa',
        'tool-use',
        'multi-turn',
        'self-correction',
      ]

      expect(categories).toHaveLength(5)
      expect(categories).toContain('multi-turn')
    })
  })

  // ---------------------------------------------------------------------------
  // BenchmarkResult and BenchmarkComparison
  // ---------------------------------------------------------------------------

  describe('BenchmarkResult', () => {
    it('can be constructed with required fields', () => {
      const result: BenchmarkResult = {
        suiteId: 'bench-1',
        timestamp: '2026-04-26T00:00:00.000Z',
        scores: { 'exact-match': 0.9 },
        passedBaseline: true,
        regressions: [],
      }

      expect(result.passedBaseline).toBe(true)
      expect(result.regressions).toHaveLength(0)
      expect(result.scores['exact-match']).toBe(0.9)
    })

    it('captures regressions when scores fall below threshold', () => {
      const result: BenchmarkResult = {
        suiteId: 'bench-2',
        timestamp: '2026-04-26T00:00:00.000Z',
        scores: { 'semantic-match': 0.55 },
        passedBaseline: false,
        regressions: ['semantic-match'],
      }

      expect(result.passedBaseline).toBe(false)
      expect(result.regressions).toContain('semantic-match')
    })
  })

  describe('BenchmarkComparison', () => {
    it('classifies scorers into improved / regressed / unchanged', () => {
      const comparison: BenchmarkComparison = {
        improved: ['scorer-a'],
        regressed: ['scorer-b'],
        unchanged: ['scorer-c', 'scorer-d'],
      }

      expect(comparison.improved).toContain('scorer-a')
      expect(comparison.regressed).toContain('scorer-b')
      expect(comparison.unchanged).toHaveLength(2)
    })
  })

  describe('BenchmarkRunRecord', () => {
    it('can be constructed with required fields', () => {
      const result: BenchmarkResult = {
        suiteId: 'bench-1',
        timestamp: '2026-04-26T00:00:00.000Z',
        scores: {},
        passedBaseline: true,
        regressions: [],
      }

      const record: BenchmarkRunRecord = {
        id: 'brun-1',
        suiteId: 'bench-1',
        targetId: 'claude-haiku',
        result,
        createdAt: '2026-04-26T00:00:00.000Z',
        strict: false,
      }

      expect(record.id).toBe('brun-1')
      expect(record.strict).toBe(false)
      expect(record.metadata).toBeUndefined()
      expect(record.artifact).toBeUndefined()
    })
  })
})
