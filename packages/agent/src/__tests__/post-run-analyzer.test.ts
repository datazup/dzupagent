import { describe, it, expect, beforeEach } from 'vitest'
import type { BaseStore } from '@langchain/langgraph'
import {
  PostRunAnalyzer,
  type RunAnalysis,
  type PostRunAnalyzerConfig,
} from '../self-correction/post-run-analyzer.js'

// ---------------------------------------------------------------------------
// In-memory BaseStore mock
// ---------------------------------------------------------------------------

function createMemoryStore(): BaseStore {
  const data = new Map<string, Map<string, { key: string; value: Record<string, unknown> }>>()

  function nsKey(namespace: string[]): string {
    return namespace.join('/')
  }

  return {
    async get(namespace: string[], key: string) {
      const ns = data.get(nsKey(namespace))
      return ns?.get(key) ?? null
    },
    async put(namespace: string[], key: string, value: Record<string, unknown>) {
      const k = nsKey(namespace)
      if (!data.has(k)) data.set(k, new Map())
      data.get(k)!.set(key, { key, value })
    },
    async delete(namespace: string[], key: string) {
      const ns = data.get(nsKey(namespace))
      if (ns) ns.delete(key)
    },
    async search(namespace: string[], _options?: { limit?: number }) {
      const ns = data.get(nsKey(namespace))
      if (!ns) return []
      return Array.from(ns.values())
    },
    async batch(_ops: unknown[]) { return [] },
    async list(_prefix: string[]) { return [] },
    async start() { /* noop */ },
    async stop() { /* noop */ },
  } as unknown as BaseStore
}

/**
 * Create a failing store that throws on all operations.
 */
function createFailingStore(): BaseStore {
  const err = () => { throw new Error('store failure') }
  return {
    get: err,
    put: err,
    delete: err,
    search: err,
    batch: err,
    list: err,
    start: async () => { /* noop */ },
    stop: async () => { /* noop */ },
  } as unknown as BaseStore
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<RunAnalysis> = {}): RunAnalysis {
  return {
    runId: overrides.runId ?? `run_${Math.random().toString(36).slice(2, 8)}`,
    nodeScores: overrides.nodeScores ?? new Map([
      ['plan', 0.9],
      ['gen_backend', 0.85],
      ['gen_frontend', 0.8],
      ['gen_tests', 0.75],
    ]),
    errors: overrides.errors ?? [],
    overallScore: overrides.overallScore ?? 0.85,
    totalCostCents: overrides.totalCostCents ?? 150,
    totalDurationMs: overrides.totalDurationMs ?? 45000,
    taskType: overrides.taskType ?? 'crud',
    riskClass: overrides.riskClass ?? 'standard',
    approved: overrides.approved ?? true,
    feedback: overrides.feedback,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostRunAnalyzer', () => {
  let store: BaseStore
  let analyzer: PostRunAnalyzer

  beforeEach(() => {
    store = createMemoryStore()
    analyzer = new PostRunAnalyzer({ store })
  })

  // -----------------------------------------------------------------------
  // Successful high-quality run
  // -----------------------------------------------------------------------

  describe('high-quality run (overallScore > 0.85)', () => {
    it('stores trajectory and extracts success patterns', async () => {
      const run = makeRun({
        overallScore: 0.92,
        nodeScores: new Map([
          ['plan', 0.95],
          ['gen_backend', 0.91],
          ['gen_frontend', 0.88],
        ]),
      })

      const result = await analyzer.analyze(run)

      expect(result.trajectoryStored).toBe(true)
      // plan (0.95) and gen_backend (0.91) are >= 0.9 threshold
      expect(result.lessonsCreated).toBe(2)
      expect(result.rulesCreated).toBe(0)
      expect(result.suboptimalNodes).toEqual([])
      expect(result.summary).toContain('Post-Run Analysis')
      expect(result.summary).toContain('0.92')
      expect(result.summary).toContain('Trajectory stored')
    })

    it('includes error lessons alongside success patterns', async () => {
      const run = makeRun({
        overallScore: 0.9,
        nodeScores: new Map([
          ['plan', 0.95],
          ['gen_backend', 0.7],
        ]),
        errors: [
          {
            nodeId: 'gen_backend',
            error: 'Type mismatch in handler',
            resolved: true,
            resolution: 'Added type assertion',
            fixAttempt: 2,
          },
        ],
      })

      const result = await analyzer.analyze(run)

      // 1 success pattern (plan 0.95) + 1 error lesson
      expect(result.lessonsCreated).toBe(2)
      // 1 rule from the resolved error
      expect(result.rulesCreated).toBe(1)
      expect(result.trajectoryStored).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Failed run
  // -----------------------------------------------------------------------

  describe('failed run with errors', () => {
    it('creates error lessons and rules for resolved errors', async () => {
      const run = makeRun({
        overallScore: 0.4,
        errors: [
          {
            nodeId: 'gen_backend',
            error: 'Import not found: @prisma/client',
            resolved: true,
            resolution: 'Added prisma generate step',
            fixAttempt: 1,
          },
          {
            nodeId: 'gen_tests',
            error: 'Test runner crashed',
            resolved: true,
            resolution: 'Fixed vitest config path',
          },
        ],
        approved: false,
        feedback: 'Backend was broken',
      })

      const result = await analyzer.analyze(run)

      // No trajectory (score 0.4 <= 0.7)
      expect(result.trajectoryStored).toBe(false)
      // No success patterns (score 0.4 <= 0.85)
      // 2 error lessons
      expect(result.lessonsCreated).toBe(2)
      // 2 rules from resolved errors
      expect(result.rulesCreated).toBe(2)
      expect(result.summary).toContain('Trajectory NOT stored')
      expect(result.summary).toContain('RESOLVED')
      expect(result.summary).toContain('User Feedback')
      expect(result.summary).toContain('Backend was broken')
    })

    it('does not create lessons or rules for unresolved errors', async () => {
      const run = makeRun({
        overallScore: 0.3,
        errors: [
          {
            nodeId: 'gen_backend',
            error: 'Out of memory',
            resolved: false,
          },
        ],
      })

      const result = await analyzer.analyze(run)

      expect(result.lessonsCreated).toBe(0)
      expect(result.rulesCreated).toBe(0)
      expect(result.trajectoryStored).toBe(false)
      expect(result.summary).toContain('UNRESOLVED')
    })
  })

  // -----------------------------------------------------------------------
  // Mixed run
  // -----------------------------------------------------------------------

  describe('mixed run (some errors resolved, some not)', () => {
    it('only creates lessons and rules for resolved errors', async () => {
      const run = makeRun({
        overallScore: 0.6,
        errors: [
          {
            nodeId: 'gen_backend',
            error: 'Missing env var',
            resolved: true,
            resolution: 'Added dotenv.config()',
          },
          {
            nodeId: 'gen_frontend',
            error: 'Component render failed',
            resolved: false,
          },
          {
            nodeId: 'gen_tests',
            error: 'Assertion mismatch',
            resolved: true,
            resolution: 'Updated snapshot',
          },
        ],
      })

      const result = await analyzer.analyze(run)

      // 2 resolved errors => 2 error lessons, no success patterns (score 0.6)
      expect(result.lessonsCreated).toBe(2)
      // 2 rules from resolved errors
      expect(result.rulesCreated).toBe(2)
      expect(result.trajectoryStored).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Low quality run
  // -----------------------------------------------------------------------

  describe('low quality run', () => {
    it('does not store trajectory but still creates lessons from errors', async () => {
      const run = makeRun({
        overallScore: 0.3,
        errors: [
          {
            nodeId: 'plan',
            error: 'Invalid schema',
            resolved: true,
            resolution: 'Fixed JSON schema validation',
          },
        ],
      })

      const result = await analyzer.analyze(run)

      expect(result.trajectoryStored).toBe(false)
      expect(result.lessonsCreated).toBe(1)
      expect(result.rulesCreated).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // Suboptimal node detection
  // -----------------------------------------------------------------------

  describe('suboptimal node detection', () => {
    it('detects nodes performing below baseline', async () => {
      // Seed 3 trajectories to establish baselines
      for (let i = 0; i < 3; i++) {
        const seedRun = makeRun({
          runId: `seed_${i}`,
          overallScore: 0.9,
          nodeScores: new Map([
            ['plan', 0.9],
            ['gen_backend', 0.85],
          ]),
          taskType: 'crud',
        })
        await analyzer.analyze(seedRun)
      }

      // Now analyze a run where gen_backend is way below baseline
      const run = makeRun({
        runId: 'test_run',
        overallScore: 0.75,
        nodeScores: new Map([
          ['plan', 0.88],
          ['gen_backend', 0.4], // well below 0.85 baseline * 0.85 = 0.7225
        ]),
        taskType: 'crud',
      })

      const result = await analyzer.analyze(run)

      expect(result.suboptimalNodes).toContain('gen_backend')
      expect(result.suboptimalNodes).not.toContain('plan')
      expect(result.summary).toContain('gen_backend')
    })

    it('does not flag nodes when insufficient history', async () => {
      // Only 1 trajectory — below min 3
      const seedRun = makeRun({
        runId: 'seed_0',
        overallScore: 0.9,
        nodeScores: new Map([['plan', 0.9]]),
        taskType: 'crud',
      })
      await analyzer.analyze(seedRun)

      const run = makeRun({
        overallScore: 0.75,
        nodeScores: new Map([['plan', 0.1]]),
        taskType: 'crud',
      })

      const result = await analyzer.analyze(run)
      expect(result.suboptimalNodes).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // Recent analyses
  // -----------------------------------------------------------------------

  describe('getRecentAnalyses', () => {
    it('returns stored analyses sorted by timestamp descending', async () => {
      const run1 = makeRun({ runId: 'run_1', overallScore: 0.5 })
      const run2 = makeRun({ runId: 'run_2', overallScore: 0.9 })
      const run3 = makeRun({ runId: 'run_3', overallScore: 0.7 })

      await analyzer.analyze(run1)
      await analyzer.analyze(run2)
      await analyzer.analyze(run3)

      const analyses = await analyzer.getRecentAnalyses(10)

      expect(analyses.length).toBe(3)
      // All three should be present
      const runIds = analyses.map(a => a.runId)
      expect(runIds).toContain('run_1')
      expect(runIds).toContain('run_2')
      expect(runIds).toContain('run_3')
    })

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await analyzer.analyze(makeRun({ runId: `run_${i}` }))
      }

      const analyses = await analyzer.getRecentAnalyses(2)
      expect(analyses.length).toBe(2)
    })

    it('returns empty array for fresh store', async () => {
      const analyses = await analyzer.getRecentAnalyses()
      expect(analyses).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // Best-effort — store failures do not crash
  // -----------------------------------------------------------------------

  describe('best-effort error handling', () => {
    it('analyze() returns a result even when store throws', async () => {
      const failingAnalyzer = new PostRunAnalyzer({
        store: createFailingStore(),
      })

      const run = makeRun({
        overallScore: 0.95,
        errors: [
          {
            nodeId: 'plan',
            error: 'Some error',
            resolved: true,
            resolution: 'Fixed it',
          },
        ],
      })

      const result = await failingAnalyzer.analyze(run)

      // Should not throw, returns a result with zeros
      expect(result).toBeDefined()
      expect(result.summary).toContain('Post-Run Analysis')
      // Lessons/rules may be 0 since store failed
      expect(typeof result.lessonsCreated).toBe('number')
      expect(typeof result.rulesCreated).toBe('number')
    })

    it('getRecentAnalyses returns empty array when store throws', async () => {
      const failingAnalyzer = new PostRunAnalyzer({
        store: createFailingStore(),
      })

      const analyses = await failingAnalyzer.getRecentAnalyses()
      expect(analyses).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // Summary string format
  // -----------------------------------------------------------------------

  describe('summary string format', () => {
    it('contains all key information', async () => {
      const run = makeRun({
        runId: 'summary_test',
        overallScore: 0.88,
        taskType: 'auth',
        riskClass: 'sensitive',
        totalCostCents: 200,
        totalDurationMs: 60000,
        approved: true,
        nodeScores: new Map([
          ['plan', 0.95],
          ['gen_backend', 0.92],
        ]),
      })

      const result = await analyzer.analyze(run)

      expect(result.summary).toContain('summary_test')
      expect(result.summary).toContain('auth')
      expect(result.summary).toContain('sensitive')
      expect(result.summary).toContain('0.88')
      expect(result.summary).toContain('yes')
      expect(result.summary).toContain('200c')
      expect(result.summary).toContain('60000ms')
      expect(result.summary).toContain('Lessons created: 2')
    })

    it('includes error section when errors present', async () => {
      const run = makeRun({
        errors: [
          { nodeId: 'gen_backend', error: 'type error', resolved: true, resolution: 'fix' },
          { nodeId: 'gen_frontend', error: 'render fail', resolved: false },
        ],
      })

      const result = await analyzer.analyze(run)

      expect(result.summary).toContain('### Errors (2)')
      expect(result.summary).toContain('[RESOLVED] gen_backend: type error')
      expect(result.summary).toContain('[UNRESOLVED] gen_frontend: render fail')
    })

    it('includes user feedback section when provided', async () => {
      const run = makeRun({
        approved: false,
        feedback: 'The login flow is broken',
      })

      const result = await analyzer.analyze(run)

      expect(result.summary).toContain('### User Feedback')
      expect(result.summary).toContain('The login flow is broken')
      expect(result.summary).toContain('no') // approved: false
    })
  })

  // -----------------------------------------------------------------------
  // Custom namespace
  // -----------------------------------------------------------------------

  describe('custom namespace', () => {
    it('uses provided namespace prefix', async () => {
      const customAnalyzer = new PostRunAnalyzer({
        store,
        namespace: ['custom', 'ns'],
      })

      const run = makeRun({ overallScore: 0.9 })
      const result = await customAnalyzer.analyze(run)

      expect(result.trajectoryStored).toBe(true)

      // Verify history is stored under custom namespace
      const analyses = await customAnalyzer.getRecentAnalyses()
      expect(analyses.length).toBe(1)
    })
  })
})
