/**
 * Learning REST API routes — HTTP endpoints for self-learning dashboard and management.
 *
 * GET  /dashboard          — full dashboard from store namespaces
 * GET  /overview           — lightweight overview (counts only)
 * GET  /trends/quality     — quality trend (query: ?limit=20)
 * GET  /trends/cost        — cost trend (query: ?limit=20)
 * GET  /nodes              — per-node performance summaries
 * POST /feedback           — record user feedback
 * GET  /feedback/stats     — feedback statistics
 * POST /skill-packs/load   — load built-in skill packs
 * GET  /skill-packs        — list loaded skill pack IDs
 * GET  /lessons            — get top lessons (query: ?limit=10&nodeId=&taskType=)
 * GET  /rules              — get top rules (query: ?limit=10)
 *
 * All data is read directly from the MemoryServiceLike store to avoid
 * a hard dependency on @forgeagent/agent.
 */
import { Hono } from 'hono'
import type { MemoryServiceLike } from '@forgeagent/memory-ipc'

export interface LearningRouteConfig {
  memoryService: MemoryServiceLike
  /** Default tenant ID when no auth middleware sets one. */
  defaultTenantId?: string
}

/** Settled result value or empty array on rejection. */
function settledValue<T>(result: PromiseSettledResult<T[]>): T[] {
  return result.status === 'fulfilled' ? result.value : []
}

/** Parse a positive integer from a query string, returning `fallback` on failure. */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = parseInt(value, 10)
  return isNaN(n) || n <= 0 ? fallback : n
}

/** Build the scope object for a given tenant. */
function tenantScope(tenantId: string): Record<string, string> {
  return tenantId ? { tenantId } : {}
}

export function createLearningRoutes(config: LearningRouteConfig): Hono {
  const app = new Hono()
  const { memoryService, defaultTenantId = 'default' } = config

  /**
   * Resolve tenantId — check Hono context variable first, fall back to config.
   * The auth middleware may set `tenantId` on the context.
   */
  function getTenantId(c: { get(key: string): unknown }): string {
    const fromCtx = c.get('tenantId')
    return typeof fromCtx === 'string' && fromCtx.length > 0 ? fromCtx : defaultTenantId
  }

  // ── GET /dashboard — full dashboard ──────────────────────────
  app.get('/dashboard', async (c) => {
    const tenantId = getTenantId(c)
    const scope = tenantScope(tenantId)

    try {
      const [lessons, rules, skills, trajectories, feedback, packsLoaded, errors] =
        await Promise.allSettled([
          memoryService.search('lessons', scope, '', 1000),
          memoryService.search('rules', scope, '', 1000),
          memoryService.search('skills', scope, '', 1000),
          memoryService.search('trajectories', scope, '', 1000),
          memoryService.search('feedback', scope, '', 1000),
          memoryService.search('packs_loaded', scope, '', 1000),
          memoryService.search('errors', scope, '', 1000),
        ])

      const lessonsArr = settledValue(lessons)
      const rulesArr = settledValue(rules)
      const skillsArr = settledValue(skills)
      const trajectoriesArr = settledValue(trajectories)
      const feedbackArr = settledValue(feedback)
      const packsArr = settledValue(packsLoaded)
      const errorsArr = settledValue(errors)

      // Compute quality trend from trajectories
      const qualityTrend = trajectoriesArr
        .filter((t) => typeof t['qualityScore'] === 'number')
        .sort((a, b) => {
          const ta = typeof a['timestamp'] === 'string' ? a['timestamp'] : ''
          const tb = typeof b['timestamp'] === 'string' ? b['timestamp'] : ''
          return ta.localeCompare(tb)
        })
        .slice(-20)
        .map((t) => ({
          timestamp: t['timestamp'] ?? null,
          score: t['qualityScore'] ?? null,
          nodeId: t['nodeId'] ?? null,
        }))

      // Compute cost trend from trajectories
      const costTrend = trajectoriesArr
        .filter((t) => typeof t['costCents'] === 'number')
        .sort((a, b) => {
          const ta = typeof a['timestamp'] === 'string' ? a['timestamp'] : ''
          const tb = typeof b['timestamp'] === 'string' ? b['timestamp'] : ''
          return ta.localeCompare(tb)
        })
        .slice(-20)
        .map((t) => ({
          timestamp: t['timestamp'] ?? null,
          costCents: t['costCents'] ?? null,
          nodeId: t['nodeId'] ?? null,
        }))

      // Feedback stats
      const approvedCount = feedbackArr.filter((f) => f['approved'] === true).length
      const rejectedCount = feedbackArr.filter((f) => f['approved'] === false).length

      return c.json({
        success: true,
        data: {
          lessonCount: lessonsArr.length,
          ruleCount: rulesArr.length,
          skillCount: skillsArr.length,
          trajectoryCount: trajectoriesArr.length,
          feedbackCount: feedbackArr.length,
          packCount: packsArr.length,
          errorCount: errorsArr.length,
          lessons: lessonsArr.slice(0, 20),
          rules: rulesArr.slice(0, 20),
          skills: skillsArr.slice(0, 20),
          qualityTrend,
          costTrend,
          feedbackStats: {
            total: feedbackArr.length,
            approved: approvedCount,
            rejected: rejectedCount,
          },
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ success: false, error: message }, 500)
    }
  })

  // ── GET /overview — lightweight overview ─────────────────────
  app.get('/overview', async (c) => {
    const tenantId = getTenantId(c)
    const scope = tenantScope(tenantId)

    try {
      const [lessons, rules, skills] = await Promise.allSettled([
        memoryService.search('lessons', scope, '', 1000),
        memoryService.search('rules', scope, '', 1000),
        memoryService.search('skills', scope, '', 1000),
      ])

      return c.json({
        success: true,
        data: {
          lessonCount: settledValue(lessons).length,
          ruleCount: settledValue(rules).length,
          skillCount: settledValue(skills).length,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ success: false, error: message }, 500)
    }
  })

  // ── GET /trends/quality — quality trend ──────────────────────
  app.get('/trends/quality', async (c) => {
    const tenantId = getTenantId(c)
    const scope = tenantScope(tenantId)
    const limit = parsePositiveInt(c.req.query('limit'), 20)

    try {
      const trajectories = await memoryService.search('trajectories', scope, '', 10000)

      const trend = trajectories
        .filter((t) => typeof t['qualityScore'] === 'number')
        .sort((a, b) => {
          const ta = typeof a['timestamp'] === 'string' ? a['timestamp'] : ''
          const tb = typeof b['timestamp'] === 'string' ? b['timestamp'] : ''
          return ta.localeCompare(tb)
        })
        .slice(-limit)
        .map((t) => ({
          timestamp: t['timestamp'] ?? null,
          score: t['qualityScore'] ?? null,
          nodeId: t['nodeId'] ?? null,
          runId: t['runId'] ?? null,
        }))

      return c.json({ success: true, data: trend })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ success: false, error: message }, 500)
    }
  })

  // ── GET /trends/cost — cost trend ────────────────────────────
  app.get('/trends/cost', async (c) => {
    const tenantId = getTenantId(c)
    const scope = tenantScope(tenantId)
    const limit = parsePositiveInt(c.req.query('limit'), 20)

    try {
      const trajectories = await memoryService.search('trajectories', scope, '', 10000)

      const trend = trajectories
        .filter((t) => typeof t['costCents'] === 'number')
        .sort((a, b) => {
          const ta = typeof a['timestamp'] === 'string' ? a['timestamp'] : ''
          const tb = typeof b['timestamp'] === 'string' ? b['timestamp'] : ''
          return ta.localeCompare(tb)
        })
        .slice(-limit)
        .map((t) => ({
          timestamp: t['timestamp'] ?? null,
          costCents: t['costCents'] ?? null,
          nodeId: t['nodeId'] ?? null,
          runId: t['runId'] ?? null,
        }))

      return c.json({ success: true, data: trend })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ success: false, error: message }, 500)
    }
  })

  // ── GET /nodes — per-node performance summaries ──────────────
  app.get('/nodes', async (c) => {
    const tenantId = getTenantId(c)
    const scope = tenantScope(tenantId)

    try {
      const trajectories = await memoryService.search('trajectories', scope, '', 10000)

      // Group by nodeId
      const nodeMap = new Map<string, { scores: number[]; costs: number[]; count: number }>()

      for (const t of trajectories) {
        const nodeId = typeof t['nodeId'] === 'string' ? t['nodeId'] : 'unknown'
        let entry = nodeMap.get(nodeId)
        if (!entry) {
          entry = { scores: [], costs: [], count: 0 }
          nodeMap.set(nodeId, entry)
        }
        entry.count++
        if (typeof t['qualityScore'] === 'number') {
          entry.scores.push(t['qualityScore'])
        }
        if (typeof t['costCents'] === 'number') {
          entry.costs.push(t['costCents'])
        }
      }

      const nodes = Array.from(nodeMap.entries()).map(([nodeId, entry]) => {
        const avgScore =
          entry.scores.length > 0
            ? entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length
            : null
        const totalCost =
          entry.costs.length > 0 ? entry.costs.reduce((a, b) => a + b, 0) : 0

        return {
          nodeId,
          runCount: entry.count,
          avgQualityScore: avgScore !== null ? Math.round(avgScore * 100) / 100 : null,
          totalCostCents: Math.round(totalCost * 100) / 100,
        }
      })

      return c.json({ success: true, data: nodes })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ success: false, error: message }, 500)
    }
  })

  // ── POST /feedback — record user feedback ────────────────────
  app.post('/feedback', async (c) => {
    const tenantId = getTenantId(c)
    const scope = tenantScope(tenantId)

    try {
      const body = (await c.req.json()) as Record<string, unknown>

      const runId = body['runId']
      const type = body['type']
      const approved = body['approved']

      if (typeof runId !== 'string' || runId.length === 0) {
        return c.json(
          { success: false, error: 'runId is required and must be a non-empty string' },
          400,
        )
      }
      if (typeof approved !== 'boolean') {
        return c.json(
          { success: false, error: 'approved is required and must be a boolean' },
          400,
        )
      }

      const feedbackKey = `feedback-${runId}-${Date.now()}`
      await memoryService.put('feedback', scope, feedbackKey, {
        runId,
        type: typeof type === 'string' ? type : 'general',
        approved,
        feedback: typeof body['feedback'] === 'string' ? body['feedback'] : undefined,
        featureCategory:
          typeof body['featureCategory'] === 'string' ? body['featureCategory'] : undefined,
        timestamp: new Date().toISOString(),
      })

      return c.json({ success: true, result: { key: feedbackKey } })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ success: false, error: message }, 500)
    }
  })

  // ── GET /feedback/stats — feedback statistics ────────────────
  app.get('/feedback/stats', async (c) => {
    const tenantId = getTenantId(c)
    const scope = tenantScope(tenantId)

    try {
      const feedbackArr = await memoryService.search('feedback', scope, '', 10000)

      const approvedCount = feedbackArr.filter((f) => f['approved'] === true).length
      const rejectedCount = feedbackArr.filter((f) => f['approved'] === false).length

      // Group by type
      const byType = new Map<string, { approved: number; rejected: number }>()
      for (const f of feedbackArr) {
        const type = typeof f['type'] === 'string' ? f['type'] : 'general'
        let entry = byType.get(type)
        if (!entry) {
          entry = { approved: 0, rejected: 0 }
          byType.set(type, entry)
        }
        if (f['approved'] === true) entry.approved++
        else entry.rejected++
      }

      return c.json({
        success: true,
        data: {
          total: feedbackArr.length,
          approved: approvedCount,
          rejected: rejectedCount,
          approvalRate:
            feedbackArr.length > 0
              ? Math.round((approvedCount / feedbackArr.length) * 10000) / 100
              : 0,
          byType: Object.fromEntries(byType),
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ success: false, error: message }, 500)
    }
  })

  // ── POST /skill-packs/load — load built-in skill packs ──────
  app.post('/skill-packs/load', async (c) => {
    const tenantId = getTenantId(c)
    const scope = tenantScope(tenantId)

    try {
      const body = (await c.req.json()) as Record<string, unknown>
      const packIds = body['packIds']

      if (!Array.isArray(packIds) || packIds.length === 0) {
        return c.json(
          { success: false, error: 'packIds is required and must be a non-empty array' },
          400,
        )
      }

      const loaded: string[] = []
      for (const packId of packIds) {
        if (typeof packId !== 'string') continue
        await memoryService.put('packs_loaded', scope, packId, {
          packId,
          loadedAt: new Date().toISOString(),
        })
        loaded.push(packId)
      }

      return c.json({ success: true, result: { loaded } })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ success: false, error: message }, 500)
    }
  })

  // ── GET /skill-packs — list loaded skill pack IDs ────────────
  app.get('/skill-packs', async (c) => {
    const tenantId = getTenantId(c)
    const scope = tenantScope(tenantId)

    try {
      const packs = await memoryService.search('packs_loaded', scope, '', 1000)
      const packIds = packs
        .map((p) => (typeof p['packId'] === 'string' ? p['packId'] : null))
        .filter((id): id is string => id !== null)

      return c.json({ success: true, data: packIds })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ success: false, error: message }, 500)
    }
  })

  // ── GET /lessons — get top lessons ───────────────────────────
  app.get('/lessons', async (c) => {
    const tenantId = getTenantId(c)
    const scope = tenantScope(tenantId)
    const limit = parsePositiveInt(c.req.query('limit'), 10)
    const nodeId = c.req.query('nodeId')
    const taskType = c.req.query('taskType')

    try {
      const lessons = await memoryService.search('lessons', scope, '', 10000)

      let filtered = lessons
      if (nodeId) {
        filtered = filtered.filter((l) => l['nodeId'] === nodeId)
      }
      if (taskType) {
        filtered = filtered.filter((l) => l['taskType'] === taskType)
      }

      // Sort by importance descending (if available)
      filtered.sort((a, b) => {
        const ia = typeof a['importance'] === 'number' ? a['importance'] : 0
        const ib = typeof b['importance'] === 'number' ? b['importance'] : 0
        return ib - ia
      })

      return c.json({ success: true, data: filtered.slice(0, limit) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ success: false, error: message }, 500)
    }
  })

  // ── GET /rules — get top rules ───────────────────────────────
  app.get('/rules', async (c) => {
    const tenantId = getTenantId(c)
    const scope = tenantScope(tenantId)
    const limit = parsePositiveInt(c.req.query('limit'), 10)

    try {
      const rules = await memoryService.search('rules', scope, '', 10000)

      // Sort by priority descending (if available)
      rules.sort((a, b) => {
        const pa = typeof a['priority'] === 'number' ? a['priority'] : 0
        const pb = typeof b['priority'] === 'number' ? b['priority'] : 0
        return pb - pa
      })

      return c.json({ success: true, data: rules.slice(0, limit) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ success: false, error: message }, 500)
    }
  })

  return app
}
