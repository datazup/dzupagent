import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { MemoryServiceLike } from '@dzupagent/memory-ipc'
import { createLearningRoutes } from '../routes/learning.js'

/**
 * Minimal in-memory MemoryServiceLike for testing learning routes.
 */
function createMockMemoryService(): MemoryServiceLike {
  const store = new Map<string, Record<string, unknown>[]>()

  function storeKey(ns: string, scope: Record<string, string>): string {
    const sorted = Object.entries(scope).sort(([a], [b]) => a.localeCompare(b))
    return `${ns}:${JSON.stringify(sorted)}`
  }

  return {
    async get(
      namespace: string,
      scope: Record<string, string>,
      key?: string,
    ): Promise<Record<string, unknown>[]> {
      const sk = storeKey(namespace, scope)
      const records = store.get(sk) ?? []
      if (key) return records.filter((r) => r['key'] === key)
      return records
    },
    async search(
      namespace: string,
      scope: Record<string, string>,
      _query: string,
      limit?: number,
    ): Promise<Record<string, unknown>[]> {
      const sk = storeKey(namespace, scope)
      const records = store.get(sk) ?? []
      return records.slice(0, limit ?? 100)
    },
    async put(
      namespace: string,
      scope: Record<string, string>,
      key: string,
      value: Record<string, unknown>,
    ): Promise<void> {
      const sk = storeKey(namespace, scope)
      const records = store.get(sk) ?? []
      const idx = records.findIndex((r) => r['key'] === key)
      const record = { ...value, key }
      if (idx >= 0) {
        records[idx] = record
      } else {
        records.push(record)
      }
      store.set(sk, records)
    },
  }
}

/**
 * Create a failing mock that throws on every call.
 */
function createFailingMemoryService(): MemoryServiceLike {
  const fail = () => {
    throw new Error('Store connection failed')
  }
  return {
    get: fail as MemoryServiceLike['get'],
    search: fail as MemoryServiceLike['search'],
    put: fail as MemoryServiceLike['put'],
  }
}

function createTestApp(memoryService: MemoryServiceLike): Hono {
  const app = new Hono()
  app.route('/api/learning', createLearningRoutes({ memoryService, defaultTenantId: 'test-tenant' }))
  return app
}

describe('Learning routes', () => {
  let memoryService: MemoryServiceLike
  let app: Hono

  beforeEach(async () => {
    memoryService = createMockMemoryService()
    app = createTestApp(memoryService)
  })

  // ── Seed helpers ──────────────────────────────────────────────
  const scope = { tenantId: 'test-tenant' }

  async function seedLessons() {
    await memoryService.put('lessons', scope, 'lesson-1', {
      text: 'Always validate inputs',
      importance: 0.9,
      nodeId: 'generate',
      taskType: 'backend',
    })
    await memoryService.put('lessons', scope, 'lesson-2', {
      text: 'Use parameterized queries',
      importance: 0.7,
      nodeId: 'validate',
      taskType: 'security',
    })
    await memoryService.put('lessons', scope, 'lesson-3', {
      text: 'Keep components small',
      importance: 0.8,
      nodeId: 'generate',
      taskType: 'frontend',
    })
  }

  async function seedRules() {
    await memoryService.put('rules', scope, 'rule-1', {
      text: 'Never use eval()',
      priority: 10,
    })
    await memoryService.put('rules', scope, 'rule-2', {
      text: 'Always add error handling',
      priority: 5,
    })
  }

  async function seedTrajectories() {
    await memoryService.put('trajectories', scope, 'traj-1', {
      nodeId: 'generate',
      qualityScore: 8.5,
      costCents: 1.2,
      timestamp: '2026-01-01T00:00:00Z',
      runId: 'run-1',
    })
    await memoryService.put('trajectories', scope, 'traj-2', {
      nodeId: 'generate',
      qualityScore: 9.0,
      costCents: 0.8,
      timestamp: '2026-01-02T00:00:00Z',
      runId: 'run-2',
    })
    await memoryService.put('trajectories', scope, 'traj-3', {
      nodeId: 'validate',
      qualityScore: 7.0,
      costCents: 0.3,
      timestamp: '2026-01-03T00:00:00Z',
      runId: 'run-3',
    })
  }

  async function seedFeedback() {
    await memoryService.put('feedback', scope, 'fb-1', {
      runId: 'run-1',
      type: 'quality',
      approved: true,
      timestamp: '2026-01-01T00:00:00Z',
    })
    await memoryService.put('feedback', scope, 'fb-2', {
      runId: 'run-2',
      type: 'quality',
      approved: false,
      timestamp: '2026-01-02T00:00:00Z',
    })
    await memoryService.put('feedback', scope, 'fb-3', {
      runId: 'run-3',
      type: 'correctness',
      approved: true,
      timestamp: '2026-01-03T00:00:00Z',
    })
  }

  async function seedSkillPacks() {
    await memoryService.put('packs_loaded', scope, 'pack-typescript', {
      packId: 'pack-typescript',
      loadedAt: '2026-01-01T00:00:00Z',
    })
  }

  async function seedSkills() {
    await memoryService.put('skills', scope, 'skill-1', {
      name: 'error-handling',
      confidence: 0.85,
    })
  }

  // ── GET /dashboard ────────────────────────────────────────────

  describe('GET /api/learning/dashboard', () => {
    it('returns valid dashboard structure with seeded data', async () => {
      await seedLessons()
      await seedRules()
      await seedTrajectories()
      await seedFeedback()
      await seedSkillPacks()
      await seedSkills()

      const res = await app.request('/api/learning/dashboard')
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        success: boolean
        data: {
          lessonCount: number
          ruleCount: number
          skillCount: number
          trajectoryCount: number
          feedbackCount: number
          packCount: number
          errorCount: number
          lessons: unknown[]
          rules: unknown[]
          skills: unknown[]
          qualityTrend: unknown[]
          costTrend: unknown[]
          feedbackStats: { total: number; approved: number; rejected: number }
        }
      }

      expect(body.success).toBe(true)
      expect(body.data.lessonCount).toBe(3)
      expect(body.data.ruleCount).toBe(2)
      expect(body.data.skillCount).toBe(1)
      expect(body.data.trajectoryCount).toBe(3)
      expect(body.data.feedbackCount).toBe(3)
      expect(body.data.packCount).toBe(1)
      expect(body.data.errorCount).toBe(0)
      expect(body.data.lessons).toHaveLength(3)
      expect(body.data.rules).toHaveLength(2)
      expect(body.data.qualityTrend).toHaveLength(3)
      expect(body.data.costTrend).toHaveLength(3)
      expect(body.data.feedbackStats.approved).toBe(2)
      expect(body.data.feedbackStats.rejected).toBe(1)
    })

    it('returns empty dashboard for empty store', async () => {
      const res = await app.request('/api/learning/dashboard')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { success: boolean; data: { lessonCount: number } }
      expect(body.success).toBe(true)
      expect(body.data.lessonCount).toBe(0)
      expect(body.data).toHaveProperty('ruleCount', 0)
      expect(body.data).toHaveProperty('skillCount', 0)
    })
  })

  // ── GET /overview ─────────────────────────────────────────────

  describe('GET /api/learning/overview', () => {
    it('returns counts', async () => {
      await seedLessons()
      await seedRules()
      await seedSkills()

      const res = await app.request('/api/learning/overview')
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        success: boolean
        data: { lessonCount: number; ruleCount: number; skillCount: number }
      }
      expect(body.success).toBe(true)
      expect(body.data.lessonCount).toBe(3)
      expect(body.data.ruleCount).toBe(2)
      expect(body.data.skillCount).toBe(1)
    })

    it('returns zeros for empty store', async () => {
      const res = await app.request('/api/learning/overview')
      const body = (await res.json()) as {
        success: boolean
        data: { lessonCount: number; ruleCount: number; skillCount: number }
      }
      expect(body.data.lessonCount).toBe(0)
      expect(body.data.ruleCount).toBe(0)
      expect(body.data.skillCount).toBe(0)
    })
  })

  // ── GET /trends/quality ───────────────────────────────────────

  describe('GET /api/learning/trends/quality', () => {
    it('returns quality trend data', async () => {
      await seedTrajectories()

      const res = await app.request('/api/learning/trends/quality')
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        success: boolean
        data: Array<{ timestamp: string | null; score: number | null; nodeId: string | null }>
      }
      expect(body.success).toBe(true)
      expect(body.data).toHaveLength(3)
      // Should be sorted by timestamp ascending
      expect(body.data[0]!.timestamp).toBe('2026-01-01T00:00:00Z')
      expect(body.data[0]!.score).toBe(8.5)
    })

    it('respects limit query parameter', async () => {
      await seedTrajectories()

      const res = await app.request('/api/learning/trends/quality?limit=2')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(2)
    })

    it('returns empty array for no trajectories', async () => {
      const res = await app.request('/api/learning/trends/quality')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(0)
    })
  })

  // ── GET /trends/cost ──────────────────────────────────────────

  describe('GET /api/learning/trends/cost', () => {
    it('returns cost trend data', async () => {
      await seedTrajectories()

      const res = await app.request('/api/learning/trends/cost')
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        success: boolean
        data: Array<{ costCents: number | null }>
      }
      expect(body.success).toBe(true)
      expect(body.data).toHaveLength(3)
      expect(body.data[0]!.costCents).toBe(1.2)
    })

    it('respects limit query parameter', async () => {
      await seedTrajectories()

      const res = await app.request('/api/learning/trends/cost?limit=1')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(1)
    })
  })

  // ── GET /nodes ────────────────────────────────────────────────

  describe('GET /api/learning/nodes', () => {
    it('returns per-node performance summaries', async () => {
      await seedTrajectories()

      const res = await app.request('/api/learning/nodes')
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        success: boolean
        data: Array<{
          nodeId: string
          runCount: number
          avgQualityScore: number | null
          totalCostCents: number
        }>
      }
      expect(body.success).toBe(true)
      expect(body.data).toHaveLength(2) // generate + validate

      const generateNode = body.data.find((n) => n.nodeId === 'generate')
      expect(generateNode).toBeDefined()
      expect(generateNode!.runCount).toBe(2)
      expect(generateNode!.avgQualityScore).toBe(8.75) // (8.5 + 9.0) / 2
      expect(generateNode!.totalCostCents).toBe(2) // 1.2 + 0.8

      const validateNode = body.data.find((n) => n.nodeId === 'validate')
      expect(validateNode).toBeDefined()
      expect(validateNode!.runCount).toBe(1)
    })

    it('returns empty array for no trajectories', async () => {
      const res = await app.request('/api/learning/nodes')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(0)
    })
  })

  // ── POST /feedback ────────────────────────────────────────────

  describe('POST /api/learning/feedback', () => {
    it('records feedback successfully', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: 'run-42',
          type: 'quality',
          approved: true,
          feedback: 'Looks good!',
          featureCategory: 'auth',
        }),
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as { success: boolean; result: { key: string } }
      expect(body.success).toBe(true)
      expect(body.result.key).toContain('feedback-run-42')
    })

    it('returns 400 for missing runId', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { success: boolean; error: string }
      expect(body.success).toBe(false)
      expect(body.error).toContain('runId')
    })

    it('returns 400 for missing approved', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'run-1' }),
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { success: boolean; error: string }
      expect(body.success).toBe(false)
      expect(body.error).toContain('approved')
    })
  })

  // ── GET /feedback/stats ───────────────────────────────────────

  describe('GET /api/learning/feedback/stats', () => {
    it('returns feedback statistics', async () => {
      await seedFeedback()

      const res = await app.request('/api/learning/feedback/stats')
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        success: boolean
        data: {
          total: number
          approved: number
          rejected: number
          approvalRate: number
          byType: Record<string, { approved: number; rejected: number }>
        }
      }
      expect(body.success).toBe(true)
      expect(body.data.total).toBe(3)
      expect(body.data.approved).toBe(2)
      expect(body.data.rejected).toBe(1)
      expect(body.data.approvalRate).toBeCloseTo(66.67, 1)
      expect(body.data.byType['quality']).toEqual({ approved: 1, rejected: 1 })
      expect(body.data.byType['correctness']).toEqual({ approved: 1, rejected: 0 })
    })

    it('returns zero stats for empty store', async () => {
      const res = await app.request('/api/learning/feedback/stats')
      const body = (await res.json()) as {
        success: boolean
        data: { total: number; approvalRate: number }
      }
      expect(body.data.total).toBe(0)
      expect(body.data.approvalRate).toBe(0)
    })
  })

  // ── POST /skill-packs/load ────────────────────────────────────

  describe('POST /api/learning/skill-packs/load', () => {
    it('loads skill packs', async () => {
      const res = await app.request('/api/learning/skill-packs/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packIds: ['pack-typescript', 'pack-react'] }),
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as { success: boolean; result: { loaded: string[] } }
      expect(body.success).toBe(true)
      expect(body.result.loaded).toEqual(['pack-typescript', 'pack-react'])

      // Verify they appear in GET /skill-packs
      const listRes = await app.request('/api/learning/skill-packs')
      const listBody = (await listRes.json()) as { data: string[] }
      expect(listBody.data).toContain('pack-typescript')
      expect(listBody.data).toContain('pack-react')
    })

    it('returns 400 for missing packIds', async () => {
      const res = await app.request('/api/learning/skill-packs/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { success: boolean; error: string }
      expect(body.success).toBe(false)
      expect(body.error).toContain('packIds')
    })

    it('returns 400 for empty packIds array', async () => {
      const res = await app.request('/api/learning/skill-packs/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packIds: [] }),
      })

      expect(res.status).toBe(400)
    })
  })

  // ── GET /skill-packs ─────────────────────────────────────────

  describe('GET /api/learning/skill-packs', () => {
    it('returns loaded skill pack IDs', async () => {
      await seedSkillPacks()

      const res = await app.request('/api/learning/skill-packs')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { success: boolean; data: string[] }
      expect(body.success).toBe(true)
      expect(body.data).toContain('pack-typescript')
    })

    it('returns empty array when no packs loaded', async () => {
      const res = await app.request('/api/learning/skill-packs')
      const body = (await res.json()) as { data: string[] }
      expect(body.data).toHaveLength(0)
    })
  })

  // ── GET /lessons ──────────────────────────────────────────────

  describe('GET /api/learning/lessons', () => {
    it('returns lessons sorted by importance', async () => {
      await seedLessons()

      const res = await app.request('/api/learning/lessons')
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        success: boolean
        data: Array<{ importance: number; key: string }>
      }
      expect(body.success).toBe(true)
      expect(body.data).toHaveLength(3)
      // Should be sorted by importance descending
      expect(body.data[0]!.importance).toBe(0.9)
      expect(body.data[1]!.importance).toBe(0.8)
      expect(body.data[2]!.importance).toBe(0.7)
    })

    it('filters by nodeId', async () => {
      await seedLessons()

      const res = await app.request('/api/learning/lessons?nodeId=generate')
      const body = (await res.json()) as { data: Array<{ nodeId: string }> }
      expect(body.data).toHaveLength(2)
      expect(body.data.every((l) => l.nodeId === 'generate')).toBe(true)
    })

    it('filters by taskType', async () => {
      await seedLessons()

      const res = await app.request('/api/learning/lessons?taskType=security')
      const body = (await res.json()) as { data: Array<{ taskType: string }> }
      expect(body.data).toHaveLength(1)
      expect(body.data[0]!.taskType).toBe('security')
    })

    it('respects limit query parameter', async () => {
      await seedLessons()

      const res = await app.request('/api/learning/lessons?limit=2')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(2)
    })

    it('returns empty array for no lessons', async () => {
      const res = await app.request('/api/learning/lessons')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(0)
    })
  })

  // ── GET /rules ────────────────────────────────────────────────

  describe('GET /api/learning/rules', () => {
    it('returns rules sorted by priority', async () => {
      await seedRules()

      const res = await app.request('/api/learning/rules')
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        success: boolean
        data: Array<{ priority: number; key: string }>
      }
      expect(body.success).toBe(true)
      expect(body.data).toHaveLength(2)
      // Sorted by priority descending
      expect(body.data[0]!.priority).toBe(10)
      expect(body.data[1]!.priority).toBe(5)
    })

    it('respects limit query parameter', async () => {
      await seedRules()

      const res = await app.request('/api/learning/rules?limit=1')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(1)
    })

    it('returns empty array for no rules', async () => {
      const res = await app.request('/api/learning/rules')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(0)
    })
  })

  // ── Error handling ────────────────────────────────────────────

  describe('Error handling', () => {
    it('returns 500 when store fails on dashboard', async () => {
      const failApp = createTestApp(createFailingMemoryService())

      const res = await failApp.request('/api/learning/dashboard')
      expect(res.status).toBe(500)
      const body = (await res.json()) as { success: boolean; error: string }
      expect(body.success).toBe(false)
      expect(body.error).toContain('Store connection failed')
    })

    it('returns 500 when store fails on overview', async () => {
      const failApp = createTestApp(createFailingMemoryService())

      const res = await failApp.request('/api/learning/overview')
      expect(res.status).toBe(500)
      const body = (await res.json()) as { success: boolean; error: string }
      expect(body.success).toBe(false)
    })

    it('returns 500 when store fails on lessons', async () => {
      const failApp = createTestApp(createFailingMemoryService())

      const res = await failApp.request('/api/learning/lessons')
      expect(res.status).toBe(500)
    })

    it('returns 500 when store fails on rules', async () => {
      const failApp = createTestApp(createFailingMemoryService())

      const res = await failApp.request('/api/learning/rules')
      expect(res.status).toBe(500)
    })

    it('returns 500 when store fails on feedback submission', async () => {
      const failApp = createTestApp(createFailingMemoryService())

      const res = await failApp.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'run-1', approved: true }),
      })
      expect(res.status).toBe(500)
    })

    it('returns 500 when store fails on trends/quality', async () => {
      const failApp = createTestApp(createFailingMemoryService())

      const res = await failApp.request('/api/learning/trends/quality')
      expect(res.status).toBe(500)
    })

    it('returns 500 when store fails on nodes', async () => {
      const failApp = createTestApp(createFailingMemoryService())

      const res = await failApp.request('/api/learning/nodes')
      expect(res.status).toBe(500)
    })
  })
})
