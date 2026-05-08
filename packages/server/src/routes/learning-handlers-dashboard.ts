/**
 * Dashboard, overview, trend, and per-node summary handlers for the learning
 * routes. Registered onto an existing Hono instance by `createLearningRoutes`.
 */
import type { Hono } from 'hono'
import type { MemoryServiceLike } from '@dzupagent/memory-ipc'
import type { AppEnv } from '../types.js'
import { parsePositiveInt, resolveTenantId, settledValue, tenantScope } from './learning-schemas.js'

export interface DashboardHandlerDeps {
  memoryService: MemoryServiceLike
  defaultTenantId: string
}

export function registerDashboardHandlers(
  app: Hono<AppEnv>,
  deps: DashboardHandlerDeps,
): void {
  const { memoryService, defaultTenantId } = deps

  // ── GET /dashboard — full dashboard ──────────────────────────
  app.get('/dashboard', async (c) => {
    const tenantId = resolveTenantId(c, defaultTenantId)
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
    const tenantId = resolveTenantId(c, defaultTenantId)
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
    const tenantId = resolveTenantId(c, defaultTenantId)
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
    const tenantId = resolveTenantId(c, defaultTenantId)
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
    const tenantId = resolveTenantId(c, defaultTenantId)
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
}
