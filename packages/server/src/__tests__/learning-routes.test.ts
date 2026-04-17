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

    it('returns 500 when store fails on trends/cost', async () => {
      const failApp = createTestApp(createFailingMemoryService())

      const res = await failApp.request('/api/learning/trends/cost')
      expect(res.status).toBe(500)
      const body = (await res.json()) as { success: boolean; error: string }
      expect(body.success).toBe(false)
      expect(body.error).toContain('Store connection failed')
    })

    it('returns 500 when store fails on feedback/stats', async () => {
      const failApp = createTestApp(createFailingMemoryService())

      const res = await failApp.request('/api/learning/feedback/stats')
      expect(res.status).toBe(500)
      const body = (await res.json()) as { success: boolean; error: string }
      expect(body.success).toBe(false)
    })

    it('returns 500 when store fails on skill-packs/load', async () => {
      const failApp = createTestApp(createFailingMemoryService())

      const res = await failApp.request('/api/learning/skill-packs/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packIds: ['pack-a'] }),
      })
      expect(res.status).toBe(500)
      const body = (await res.json()) as { success: boolean; error: string }
      expect(body.success).toBe(false)
    })

    it('returns 500 when store fails on GET skill-packs', async () => {
      const failApp = createTestApp(createFailingMemoryService())

      const res = await failApp.request('/api/learning/skill-packs')
      expect(res.status).toBe(500)
      const body = (await res.json()) as { success: boolean; error: string }
      expect(body.success).toBe(false)
    })

    it('returns 500 with non-Error thrown values', async () => {
      const throwStringService: MemoryServiceLike = {
        get: (() => { throw 'string error' }) as MemoryServiceLike['get'],
        search: (() => { throw 'string error' }) as MemoryServiceLike['search'],
        put: (() => { throw 'string error' }) as MemoryServiceLike['put'],
      }
      const stringFailApp = createTestApp(throwStringService)

      const res = await stringFailApp.request('/api/learning/dashboard')
      expect(res.status).toBe(500)
      const body = (await res.json()) as { success: boolean; error: string }
      expect(body.success).toBe(false)
      expect(body.error).toBe('string error')
    })
  })

  // ── Dashboard deep tests ──────────────────────────────────────

  describe('GET /api/learning/dashboard — deep', () => {
    it('quality trend is sorted by timestamp ascending', async () => {
      // Seed out-of-order timestamps
      await memoryService.put('trajectories', scope, 'traj-late', {
        qualityScore: 5.0,
        timestamp: '2026-03-01T00:00:00Z',
        nodeId: 'a',
      })
      await memoryService.put('trajectories', scope, 'traj-early', {
        qualityScore: 9.0,
        timestamp: '2026-01-01T00:00:00Z',
        nodeId: 'b',
      })

      const res = await app.request('/api/learning/dashboard')
      const body = (await res.json()) as {
        data: { qualityTrend: Array<{ timestamp: string; score: number }> }
      }
      expect(body.data.qualityTrend[0]!.timestamp).toBe('2026-01-01T00:00:00Z')
      expect(body.data.qualityTrend[1]!.timestamp).toBe('2026-03-01T00:00:00Z')
    })

    it('cost trend is sorted by timestamp ascending', async () => {
      await memoryService.put('trajectories', scope, 'traj-late', {
        costCents: 10,
        timestamp: '2026-03-01T00:00:00Z',
        nodeId: 'a',
      })
      await memoryService.put('trajectories', scope, 'traj-early', {
        costCents: 1,
        timestamp: '2026-01-01T00:00:00Z',
        nodeId: 'b',
      })

      const res = await app.request('/api/learning/dashboard')
      const body = (await res.json()) as {
        data: { costTrend: Array<{ timestamp: string; costCents: number }> }
      }
      expect(body.data.costTrend[0]!.timestamp).toBe('2026-01-01T00:00:00Z')
      expect(body.data.costTrend[1]!.timestamp).toBe('2026-03-01T00:00:00Z')
    })

    it('dashboard truncates lessons, rules, skills to 20 items', async () => {
      for (let i = 0; i < 25; i++) {
        await memoryService.put('lessons', scope, `lesson-${i}`, { text: `lesson ${i}` })
        await memoryService.put('rules', scope, `rule-${i}`, { text: `rule ${i}` })
        await memoryService.put('skills', scope, `skill-${i}`, { name: `skill-${i}` })
      }

      const res = await app.request('/api/learning/dashboard')
      const body = (await res.json()) as {
        data: {
          lessonCount: number
          ruleCount: number
          skillCount: number
          lessons: unknown[]
          rules: unknown[]
          skills: unknown[]
        }
      }
      expect(body.data.lessonCount).toBe(25)
      expect(body.data.ruleCount).toBe(25)
      expect(body.data.skillCount).toBe(25)
      expect(body.data.lessons).toHaveLength(20)
      expect(body.data.rules).toHaveLength(20)
      expect(body.data.skills).toHaveLength(20)
    })

    it('quality trend truncates to last 20 items', async () => {
      for (let i = 0; i < 25; i++) {
        await memoryService.put('trajectories', scope, `traj-${String(i).padStart(3, '0')}`, {
          qualityScore: i,
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
          nodeId: 'n',
        })
      }

      const res = await app.request('/api/learning/dashboard')
      const body = (await res.json()) as {
        data: { qualityTrend: Array<{ score: number }> }
      }
      expect(body.data.qualityTrend).toHaveLength(20)
      // Should be the last 20 (scores 5..24)
      expect(body.data.qualityTrend[0]!.score).toBe(5)
      expect(body.data.qualityTrend[19]!.score).toBe(24)
    })

    it('cost trend truncates to last 20 items', async () => {
      for (let i = 0; i < 25; i++) {
        await memoryService.put('trajectories', scope, `traj-${String(i).padStart(3, '0')}`, {
          costCents: i * 0.5,
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
          nodeId: 'n',
        })
      }

      const res = await app.request('/api/learning/dashboard')
      const body = (await res.json()) as {
        data: { costTrend: Array<{ costCents: number }> }
      }
      expect(body.data.costTrend).toHaveLength(20)
    })

    it('trajectories without qualityScore are excluded from quality trend', async () => {
      await memoryService.put('trajectories', scope, 'traj-no-score', {
        costCents: 5,
        timestamp: '2026-01-01T00:00:00Z',
        nodeId: 'a',
      })
      await memoryService.put('trajectories', scope, 'traj-with-score', {
        qualityScore: 8.0,
        timestamp: '2026-01-02T00:00:00Z',
        nodeId: 'a',
      })

      const res = await app.request('/api/learning/dashboard')
      const body = (await res.json()) as {
        data: { qualityTrend: Array<{ score: number }> }
      }
      expect(body.data.qualityTrend).toHaveLength(1)
      expect(body.data.qualityTrend[0]!.score).toBe(8.0)
    })

    it('trajectories without costCents are excluded from cost trend', async () => {
      await memoryService.put('trajectories', scope, 'traj-no-cost', {
        qualityScore: 9,
        timestamp: '2026-01-01T00:00:00Z',
        nodeId: 'a',
      })

      const res = await app.request('/api/learning/dashboard')
      const body = (await res.json()) as {
        data: { costTrend: unknown[] }
      }
      expect(body.data.costTrend).toHaveLength(0)
    })

    it('feedbackStats includes total, approved, rejected in dashboard', async () => {
      await memoryService.put('feedback', scope, 'fb-a', { approved: true })
      await memoryService.put('feedback', scope, 'fb-b', { approved: true })
      await memoryService.put('feedback', scope, 'fb-c', { approved: false })

      const res = await app.request('/api/learning/dashboard')
      const body = (await res.json()) as {
        data: { feedbackStats: { total: number; approved: number; rejected: number } }
      }
      expect(body.data.feedbackStats.total).toBe(3)
      expect(body.data.feedbackStats.approved).toBe(2)
      expect(body.data.feedbackStats.rejected).toBe(1)
    })

    it('dashboard handles trajectories with missing timestamp gracefully', async () => {
      await memoryService.put('trajectories', scope, 'traj-no-ts', {
        qualityScore: 7.0,
        nodeId: 'x',
      })

      const res = await app.request('/api/learning/dashboard')
      const body = (await res.json()) as {
        data: { qualityTrend: Array<{ timestamp: unknown; score: number }> }
      }
      expect(body.data.qualityTrend).toHaveLength(1)
      expect(body.data.qualityTrend[0]!.score).toBe(7.0)
    })
  })

  // ── Trends deep tests ─────────────────────────────────────────

  describe('GET /api/learning/trends/quality — deep', () => {
    it('returns empty for no trajectories', async () => {
      const res = await app.request('/api/learning/trends/quality')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(0)
    })

    it('excludes trajectories without qualityScore', async () => {
      await memoryService.put('trajectories', scope, 'traj-no-score', {
        costCents: 1.5,
        timestamp: '2026-01-01T00:00:00Z',
      })

      const res = await app.request('/api/learning/trends/quality')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(0)
    })

    it('includes runId in quality trend output', async () => {
      await memoryService.put('trajectories', scope, 'traj-r', {
        qualityScore: 9,
        timestamp: '2026-01-01T00:00:00Z',
        nodeId: 'n1',
        runId: 'run-abc',
      })

      const res = await app.request('/api/learning/trends/quality')
      const body = (await res.json()) as {
        data: Array<{ runId: string | null }>
      }
      expect(body.data[0]!.runId).toBe('run-abc')
    })

    it('returns null for missing runId', async () => {
      await memoryService.put('trajectories', scope, 'traj-no-run', {
        qualityScore: 5,
        timestamp: '2026-01-01T00:00:00Z',
      })

      const res = await app.request('/api/learning/trends/quality')
      const body = (await res.json()) as {
        data: Array<{ runId: string | null; nodeId: string | null }>
      }
      expect(body.data[0]!.runId).toBeNull()
      expect(body.data[0]!.nodeId).toBeNull()
    })

    it('falls back to default limit (20) for invalid limit value', async () => {
      for (let i = 0; i < 25; i++) {
        await memoryService.put('trajectories', scope, `traj-${i}`, {
          qualityScore: i,
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })
      }

      const res = await app.request('/api/learning/trends/quality?limit=-5')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(20)
    })

    it('falls back to default limit for non-numeric limit', async () => {
      for (let i = 0; i < 25; i++) {
        await memoryService.put('trajectories', scope, `traj-${i}`, {
          qualityScore: i,
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })
      }

      const res = await app.request('/api/learning/trends/quality?limit=abc')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(20)
    })

    it('falls back to default limit for zero limit', async () => {
      for (let i = 0; i < 25; i++) {
        await memoryService.put('trajectories', scope, `traj-${i}`, {
          qualityScore: i,
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })
      }

      const res = await app.request('/api/learning/trends/quality?limit=0')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(20)
    })

    it('returns fewer items than limit when not enough data', async () => {
      await memoryService.put('trajectories', scope, 'traj-only', {
        qualityScore: 5,
        timestamp: '2026-01-01T00:00:00Z',
      })

      const res = await app.request('/api/learning/trends/quality?limit=50')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(1)
    })
  })

  describe('GET /api/learning/trends/cost — deep', () => {
    it('returns empty array for no trajectories', async () => {
      const res = await app.request('/api/learning/trends/cost')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(0)
    })

    it('excludes trajectories without costCents', async () => {
      await memoryService.put('trajectories', scope, 'traj-no-cost', {
        qualityScore: 9,
        timestamp: '2026-01-01T00:00:00Z',
      })

      const res = await app.request('/api/learning/trends/cost')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(0)
    })

    it('includes runId in cost trend output', async () => {
      await memoryService.put('trajectories', scope, 'traj-c', {
        costCents: 2.5,
        timestamp: '2026-01-01T00:00:00Z',
        nodeId: 'n1',
        runId: 'run-xyz',
      })

      const res = await app.request('/api/learning/trends/cost')
      const body = (await res.json()) as {
        data: Array<{ runId: string | null }>
      }
      expect(body.data[0]!.runId).toBe('run-xyz')
    })

    it('returns null for missing fields in cost trend', async () => {
      await memoryService.put('trajectories', scope, 'traj-minimal', {
        costCents: 0.1,
      })

      const res = await app.request('/api/learning/trends/cost')
      const body = (await res.json()) as {
        data: Array<{ timestamp: unknown; nodeId: unknown; runId: unknown }>
      }
      expect(body.data[0]!.timestamp).toBeNull()
      expect(body.data[0]!.nodeId).toBeNull()
      expect(body.data[0]!.runId).toBeNull()
    })

    it('falls back to default limit for invalid limit', async () => {
      for (let i = 0; i < 25; i++) {
        await memoryService.put('trajectories', scope, `traj-${i}`, {
          costCents: i * 0.1,
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })
      }

      const res = await app.request('/api/learning/trends/cost?limit=-1')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(20)
    })
  })

  // ── Nodes deep tests ──────────────────────────────────────────

  describe('GET /api/learning/nodes — deep', () => {
    it('groups trajectories without nodeId under "unknown"', async () => {
      await memoryService.put('trajectories', scope, 'traj-no-node', {
        qualityScore: 5.0,
        costCents: 1.0,
        timestamp: '2026-01-01T00:00:00Z',
      })

      const res = await app.request('/api/learning/nodes')
      const body = (await res.json()) as {
        data: Array<{ nodeId: string; runCount: number }>
      }
      expect(body.data).toHaveLength(1)
      expect(body.data[0]!.nodeId).toBe('unknown')
      expect(body.data[0]!.runCount).toBe(1)
    })

    it('handles trajectories without qualityScore (avgQualityScore is null)', async () => {
      await memoryService.put('trajectories', scope, 'traj-no-score', {
        nodeId: 'nodeA',
        costCents: 2.0,
        timestamp: '2026-01-01T00:00:00Z',
      })

      const res = await app.request('/api/learning/nodes')
      const body = (await res.json()) as {
        data: Array<{ nodeId: string; avgQualityScore: number | null; totalCostCents: number }>
      }
      const node = body.data.find((n) => n.nodeId === 'nodeA')
      expect(node!.avgQualityScore).toBeNull()
      expect(node!.totalCostCents).toBe(2.0)
    })

    it('handles trajectories without costCents (totalCostCents is 0)', async () => {
      await memoryService.put('trajectories', scope, 'traj-no-cost', {
        nodeId: 'nodeB',
        qualityScore: 8.0,
        timestamp: '2026-01-01T00:00:00Z',
      })

      const res = await app.request('/api/learning/nodes')
      const body = (await res.json()) as {
        data: Array<{ nodeId: string; avgQualityScore: number | null; totalCostCents: number }>
      }
      const node = body.data.find((n) => n.nodeId === 'nodeB')
      expect(node!.avgQualityScore).toBe(8.0)
      expect(node!.totalCostCents).toBe(0)
    })

    it('rounds avgQualityScore to 2 decimal places', async () => {
      await memoryService.put('trajectories', scope, 'traj-1', {
        nodeId: 'nodeC',
        qualityScore: 7.333,
      })
      await memoryService.put('trajectories', scope, 'traj-2', {
        nodeId: 'nodeC',
        qualityScore: 7.333,
      })
      await memoryService.put('trajectories', scope, 'traj-3', {
        nodeId: 'nodeC',
        qualityScore: 7.334,
      })

      const res = await app.request('/api/learning/nodes')
      const body = (await res.json()) as {
        data: Array<{ nodeId: string; avgQualityScore: number }>
      }
      const node = body.data.find((n) => n.nodeId === 'nodeC')
      // (7.333 + 7.333 + 7.334) / 3 = 7.333333...  rounded to 7.33
      expect(node!.avgQualityScore).toBe(7.33)
    })

    it('rounds totalCostCents to 2 decimal places', async () => {
      await memoryService.put('trajectories', scope, 'traj-1', {
        nodeId: 'nodeD',
        costCents: 0.1,
      })
      await memoryService.put('trajectories', scope, 'traj-2', {
        nodeId: 'nodeD',
        costCents: 0.2,
      })

      const res = await app.request('/api/learning/nodes')
      const body = (await res.json()) as {
        data: Array<{ nodeId: string; totalCostCents: number }>
      }
      const node = body.data.find((n) => n.nodeId === 'nodeD')
      expect(node!.totalCostCents).toBe(0.3)
    })

    it('handles multiple nodes with varying data completeness', async () => {
      await memoryService.put('trajectories', scope, 'traj-a1', {
        nodeId: 'alpha',
        qualityScore: 9,
        costCents: 5,
      })
      await memoryService.put('trajectories', scope, 'traj-b1', {
        nodeId: 'beta',
        costCents: 3,
      })
      await memoryService.put('trajectories', scope, 'traj-b2', {
        nodeId: 'beta',
        qualityScore: 6,
      })

      const res = await app.request('/api/learning/nodes')
      const body = (await res.json()) as {
        data: Array<{
          nodeId: string
          runCount: number
          avgQualityScore: number | null
          totalCostCents: number
        }>
      }
      expect(body.data).toHaveLength(2)

      const alpha = body.data.find((n) => n.nodeId === 'alpha')
      expect(alpha!.runCount).toBe(1)
      expect(alpha!.avgQualityScore).toBe(9)
      expect(alpha!.totalCostCents).toBe(5)

      const beta = body.data.find((n) => n.nodeId === 'beta')
      expect(beta!.runCount).toBe(2)
      expect(beta!.avgQualityScore).toBe(6)
      expect(beta!.totalCostCents).toBe(3)
    })
  })

  // ── Feedback POST deep tests ──────────────────────────────────

  describe('POST /api/learning/feedback — deep', () => {
    it('returns 400 for empty string runId', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: '', approved: true }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { success: boolean; error: string }
      expect(body.success).toBe(false)
      expect(body.error).toContain('runId')
    })

    it('returns 400 when approved is a string instead of boolean', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'run-1', approved: 'true' }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { success: boolean; error: string }
      expect(body.success).toBe(false)
      expect(body.error).toContain('approved')
    })

    it('returns 400 when approved is a number', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'run-1', approved: 1 }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 when runId is a number', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 123, approved: true }),
      })
      expect(res.status).toBe(400)
    })

    it('defaults type to "general" when not provided', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'run-type-test', approved: false }),
      })
      expect(res.status).toBe(200)

      // Verify stored feedback has type=general
      const stored = await memoryService.search('feedback', scope, '', 100)
      const entry = stored.find((f) => f['runId'] === 'run-type-test')
      expect(entry).toBeDefined()
      expect(entry!['type']).toBe('general')
    })

    it('defaults type to "general" when type is a number', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'run-num-type', approved: true, type: 42 }),
      })
      expect(res.status).toBe(200)

      const stored = await memoryService.search('feedback', scope, '', 100)
      const entry = stored.find((f) => f['runId'] === 'run-num-type')
      expect(entry!['type']).toBe('general')
    })

    it('stores optional feedback string', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: 'run-with-text',
          approved: true,
          feedback: 'Great output!',
        }),
      })
      expect(res.status).toBe(200)

      const stored = await memoryService.search('feedback', scope, '', 100)
      const entry = stored.find((f) => f['runId'] === 'run-with-text')
      expect(entry!['feedback']).toBe('Great output!')
    })

    it('ignores non-string feedback field', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: 'run-bad-feedback',
          approved: true,
          feedback: 123,
        }),
      })
      expect(res.status).toBe(200)

      const stored = await memoryService.search('feedback', scope, '', 100)
      const entry = stored.find((f) => f['runId'] === 'run-bad-feedback')
      expect(entry!['feedback']).toBeUndefined()
    })

    it('stores optional featureCategory string', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: 'run-cat',
          approved: false,
          featureCategory: 'authentication',
        }),
      })
      expect(res.status).toBe(200)

      const stored = await memoryService.search('feedback', scope, '', 100)
      const entry = stored.find((f) => f['runId'] === 'run-cat')
      expect(entry!['featureCategory']).toBe('authentication')
    })

    it('ignores non-string featureCategory', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: 'run-bad-cat',
          approved: true,
          featureCategory: { nested: true },
        }),
      })
      expect(res.status).toBe(200)

      const stored = await memoryService.search('feedback', scope, '', 100)
      const entry = stored.find((f) => f['runId'] === 'run-bad-cat')
      expect(entry!['featureCategory']).toBeUndefined()
    })

    it('stores feedback with approved=false', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'run-rejected', approved: false }),
      })
      expect(res.status).toBe(200)

      const stored = await memoryService.search('feedback', scope, '', 100)
      const entry = stored.find((f) => f['runId'] === 'run-rejected')
      expect(entry!['approved']).toBe(false)
    })

    it('feedback key contains runId', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'run-key-test', approved: true }),
      })

      const body = (await res.json()) as { result: { key: string } }
      expect(body.result.key).toMatch(/^feedback-run-key-test-\d+$/)
    })

    it('stores timestamp in ISO format', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'run-ts', approved: true }),
      })
      expect(res.status).toBe(200)

      const stored = await memoryService.search('feedback', scope, '', 100)
      const entry = stored.find((f) => f['runId'] === 'run-ts')
      expect(typeof entry!['timestamp']).toBe('string')
      // Should be a valid ISO string
      expect(new Date(entry!['timestamp'] as string).toISOString()).toBe(entry!['timestamp'])
    })
  })

  // ── Feedback stats deep tests ─────────────────────────────────

  describe('GET /api/learning/feedback/stats — deep', () => {
    it('computes approvalRate correctly', async () => {
      // 3 approved, 1 rejected => 75%
      await memoryService.put('feedback', scope, 'fb-a', { approved: true, type: 'q' })
      await memoryService.put('feedback', scope, 'fb-b', { approved: true, type: 'q' })
      await memoryService.put('feedback', scope, 'fb-c', { approved: true, type: 'q' })
      await memoryService.put('feedback', scope, 'fb-d', { approved: false, type: 'q' })

      const res = await app.request('/api/learning/feedback/stats')
      const body = (await res.json()) as {
        data: { total: number; approved: number; rejected: number; approvalRate: number }
      }
      expect(body.data.total).toBe(4)
      expect(body.data.approved).toBe(3)
      expect(body.data.rejected).toBe(1)
      expect(body.data.approvalRate).toBe(75)
    })

    it('returns 100% approvalRate when all approved', async () => {
      await memoryService.put('feedback', scope, 'fb-1', { approved: true, type: 'x' })
      await memoryService.put('feedback', scope, 'fb-2', { approved: true, type: 'x' })

      const res = await app.request('/api/learning/feedback/stats')
      const body = (await res.json()) as { data: { approvalRate: number } }
      expect(body.data.approvalRate).toBe(100)
    })

    it('returns 0% approvalRate when all rejected', async () => {
      await memoryService.put('feedback', scope, 'fb-1', { approved: false, type: 'x' })
      await memoryService.put('feedback', scope, 'fb-2', { approved: false, type: 'x' })

      const res = await app.request('/api/learning/feedback/stats')
      const body = (await res.json()) as { data: { approvalRate: number } }
      expect(body.data.approvalRate).toBe(0)
    })

    it('groups feedback by type correctly with multiple types', async () => {
      await memoryService.put('feedback', scope, 'fb-a', { approved: true, type: 'quality' })
      await memoryService.put('feedback', scope, 'fb-b', { approved: false, type: 'quality' })
      await memoryService.put('feedback', scope, 'fb-c', { approved: true, type: 'accuracy' })
      await memoryService.put('feedback', scope, 'fb-d', { approved: true, type: 'accuracy' })
      await memoryService.put('feedback', scope, 'fb-e', { approved: false, type: 'style' })

      const res = await app.request('/api/learning/feedback/stats')
      const body = (await res.json()) as {
        data: { byType: Record<string, { approved: number; rejected: number }> }
      }
      expect(body.data.byType['quality']).toEqual({ approved: 1, rejected: 1 })
      expect(body.data.byType['accuracy']).toEqual({ approved: 2, rejected: 0 })
      expect(body.data.byType['style']).toEqual({ approved: 0, rejected: 1 })
    })

    it('defaults type to "general" for feedback without type field', async () => {
      await memoryService.put('feedback', scope, 'fb-no-type', { approved: true })

      const res = await app.request('/api/learning/feedback/stats')
      const body = (await res.json()) as {
        data: { byType: Record<string, { approved: number; rejected: number }> }
      }
      expect(body.data.byType['general']).toEqual({ approved: 1, rejected: 0 })
    })
  })

  // ── Skill packs deep tests ────────────────────────────────────

  describe('POST /api/learning/skill-packs/load — deep', () => {
    it('returns 400 when packIds is a string instead of array', async () => {
      const res = await app.request('/api/learning/skill-packs/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packIds: 'pack-typescript' }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { success: boolean; error: string }
      expect(body.success).toBe(false)
      expect(body.error).toContain('packIds')
    })

    it('returns 400 when packIds is a number', async () => {
      const res = await app.request('/api/learning/skill-packs/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packIds: 42 }),
      })
      expect(res.status).toBe(400)
    })

    it('skips non-string items in packIds array', async () => {
      const res = await app.request('/api/learning/skill-packs/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packIds: ['pack-valid', 123, null, 'pack-also-valid'] }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { result: { loaded: string[] } }
      expect(body.result.loaded).toEqual(['pack-valid', 'pack-also-valid'])
    })

    it('loads a single pack', async () => {
      const res = await app.request('/api/learning/skill-packs/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packIds: ['pack-only-one'] }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { result: { loaded: string[] } }
      expect(body.result.loaded).toEqual(['pack-only-one'])
    })

    it('overwrites previously loaded pack with same ID', async () => {
      // Load once
      await app.request('/api/learning/skill-packs/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packIds: ['pack-dup'] }),
      })

      // Load again
      await app.request('/api/learning/skill-packs/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packIds: ['pack-dup'] }),
      })

      // Should still only appear once
      const listRes = await app.request('/api/learning/skill-packs')
      const listBody = (await listRes.json()) as { data: string[] }
      const count = listBody.data.filter((id) => id === 'pack-dup').length
      expect(count).toBe(1)
    })

    it('returns empty loaded array when all packIds are non-string', async () => {
      const res = await app.request('/api/learning/skill-packs/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packIds: [123, null, true] }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { result: { loaded: string[] } }
      expect(body.result.loaded).toEqual([])
    })
  })

  // ── Skill packs GET deep tests ────────────────────────────────

  describe('GET /api/learning/skill-packs — deep', () => {
    it('filters out packs without packId string field', async () => {
      // Directly put a record with non-string packId
      await memoryService.put('packs_loaded', scope, 'bad-pack', {
        packId: 42,
        loadedAt: '2026-01-01T00:00:00Z',
      })
      await memoryService.put('packs_loaded', scope, 'good-pack', {
        packId: 'good-pack',
        loadedAt: '2026-01-01T00:00:00Z',
      })

      const res = await app.request('/api/learning/skill-packs')
      const body = (await res.json()) as { data: string[] }
      expect(body.data).toEqual(['good-pack'])
    })
  })

  // ── Lessons deep tests ────────────────────────────────────────

  describe('GET /api/learning/lessons — deep', () => {
    it('filters by both nodeId and taskType simultaneously', async () => {
      await seedLessons()

      const res = await app.request('/api/learning/lessons?nodeId=generate&taskType=backend')
      const body = (await res.json()) as {
        data: Array<{ nodeId: string; taskType: string }>
      }
      expect(body.data).toHaveLength(1)
      expect(body.data[0]!.nodeId).toBe('generate')
      expect(body.data[0]!.taskType).toBe('backend')
    })

    it('returns empty when nodeId filter matches nothing', async () => {
      await seedLessons()

      const res = await app.request('/api/learning/lessons?nodeId=nonexistent')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(0)
    })

    it('returns empty when taskType filter matches nothing', async () => {
      await seedLessons()

      const res = await app.request('/api/learning/lessons?taskType=nonexistent')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(0)
    })

    it('returns empty when combined filters match nothing', async () => {
      await seedLessons()

      // generate + security doesn't exist (generate has backend and frontend)
      const res = await app.request('/api/learning/lessons?nodeId=generate&taskType=security')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(0)
    })

    it('handles lessons without importance field (treated as 0)', async () => {
      await memoryService.put('lessons', scope, 'lesson-no-imp', {
        text: 'No importance',
        nodeId: 'x',
      })
      await memoryService.put('lessons', scope, 'lesson-with-imp', {
        text: 'Has importance',
        importance: 5,
        nodeId: 'x',
      })

      const res = await app.request('/api/learning/lessons')
      const body = (await res.json()) as {
        data: Array<{ text: string; importance?: number }>
      }
      expect(body.data).toHaveLength(2)
      // lesson with importance=5 should come first
      expect(body.data[0]!.text).toBe('Has importance')
      expect(body.data[1]!.text).toBe('No importance')
    })

    it('falls back to default limit (10) for invalid limit', async () => {
      for (let i = 0; i < 15; i++) {
        await memoryService.put('lessons', scope, `lesson-${i}`, {
          text: `lesson ${i}`,
          importance: i,
        })
      }

      const res = await app.request('/api/learning/lessons?limit=-1')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(10)
    })

    it('falls back to default limit for non-numeric limit', async () => {
      for (let i = 0; i < 15; i++) {
        await memoryService.put('lessons', scope, `lesson-${i}`, {
          text: `lesson ${i}`,
          importance: i,
        })
      }

      const res = await app.request('/api/learning/lessons?limit=abc')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(10)
    })

    it('applies limit after filtering', async () => {
      await seedLessons()
      // 2 lessons have nodeId=generate, limit=1 should return 1
      const res = await app.request('/api/learning/lessons?nodeId=generate&limit=1')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(1)
    })
  })

  // ── Rules deep tests ──────────────────────────────────────────

  describe('GET /api/learning/rules — deep', () => {
    it('handles rules without priority field (treated as 0)', async () => {
      await memoryService.put('rules', scope, 'rule-no-prio', {
        text: 'No priority',
      })
      await memoryService.put('rules', scope, 'rule-with-prio', {
        text: 'Has priority',
        priority: 3,
      })

      const res = await app.request('/api/learning/rules')
      const body = (await res.json()) as {
        data: Array<{ text: string; priority?: number }>
      }
      expect(body.data).toHaveLength(2)
      expect(body.data[0]!.text).toBe('Has priority')
      expect(body.data[1]!.text).toBe('No priority')
    })

    it('falls back to default limit (10) for invalid limit', async () => {
      for (let i = 0; i < 15; i++) {
        await memoryService.put('rules', scope, `rule-${i}`, {
          text: `rule ${i}`,
          priority: i,
        })
      }

      const res = await app.request('/api/learning/rules?limit=-5')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(10)
    })

    it('falls back to default limit for zero limit', async () => {
      for (let i = 0; i < 15; i++) {
        await memoryService.put('rules', scope, `rule-${i}`, {
          text: `rule ${i}`,
          priority: i,
        })
      }

      const res = await app.request('/api/learning/rules?limit=0')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(10)
    })

    it('falls back to default limit for non-numeric limit', async () => {
      for (let i = 0; i < 15; i++) {
        await memoryService.put('rules', scope, `rule-${i}`, {
          text: `rule ${i}`,
          priority: i,
        })
      }

      const res = await app.request('/api/learning/rules?limit=xyz')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(10)
    })

    it('returns all rules when limit exceeds count', async () => {
      await seedRules()

      const res = await app.request('/api/learning/rules?limit=100')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(2)
    })
  })

  // ── Tenant ID handling ────────────────────────────────────────

  describe('Tenant ID isolation', () => {
    it('uses defaultTenantId when no context tenantId', async () => {
      // Seed data under the default tenant scope
      await memoryService.put('lessons', scope, 'lesson-t', { text: 'tenant lesson' })

      const res = await app.request('/api/learning/lessons')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(1)
    })

    it('different tenant sees no data from default tenant', async () => {
      // Seed under default scope
      await memoryService.put('lessons', scope, 'lesson-default', { text: 'default' })

      // Create app with different tenant
      const otherApp = new Hono()
      otherApp.route(
        '/api/learning',
        createLearningRoutes({ memoryService, defaultTenantId: 'other-tenant' }),
      )

      const res = await otherApp.request('/api/learning/lessons')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(0)
    })
  })

  // ── Response structure tests ──────────────────────────────────

  describe('Response structure consistency', () => {
    it('all GET endpoints return success: true on success', async () => {
      const endpoints = [
        '/api/learning/dashboard',
        '/api/learning/overview',
        '/api/learning/trends/quality',
        '/api/learning/trends/cost',
        '/api/learning/nodes',
        '/api/learning/feedback/stats',
        '/api/learning/skill-packs',
        '/api/learning/lessons',
        '/api/learning/rules',
      ]

      for (const endpoint of endpoints) {
        const res = await app.request(endpoint)
        const body = (await res.json()) as { success: boolean }
        expect(body.success).toBe(true)
      }
    })

    it('all error responses include success: false and error string', async () => {
      const failApp = createTestApp(createFailingMemoryService())

      const endpoints = [
        '/api/learning/dashboard',
        '/api/learning/overview',
        '/api/learning/trends/quality',
        '/api/learning/trends/cost',
        '/api/learning/nodes',
        '/api/learning/feedback/stats',
        '/api/learning/skill-packs',
        '/api/learning/lessons',
        '/api/learning/rules',
      ]

      for (const endpoint of endpoints) {
        const res = await failApp.request(endpoint)
        expect(res.status).toBe(500)
        const body = (await res.json()) as { success: boolean; error: string }
        expect(body.success).toBe(false)
        expect(typeof body.error).toBe('string')
        expect(body.error.length).toBeGreaterThan(0)
      }
    })

    it('POST /feedback returns result with key on success', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'run-struct', approved: true }),
      })
      const body = (await res.json()) as { success: boolean; result: { key: string } }
      expect(body.success).toBe(true)
      expect(typeof body.result.key).toBe('string')
    })

    it('POST /skill-packs/load returns result with loaded array on success', async () => {
      const res = await app.request('/api/learning/skill-packs/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packIds: ['p1'] }),
      })
      const body = (await res.json()) as { success: boolean; result: { loaded: string[] } }
      expect(body.success).toBe(true)
      expect(Array.isArray(body.result.loaded)).toBe(true)
    })
  })

  // =========================================================================
  // W17-B3: Additional edge-case tests (30+ new tests)
  // =========================================================================

  describe('Trend endpoints with no data', () => {
    it('GET /trends/quality with empty store returns empty array, not error', async () => {
      const res = await app.request('/api/learning/trends/quality')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { success: boolean; data: unknown[] }
      expect(body.success).toBe(true)
      expect(body.data).toEqual([])
    })

    it('GET /trends/cost with empty store returns empty array, not error', async () => {
      const res = await app.request('/api/learning/trends/cost')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { success: boolean; data: unknown[] }
      expect(body.success).toBe(true)
      expect(body.data).toEqual([])
    })

    it('GET /trends/quality with trajectories lacking qualityScore returns empty', async () => {
      await memoryService.put('trajectories', scope, 'traj-only-cost', {
        costCents: 5,
        timestamp: '2026-01-01T00:00:00Z',
        nodeId: 'n1',
      })
      const res = await app.request('/api/learning/trends/quality')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toEqual([])
    })

    it('GET /trends/cost with trajectories lacking costCents returns empty', async () => {
      await memoryService.put('trajectories', scope, 'traj-only-quality', {
        qualityScore: 9,
        timestamp: '2026-01-01T00:00:00Z',
        nodeId: 'n1',
      })
      const res = await app.request('/api/learning/trends/cost')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toEqual([])
    })
  })

  describe('Limit parsing edge cases across endpoints', () => {
    it('GET /trends/quality?limit=0 uses fallback 20', async () => {
      for (let i = 0; i < 25; i++) {
        await memoryService.put('trajectories', scope, `traj-lim0-${i}`, {
          qualityScore: i,
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })
      }
      const res = await app.request('/api/learning/trends/quality?limit=0')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(20)
    })

    it('GET /trends/cost?limit=0 uses fallback 20', async () => {
      for (let i = 0; i < 25; i++) {
        await memoryService.put('trajectories', scope, `traj-clim0-${i}`, {
          costCents: i * 0.1,
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })
      }
      const res = await app.request('/api/learning/trends/cost?limit=0')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(20)
    })

    it('GET /trends/cost?limit=abc uses fallback 20', async () => {
      for (let i = 0; i < 25; i++) {
        await memoryService.put('trajectories', scope, `traj-cabc-${i}`, {
          costCents: i * 0.1,
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })
      }
      const res = await app.request('/api/learning/trends/cost?limit=abc')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(20)
    })

    it('GET /lessons?limit=0 uses fallback 10', async () => {
      for (let i = 0; i < 15; i++) {
        await memoryService.put('lessons', scope, `lesson-lim0-${i}`, {
          text: `lesson ${i}`, importance: i,
        })
      }
      const res = await app.request('/api/learning/lessons?limit=0')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(10)
    })

    it('GET /rules?limit=abc uses fallback 10', async () => {
      for (let i = 0; i < 15; i++) {
        await memoryService.put('rules', scope, `rule-abc-${i}`, {
          text: `rule ${i}`, priority: i,
        })
      }
      const res = await app.request('/api/learning/rules?limit=abc')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(10)
    })
  })

  describe('Node performance edge cases', () => {
    it('GET /nodes when no trajectories returns empty array', async () => {
      const res = await app.request('/api/learning/nodes')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { success: boolean; data: unknown[] }
      expect(body.success).toBe(true)
      expect(body.data).toEqual([])
    })

    it('GET /nodes with single trajectory per node', async () => {
      await memoryService.put('trajectories', scope, 'traj-single', {
        nodeId: 'solo-node',
        qualityScore: 7.5,
        costCents: 2.0,
        timestamp: '2026-01-01T00:00:00Z',
      })
      const res = await app.request('/api/learning/nodes')
      const body = (await res.json()) as {
        data: Array<{ nodeId: string; runCount: number; avgQualityScore: number; totalCostCents: number }>
      }
      expect(body.data).toHaveLength(1)
      expect(body.data[0]!.nodeId).toBe('solo-node')
      expect(body.data[0]!.runCount).toBe(1)
      expect(body.data[0]!.avgQualityScore).toBe(7.5)
      expect(body.data[0]!.totalCostCents).toBe(2.0)
    })

    it('GET /nodes with many nodes correctly separates them', async () => {
      for (let i = 0; i < 5; i++) {
        await memoryService.put('trajectories', scope, `traj-n${i}`, {
          nodeId: `node-${i}`,
          qualityScore: i + 1,
          costCents: i * 0.5,
        })
      }
      const res = await app.request('/api/learning/nodes')
      const body = (await res.json()) as { data: Array<{ nodeId: string }> }
      expect(body.data).toHaveLength(5)
      const nodeIds = body.data.map((n) => n.nodeId).sort()
      expect(nodeIds).toEqual(['node-0', 'node-1', 'node-2', 'node-3', 'node-4'])
    })
  })

  describe('Feedback validation edge cases', () => {
    it('POST /feedback with empty object returns 400', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { success: boolean; error: string }
      expect(body.success).toBe(false)
      expect(body.error).toBeTruthy()
    })

    it('POST /feedback with runId but approved=null returns 400', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'run-1', approved: null }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('approved')
    })

    it('POST /feedback with runId=null returns 400', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: null, approved: true }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('runId')
    })

    it('POST /feedback with approved=undefined returns 400', async () => {
      const res = await app.request('/api/learning/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'run-1' }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('Feedback stats with no feedback', () => {
    it('GET /feedback/stats when no feedback stored returns zero counts', async () => {
      const res = await app.request('/api/learning/feedback/stats')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        success: boolean
        data: { total: number; approved: number; rejected: number; approvalRate: number }
      }
      expect(body.success).toBe(true)
      expect(body.data.total).toBe(0)
      expect(body.data.approved).toBe(0)
      expect(body.data.rejected).toBe(0)
      expect(body.data.approvalRate).toBe(0)
    })

    it('GET /feedback/stats with empty byType map', async () => {
      const res = await app.request('/api/learning/feedback/stats')
      const body = (await res.json()) as { data: { byType: Record<string, unknown> } }
      expect(body.data.byType).toEqual({})
    })
  })

  describe('Skill-pack reload idempotency', () => {
    it('POST /skill-packs/load twice with same packIds — no duplicate entries', async () => {
      const payload = { packIds: ['pack-alpha', 'pack-beta'] }

      await app.request('/api/learning/skill-packs/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      await app.request('/api/learning/skill-packs/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const listRes = await app.request('/api/learning/skill-packs')
      const listBody = (await listRes.json()) as { data: string[] }
      expect(listBody.data).toHaveLength(2)
      expect(listBody.data).toContain('pack-alpha')
      expect(listBody.data).toContain('pack-beta')
    })

    it('POST /skill-packs/load with overlapping packs — no dups in list', async () => {
      await app.request('/api/learning/skill-packs/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packIds: ['pack-x', 'pack-y'] }),
      })
      await app.request('/api/learning/skill-packs/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packIds: ['pack-y', 'pack-z'] }),
      })

      const listRes = await app.request('/api/learning/skill-packs')
      const listBody = (await listRes.json()) as { data: string[] }
      expect(listBody.data).toHaveLength(3)
      const yCounts = listBody.data.filter((id) => id === 'pack-y').length
      expect(yCounts).toBe(1)
    })
  })

  describe('Skill-packs list after loading', () => {
    it('GET /skill-packs after loading 3 packs returns correct IDs', async () => {
      await app.request('/api/learning/skill-packs/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packIds: ['pack-ts', 'pack-react', 'pack-node'] }),
      })

      const res = await app.request('/api/learning/skill-packs')
      const body = (await res.json()) as { success: boolean; data: string[] }
      expect(body.success).toBe(true)
      expect(body.data.sort()).toEqual(['pack-node', 'pack-react', 'pack-ts'])
    })
  })

  describe('Lessons with nodeId filter', () => {
    it('GET /lessons?nodeId=agent-1 returns only that node lessons', async () => {
      await memoryService.put('lessons', scope, 'l-a1', {
        text: 'Agent-1 lesson A', importance: 5, nodeId: 'agent-1', taskType: 'gen',
      })
      await memoryService.put('lessons', scope, 'l-a2', {
        text: 'Agent-1 lesson B', importance: 3, nodeId: 'agent-1', taskType: 'gen',
      })
      await memoryService.put('lessons', scope, 'l-b1', {
        text: 'Agent-2 lesson', importance: 8, nodeId: 'agent-2', taskType: 'gen',
      })

      const res = await app.request('/api/learning/lessons?nodeId=agent-1')
      const body = (await res.json()) as { data: Array<{ nodeId: string }> }
      expect(body.data).toHaveLength(2)
      expect(body.data.every((l) => l.nodeId === 'agent-1')).toBe(true)
    })
  })

  describe('Lessons with taskType filter', () => {
    it('GET /lessons?taskType=code-gen returns only matching lessons', async () => {
      await memoryService.put('lessons', scope, 'l-cg1', {
        text: 'Code gen tip', importance: 5, nodeId: 'n1', taskType: 'code-gen',
      })
      await memoryService.put('lessons', scope, 'l-cg2', {
        text: 'Another code gen tip', importance: 7, nodeId: 'n2', taskType: 'code-gen',
      })
      await memoryService.put('lessons', scope, 'l-review', {
        text: 'Review tip', importance: 9, nodeId: 'n1', taskType: 'review',
      })

      const res = await app.request('/api/learning/lessons?taskType=code-gen')
      const body = (await res.json()) as { data: Array<{ taskType: string }> }
      expect(body.data).toHaveLength(2)
      expect(body.data.every((l) => l.taskType === 'code-gen')).toBe(true)
    })
  })

  describe('Rules with specific limit', () => {
    it('GET /rules?limit=3 returns at most 3 rules', async () => {
      for (let i = 0; i < 10; i++) {
        await memoryService.put('rules', scope, `rule-lim3-${i}`, {
          text: `Rule ${i}`, priority: i,
        })
      }

      const res = await app.request('/api/learning/rules?limit=3')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(3)
    })

    it('GET /rules?limit=3 returns highest priority rules', async () => {
      for (let i = 0; i < 10; i++) {
        await memoryService.put('rules', scope, `rule-prio-${i}`, {
          text: `Rule prio ${i}`, priority: i,
        })
      }

      const res = await app.request('/api/learning/rules?limit=3')
      const body = (await res.json()) as { data: Array<{ priority: number }> }
      expect(body.data).toHaveLength(3)
      // Should be the top 3 by priority: 9, 8, 7
      expect(body.data[0]!.priority).toBe(9)
      expect(body.data[1]!.priority).toBe(8)
      expect(body.data[2]!.priority).toBe(7)
    })
  })

  describe('Dashboard with partial data', () => {
    it('some namespaces empty, others populated — no 500', async () => {
      // Only seed lessons and trajectories, leave rules/skills/feedback/packs/errors empty
      await memoryService.put('lessons', scope, 'l-partial', { text: 'partial', importance: 1 })
      await memoryService.put('trajectories', scope, 't-partial', {
        qualityScore: 8, costCents: 1, timestamp: '2026-01-01T00:00:00Z', nodeId: 'n',
      })

      const res = await app.request('/api/learning/dashboard')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        success: boolean
        data: {
          lessonCount: number; ruleCount: number; skillCount: number
          feedbackCount: number; packCount: number; errorCount: number
        }
      }
      expect(body.success).toBe(true)
      expect(body.data.lessonCount).toBe(1)
      expect(body.data.ruleCount).toBe(0)
      expect(body.data.skillCount).toBe(0)
      expect(body.data.feedbackCount).toBe(0)
      expect(body.data.packCount).toBe(0)
      expect(body.data.errorCount).toBe(0)
    })

    it('only errors namespace populated — dashboard still succeeds', async () => {
      await memoryService.put('errors', scope, 'err-1', { message: 'boom', timestamp: '2026-01-01' })

      const res = await app.request('/api/learning/dashboard')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { success: boolean; data: { errorCount: number; lessonCount: number } }
      expect(body.success).toBe(true)
      expect(body.data.errorCount).toBe(1)
      expect(body.data.lessonCount).toBe(0)
    })
  })

  describe('Concurrent requests', () => {
    it('5 simultaneous GET /dashboard requests — all succeed', async () => {
      await seedLessons()
      await seedRules()

      const requests = Array.from({ length: 5 }, () =>
        app.request('/api/learning/dashboard'),
      )
      const responses = await Promise.all(requests)

      for (const res of responses) {
        expect(res.status).toBe(200)
        const body = (await res.json()) as { success: boolean }
        expect(body.success).toBe(true)
      }
    })

    it('concurrent GET on different endpoints — all succeed', async () => {
      await seedLessons()
      await seedRules()
      await seedTrajectories()

      const endpoints = [
        '/api/learning/dashboard',
        '/api/learning/overview',
        '/api/learning/trends/quality',
        '/api/learning/trends/cost',
        '/api/learning/nodes',
        '/api/learning/lessons',
        '/api/learning/rules',
        '/api/learning/feedback/stats',
        '/api/learning/skill-packs',
      ]
      const responses = await Promise.all(
        endpoints.map((ep) => app.request(ep)),
      )
      for (const res of responses) {
        expect(res.status).toBe(200)
        const body = (await res.json()) as { success: boolean }
        expect(body.success).toBe(true)
      }
    })
  })

  describe('TenantId from context', () => {
    it('when context has tenantId, routes use it instead of defaultTenantId', async () => {
      const ctxTenantId = 'ctx-tenant-42'
      const ctxScope = { tenantId: ctxTenantId }

      // Seed data under the context tenant
      await memoryService.put('lessons', ctxScope, 'lesson-ctx', {
        text: 'Context tenant lesson', importance: 5,
      })

      // Seed data under the default tenant too
      await memoryService.put('lessons', scope, 'lesson-default', {
        text: 'Default tenant lesson', importance: 3,
      })

      // Create an app that injects tenantId via middleware
      const ctxApp = new Hono()
      ctxApp.use('*', async (c, next) => {
        c.set('tenantId', ctxTenantId)
        await next()
      })
      ctxApp.route('/api/learning', createLearningRoutes({ memoryService, defaultTenantId: 'test-tenant' }))

      const res = await ctxApp.request('/api/learning/lessons')
      const body = (await res.json()) as { data: Array<{ text: string }> }
      expect(body.data).toHaveLength(1)
      expect(body.data[0]!.text).toBe('Context tenant lesson')
    })

    it('empty string tenantId in context falls back to defaultTenantId', async () => {
      await memoryService.put('lessons', scope, 'lesson-fallback', {
        text: 'Default', importance: 1,
      })

      const ctxApp = new Hono()
      ctxApp.use('*', async (c, next) => {
        c.set('tenantId', '')
        await next()
      })
      ctxApp.route('/api/learning', createLearningRoutes({ memoryService, defaultTenantId: 'test-tenant' }))

      const res = await ctxApp.request('/api/learning/lessons')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(1)
    })

    it('non-string tenantId in context falls back to defaultTenantId', async () => {
      await memoryService.put('rules', scope, 'rule-fallback', {
        text: 'Default rule', priority: 1,
      })

      const ctxApp = new Hono()
      ctxApp.use('*', async (c, next) => {
        c.set('tenantId', 12345)
        await next()
      })
      ctxApp.route('/api/learning', createLearningRoutes({ memoryService, defaultTenantId: 'test-tenant' }))

      const res = await ctxApp.request('/api/learning/rules')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(1)
    })
  })

  describe('Quality trend with valid limit values', () => {
    it('GET /trends/quality?limit=1 returns exactly 1 most recent', async () => {
      await seedTrajectories()
      const res = await app.request('/api/learning/trends/quality?limit=1')
      const body = (await res.json()) as { data: Array<{ timestamp: string }> }
      expect(body.data).toHaveLength(1)
      // Should be the last (most recent) item
      expect(body.data[0]!.timestamp).toBe('2026-01-03T00:00:00Z')
    })
  })

  describe('Cost trend with valid limit values', () => {
    it('GET /trends/cost?limit=2 returns exactly 2 most recent', async () => {
      await seedTrajectories()
      const res = await app.request('/api/learning/trends/cost?limit=2')
      const body = (await res.json()) as { data: Array<{ costCents: number }> }
      expect(body.data).toHaveLength(2)
    })

    it('GET /trends/cost?limit=100 with 3 items returns all 3', async () => {
      await seedTrajectories()
      const res = await app.request('/api/learning/trends/cost?limit=100')
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toHaveLength(3)
    })
  })
})
