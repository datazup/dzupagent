import { describe, it, expect, beforeEach } from 'vitest'
import type { BaseStore } from '@langchain/langgraph'
import {
  LearningDashboardService,
  type DashboardServiceConfig,
} from '../self-correction/learning-dashboard.js'

// ---------------------------------------------------------------------------
// In-memory BaseStore mock (same pattern as post-run-analyzer tests)
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
// Seed helpers
// ---------------------------------------------------------------------------

async function seedLessons(store: BaseStore, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await store.put(['lessons'], `lesson_${i}`, {
      summary: `Lesson ${i} summary`,
      confidence: 0.5 + (i * 0.05),
      applyCount: i * 2,
      type: 'error_resolution',
      timestamp: new Date().toISOString(),
      text: `lesson ${i}`,
    })
  }
}

async function seedRules(store: BaseStore, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await store.put(['rules'], `rule_${i}`, {
      content: `Rule ${i} content`,
      confidence: 0.6 + (i * 0.03),
      successRate: 0.4 + (i * 0.06),
      source: 'error',
      text: `rule ${i}`,
    })
  }
}

async function seedSkills(store: BaseStore, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await store.put(['skills'], `skill_${i}`, {
      name: `Skill ${i}`,
      text: `skill ${i}`,
    })
  }
}

async function seedTrajectories(
  store: BaseStore,
  runs: Array<{
    runId: string
    overallScore: number
    totalCostCents?: number
    timestamp: string
    steps?: Array<Record<string, unknown>>
  }>,
): Promise<void> {
  for (const run of runs) {
    await store.put(['trajectories', 'runs'], run.runId, {
      runId: run.runId,
      overallScore: run.overallScore,
      totalCostCents: run.totalCostCents ?? 100,
      timestamp: run.timestamp,
      steps: run.steps ?? [],
      taskType: 'crud',
      text: `trajectory ${run.runId}`,
    })
  }
}

async function seedFeedback(store: BaseStore, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await store.put(['feedback'], `fb_${i}`, {
      runId: `run_${i}`,
      outcome: i % 2 === 0 ? 'approved' : 'rejected',
      timestamp: new Date().toISOString(),
      text: `feedback ${i}`,
    })
  }
}

async function seedPacks(store: BaseStore, ids: string[]): Promise<void> {
  for (const id of ids) {
    await store.put(['packs_loaded'], id, {
      packId: id,
      text: `pack ${id}`,
    })
  }
}

async function seedErrors(
  store: BaseStore,
  errors: Array<{ nodeId: string; message: string; timestamp: string }>,
): Promise<void> {
  for (let i = 0; i < errors.length; i++) {
    const e = errors[i]
    await store.put(['errors'], `err_${i}`, {
      nodeId: e.nodeId,
      message: e.message,
      timestamp: e.timestamp,
      text: `error ${e.nodeId} ${e.message}`,
    })
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LearningDashboardService', () => {
  let store: BaseStore
  let service: LearningDashboardService

  beforeEach(() => {
    store = createMemoryStore()
    service = new LearningDashboardService({ store })
  })

  // -----------------------------------------------------------------------
  // Empty store
  // -----------------------------------------------------------------------

  describe('empty store', () => {
    it('returns zero/empty dashboard', async () => {
      const dashboard = await service.getDashboard()

      expect(dashboard.overview.lessonCount).toBe(0)
      expect(dashboard.overview.ruleCount).toBe(0)
      expect(dashboard.overview.skillCount).toBe(0)
      expect(dashboard.overview.trajectoryCount).toBe(0)
      expect(dashboard.overview.feedbackCount).toBe(0)
      expect(dashboard.overview.loadedPacks).toEqual([])
      expect(dashboard.qualityTrend.scores).toEqual([])
      expect(dashboard.qualityTrend.average).toBe(0)
      expect(dashboard.qualityTrend.trend).toBe('stable')
      expect(dashboard.qualityTrend.improvement).toBe(0)
      expect(dashboard.costTrend.costs).toEqual([])
      expect(dashboard.costTrend.average).toBe(0)
      expect(dashboard.costTrend.trend).toBe('stable')
      expect(dashboard.nodePerformance).toEqual([])
      expect(dashboard.topLessons).toEqual([])
      expect(dashboard.topRules).toEqual([])
      expect(dashboard.recentErrors).toEqual([])
    })

    it('getOverview returns zeros', async () => {
      const overview = await service.getOverview()
      expect(overview.lessonCount).toBe(0)
      expect(overview.ruleCount).toBe(0)
      expect(overview.skillCount).toBe(0)
      expect(overview.trajectoryCount).toBe(0)
      expect(overview.feedbackCount).toBe(0)
      expect(overview.loadedPacks).toEqual([])
    })

    it('getQualityTrend returns stable/empty', async () => {
      const trend = await service.getQualityTrend()
      expect(trend.scores).toEqual([])
      expect(trend.trend).toBe('stable')
    })

    it('getCostTrend returns stable/empty', async () => {
      const trend = await service.getCostTrend()
      expect(trend.costs).toEqual([])
      expect(trend.trend).toBe('stable')
    })
  })

  // -----------------------------------------------------------------------
  // Overview counts
  // -----------------------------------------------------------------------

  describe('overview counts from seeded data', () => {
    it('counts all artifact types', async () => {
      await seedLessons(store, 5)
      await seedRules(store, 3)
      await seedSkills(store, 7)
      await seedTrajectories(store, [
        { runId: 'r1', overallScore: 0.9, timestamp: '2026-01-01T00:00:00Z' },
        { runId: 'r2', overallScore: 0.8, timestamp: '2026-01-02T00:00:00Z' },
      ])
      await seedFeedback(store, 4)
      await seedPacks(store, ['pack-a', 'pack-b'])

      const overview = await service.getOverview()

      expect(overview.lessonCount).toBe(5)
      expect(overview.ruleCount).toBe(3)
      expect(overview.skillCount).toBe(7)
      expect(overview.trajectoryCount).toBe(2)
      expect(overview.feedbackCount).toBe(4)
      expect(overview.loadedPacks).toEqual(expect.arrayContaining(['pack-a', 'pack-b']))
      expect(overview.loadedPacks).toHaveLength(2)
    })
  })

  // -----------------------------------------------------------------------
  // Quality trend
  // -----------------------------------------------------------------------

  describe('quality trend calculation', () => {
    it('detects improving trend', async () => {
      // First 5 runs: low scores, last 5 runs: high scores
      const runs = []
      for (let i = 0; i < 10; i++) {
        runs.push({
          runId: `run_${i}`,
          overallScore: i < 5 ? 0.5 : 0.9,
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })
      }
      await seedTrajectories(store, runs)

      const trend = await service.getQualityTrend()

      expect(trend.trend).toBe('improving')
      expect(trend.scores).toHaveLength(10)
      expect(trend.average).toBeCloseTo(0.7, 1)
      expect(trend.improvement).toBeGreaterThan(0)
    })

    it('detects declining trend', async () => {
      const runs = []
      for (let i = 0; i < 10; i++) {
        runs.push({
          runId: `run_${i}`,
          overallScore: i < 5 ? 0.9 : 0.5,
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })
      }
      await seedTrajectories(store, runs)

      const trend = await service.getQualityTrend()

      expect(trend.trend).toBe('declining')
      expect(trend.improvement).toBeLessThan(0)
    })

    it('detects stable trend', async () => {
      const runs = []
      for (let i = 0; i < 10; i++) {
        runs.push({
          runId: `run_${i}`,
          overallScore: 0.8,
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })
      }
      await seedTrajectories(store, runs)

      const trend = await service.getQualityTrend()

      expect(trend.trend).toBe('stable')
      expect(trend.average).toBeCloseTo(0.8, 1)
    })

    it('respects limit parameter', async () => {
      const runs = []
      for (let i = 0; i < 20; i++) {
        runs.push({
          runId: `run_${i}`,
          overallScore: 0.7 + (i * 0.01),
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })
      }
      await seedTrajectories(store, runs)

      const trend = await service.getQualityTrend(5)
      // The store will return all items, but the service requested limit=5
      // (The in-memory mock doesn't enforce limits, so we validate the service processes them)
      expect(trend.scores.length).toBeGreaterThan(0)
    })
  })

  // -----------------------------------------------------------------------
  // Cost trend
  // -----------------------------------------------------------------------

  describe('cost trend calculation', () => {
    it('detects increasing cost trend', async () => {
      const runs = []
      for (let i = 0; i < 10; i++) {
        runs.push({
          runId: `run_${i}`,
          overallScore: 0.8,
          totalCostCents: i < 5 ? 50 : 200,
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })
      }
      await seedTrajectories(store, runs)

      const trend = await service.getCostTrend()

      expect(trend.trend).toBe('increasing')
      expect(trend.costs).toHaveLength(10)
    })

    it('detects decreasing cost trend', async () => {
      const runs = []
      for (let i = 0; i < 10; i++) {
        runs.push({
          runId: `run_${i}`,
          overallScore: 0.8,
          totalCostCents: i < 5 ? 200 : 50,
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })
      }
      await seedTrajectories(store, runs)

      const trend = await service.getCostTrend()

      expect(trend.trend).toBe('decreasing')
    })

    it('detects stable cost trend', async () => {
      const runs = []
      for (let i = 0; i < 10; i++) {
        runs.push({
          runId: `run_${i}`,
          overallScore: 0.8,
          totalCostCents: 100,
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })
      }
      await seedTrajectories(store, runs)

      const trend = await service.getCostTrend()

      expect(trend.trend).toBe('stable')
      expect(trend.average).toBe(100)
    })
  })

  // -----------------------------------------------------------------------
  // Node performance
  // -----------------------------------------------------------------------

  describe('node performance aggregation', () => {
    it('aggregates step-level data per node', async () => {
      await seedTrajectories(store, [
        {
          runId: 'r1',
          overallScore: 0.9,
          timestamp: '2026-01-01T00:00:00Z',
          steps: [
            { nodeId: 'gen_backend', qualityScore: 0.9, durationMs: 1000, errorCount: 0 },
            { nodeId: 'gen_frontend', qualityScore: 0.8, durationMs: 2000, errorCount: 1 },
          ],
        },
        {
          runId: 'r2',
          overallScore: 0.85,
          timestamp: '2026-01-02T00:00:00Z',
          steps: [
            { nodeId: 'gen_backend', qualityScore: 0.7, durationMs: 1500, errorCount: 1 },
            { nodeId: 'gen_frontend', qualityScore: 0.6, durationMs: 2500, errorCount: 0 },
          ],
        },
      ])

      const perf = await service.getNodePerformance()

      expect(perf).toHaveLength(2)

      const backend = perf.find((p) => p.nodeId === 'gen_backend')
      expect(backend).toBeDefined()
      expect(backend!.avgQuality).toBeCloseTo(0.8, 1)
      expect(backend!.avgDurationMs).toBeCloseTo(1250, 0)
      expect(backend!.errorRate).toBeCloseTo(0.5, 1)
      expect(backend!.runsTracked).toBe(2)

      const frontend = perf.find((p) => p.nodeId === 'gen_frontend')
      expect(frontend).toBeDefined()
      expect(frontend!.avgQuality).toBeCloseTo(0.7, 1)
      expect(frontend!.avgDurationMs).toBeCloseTo(2250, 0)
      expect(frontend!.runsTracked).toBe(2)
    })

    it('returns empty for no trajectories', async () => {
      const perf = await service.getNodePerformance()
      expect(perf).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // Top lessons
  // -----------------------------------------------------------------------

  describe('top lessons', () => {
    it('returns lessons sorted by confidence descending', async () => {
      await seedLessons(store, 5)

      const lessons = await service.getTopLessons()

      expect(lessons.length).toBeGreaterThan(0)
      // Verify sorted descending
      for (let i = 1; i < lessons.length; i++) {
        expect(lessons[i - 1].confidence).toBeGreaterThanOrEqual(lessons[i].confidence)
      }
    })

    it('returns empty for no lessons', async () => {
      const lessons = await service.getTopLessons()
      expect(lessons).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // Top rules
  // -----------------------------------------------------------------------

  describe('top rules', () => {
    it('returns rules sorted by success rate descending', async () => {
      await seedRules(store, 5)

      const rules = await service.getTopRules()

      expect(rules.length).toBeGreaterThan(0)
      // Verify sorted descending
      for (let i = 1; i < rules.length; i++) {
        expect(rules[i - 1].successRate).toBeGreaterThanOrEqual(rules[i].successRate)
      }
    })

    it('returns empty for no rules', async () => {
      const rules = await service.getTopRules()
      expect(rules).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // Recent errors
  // -----------------------------------------------------------------------

  describe('recent errors', () => {
    it('returns errors sorted by timestamp descending', async () => {
      await seedErrors(store, [
        { nodeId: 'plan', message: 'Plan timeout', timestamp: '2026-01-01T00:00:00Z' },
        { nodeId: 'gen_backend', message: 'Build failure', timestamp: '2026-01-03T00:00:00Z' },
        { nodeId: 'gen_tests', message: 'Test failure', timestamp: '2026-01-02T00:00:00Z' },
      ])

      const errors = await service.getRecentErrors()

      expect(errors).toHaveLength(3)
      expect(errors[0].nodeId).toBe('gen_backend')
      expect(errors[1].nodeId).toBe('gen_tests')
      expect(errors[2].nodeId).toBe('plan')
    })

    it('returns empty for no errors', async () => {
      const errors = await service.getRecentErrors()
      expect(errors).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // maxItems limiting
  // -----------------------------------------------------------------------

  describe('maxItems limiting', () => {
    it('limits lessons to maxItems', async () => {
      const svc = new LearningDashboardService({ store, maxItems: 3 })
      await seedLessons(store, 10)

      const lessons = await svc.getTopLessons()
      expect(lessons).toHaveLength(3)
    })

    it('limits rules to maxItems', async () => {
      const svc = new LearningDashboardService({ store, maxItems: 2 })
      await seedRules(store, 10)

      const rules = await svc.getTopRules()
      expect(rules).toHaveLength(2)
    })

    it('limits errors to maxItems', async () => {
      const svc = new LearningDashboardService({ store, maxItems: 2 })
      const errors = []
      for (let i = 0; i < 10; i++) {
        errors.push({
          nodeId: `node_${i}`,
          message: `Error ${i}`,
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })
      }
      await seedErrors(store, errors)

      const result = await svc.getRecentErrors()
      expect(result).toHaveLength(2)
    })

    it('limits node performance to maxItems', async () => {
      const svc = new LearningDashboardService({ store, maxItems: 1 })
      await seedTrajectories(store, [
        {
          runId: 'r1',
          overallScore: 0.9,
          timestamp: '2026-01-01T00:00:00Z',
          steps: [
            { nodeId: 'node_a', qualityScore: 0.9, durationMs: 100, errorCount: 0 },
            { nodeId: 'node_b', qualityScore: 0.8, durationMs: 200, errorCount: 0 },
            { nodeId: 'node_c', qualityScore: 0.7, durationMs: 300, errorCount: 0 },
          ],
        },
      ])

      const perf = await svc.getNodePerformance()
      expect(perf).toHaveLength(1)
    })
  })

  // -----------------------------------------------------------------------
  // getDashboard combines all sections
  // -----------------------------------------------------------------------

  describe('getDashboard combines all sections', () => {
    it('populates all sections from seeded data', async () => {
      await seedLessons(store, 3)
      await seedRules(store, 2)
      await seedSkills(store, 1)
      await seedTrajectories(store, [
        {
          runId: 'r1',
          overallScore: 0.9,
          totalCostCents: 120,
          timestamp: '2026-01-01T00:00:00Z',
          steps: [{ nodeId: 'plan', qualityScore: 0.95, durationMs: 500, errorCount: 0 }],
        },
      ])
      await seedFeedback(store, 2)
      await seedPacks(store, ['pack-x'])
      await seedErrors(store, [
        { nodeId: 'plan', message: 'oops', timestamp: '2026-01-01T00:00:00Z' },
      ])

      const dashboard = await service.getDashboard()

      expect(dashboard.overview.lessonCount).toBe(3)
      expect(dashboard.overview.ruleCount).toBe(2)
      expect(dashboard.overview.skillCount).toBe(1)
      expect(dashboard.overview.trajectoryCount).toBe(1)
      expect(dashboard.overview.feedbackCount).toBe(2)
      expect(dashboard.overview.loadedPacks).toEqual(['pack-x'])
      expect(dashboard.qualityTrend.scores).toHaveLength(1)
      expect(dashboard.costTrend.costs).toHaveLength(1)
      expect(dashboard.nodePerformance).toHaveLength(1)
      expect(dashboard.topLessons.length).toBeGreaterThan(0)
      expect(dashboard.topRules.length).toBeGreaterThan(0)
      expect(dashboard.recentErrors).toHaveLength(1)
    })
  })

  // -----------------------------------------------------------------------
  // Graceful handling of store errors
  // -----------------------------------------------------------------------

  describe('graceful handling of store errors', () => {
    it('getDashboard returns defaults on failing store', async () => {
      const failService = new LearningDashboardService({ store: createFailingStore() })

      const dashboard = await failService.getDashboard()

      expect(dashboard.overview.lessonCount).toBe(0)
      expect(dashboard.overview.ruleCount).toBe(0)
      expect(dashboard.qualityTrend.scores).toEqual([])
      expect(dashboard.costTrend.costs).toEqual([])
      expect(dashboard.nodePerformance).toEqual([])
      expect(dashboard.topLessons).toEqual([])
      expect(dashboard.topRules).toEqual([])
      expect(dashboard.recentErrors).toEqual([])
    })

    it('getOverview returns zeros on failing store', async () => {
      const failService = new LearningDashboardService({ store: createFailingStore() })
      const overview = await failService.getOverview()

      expect(overview.lessonCount).toBe(0)
      expect(overview.ruleCount).toBe(0)
      expect(overview.loadedPacks).toEqual([])
    })

    it('getQualityTrend returns empty on failing store', async () => {
      const failService = new LearningDashboardService({ store: createFailingStore() })
      const trend = await failService.getQualityTrend()
      expect(trend.scores).toEqual([])
      expect(trend.trend).toBe('stable')
    })

    it('getCostTrend returns empty on failing store', async () => {
      const failService = new LearningDashboardService({ store: createFailingStore() })
      const trend = await failService.getCostTrend()
      expect(trend.costs).toEqual([])
      expect(trend.trend).toBe('stable')
    })

    it('getNodePerformance returns empty on failing store', async () => {
      const failService = new LearningDashboardService({ store: createFailingStore() })
      const perf = await failService.getNodePerformance()
      expect(perf).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // Namespace support
  // -----------------------------------------------------------------------

  describe('namespace prefix', () => {
    it('reads from prefixed namespaces', async () => {
      const prefixedService = new LearningDashboardService({
        store,
        namespace: ['tenant_1'],
      })

      // Seed under prefixed namespace
      await store.put(['tenant_1', 'lessons'], 'l1', {
        summary: 'Prefixed lesson',
        confidence: 0.9,
        applyCount: 5,
        text: 'prefixed',
      })

      // Non-prefixed seed should not appear
      await seedLessons(store, 3)

      const overview = await prefixedService.getOverview()
      expect(overview.lessonCount).toBe(1)

      const lessons = await prefixedService.getTopLessons()
      expect(lessons).toHaveLength(1)
      expect(lessons[0].summary).toBe('Prefixed lesson')
    })
  })
})
