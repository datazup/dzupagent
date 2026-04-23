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
 * POST /ingest             — persist learning patterns from `run:scored` context (Step 3)
 *
 * All data is read directly from the MemoryServiceLike store to avoid
 * a hard dependency on @dzupagent/agent.
 */
import { Hono } from 'hono'
import type { MemoryServiceLike } from '@dzupagent/memory-ipc'

export interface LearningRouteConfig {
  memoryService: MemoryServiceLike
  /** Default tenant ID when no auth middleware sets one. */
  defaultTenantId?: string
  /**
   * Minimum pattern confidence accepted by `POST /ingest`. Patterns below this
   * threshold are skipped. Defaults to `0.5`.
   */
  ingestConfidenceThreshold?: number
  /**
   * Default TTL (ms) applied to stored patterns. Persisted as `decay.ttlMs`
   * metadata on each memory item so downstream decay jobs can prune stale
   * entries. Defaults to 30 days.
   */
  ingestDefaultTtlMs?: number
}

/**
 * A generalizable pattern extracted from a scored run.
 * Shared shape across the `/ingest` route and `LearningEventProcessor`.
 */
export interface LearningPattern {
  /** Free-text summary of the learned pattern. */
  pattern: string
  /** Short contextual tag (e.g. tool name, phase, or category). */
  context: string
  /** Confidence score in the range [0, 1]. */
  confidence: number
}

/** Persist a single pattern into the `lessons` namespace with full provenance. */
export async function storeLearningPattern(
  memoryService: MemoryServiceLike,
  scope: Record<string, string>,
  pattern: LearningPattern,
  provenance: { runId: string; score: number; agentId?: string },
  ttlMs: number,
): Promise<string> {
  const key = `lesson-${provenance.runId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const now = Date.now()
  const record: Record<string, unknown> = {
    content: pattern.pattern,
    context: pattern.context,
    confidence: pattern.confidence,
    provenance: {
      runId: provenance.runId,
      score: provenance.score,
      ...(provenance.agentId !== undefined ? { agentId: provenance.agentId } : {}),
    },
    decay: {
      ttlMs,
      createdAt: now,
      expiresAt: now + ttlMs,
    },
    timestamp: new Date(now).toISOString(),
    // Legacy fields for compatibility with `/lessons` endpoint sort keys.
    importance: pattern.confidence,
    nodeId: pattern.context,
  }
  await memoryService.put('lessons', scope, key, record)
  return key
}

const DEFAULT_INGEST_THRESHOLD = 0.5
const DEFAULT_INGEST_TTL_MS = 30 * 24 * 60 * 60 * 1000

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
  const ingestThreshold = clamp01(
    typeof config.ingestConfidenceThreshold === 'number'
      ? config.ingestConfidenceThreshold
      : DEFAULT_INGEST_THRESHOLD,
  )
  const ingestTtlMs =
    typeof config.ingestDefaultTtlMs === 'number' && config.ingestDefaultTtlMs > 0
      ? config.ingestDefaultTtlMs
      : DEFAULT_INGEST_TTL_MS

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

  // ── POST /ingest — persist learning patterns (Step 3) ────────
  app.post('/ingest', async (c) => {
    const tenantId = getTenantId(c)
    const scope = tenantScope(tenantId)

    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ success: false, error: 'invalid JSON body' }, 400)
    }

    const runId = body['runId']
    const score = body['score']
    const patterns = body['patterns']
    const agentId = body['agentId']

    if (typeof runId !== 'string' || runId.length === 0) {
      return c.json(
        { success: false, error: 'runId is required and must be a non-empty string' },
        400,
      )
    }
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      return c.json(
        { success: false, error: 'score is required and must be a finite number' },
        400,
      )
    }
    if (!Array.isArray(patterns)) {
      return c.json(
        { success: false, error: 'patterns is required and must be an array' },
        400,
      )
    }

    const provenance: { runId: string; score: number; agentId?: string } = {
      runId,
      score,
      ...(typeof agentId === 'string' && agentId.length > 0 ? { agentId } : {}),
    }

    let stored = 0
    let skipped = 0
    const storedKeys: string[] = []
    const failures: string[] = []

    for (const raw of patterns) {
      if (!isLearningPattern(raw)) {
        skipped++
        continue
      }
      if (raw.confidence < ingestThreshold) {
        skipped++
        continue
      }
      try {
        const key = await storeLearningPattern(
          memoryService,
          scope,
          raw,
          provenance,
          ingestTtlMs,
        )
        stored++
        storedKeys.push(key)
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err))
      }
    }

    if (failures.length > 0 && stored === 0) {
      return c.json(
        {
          success: false,
          error: `memory service failed for all patterns: ${failures[0]}`,
          stored,
          skipped,
        },
        500,
      )
    }

    return c.json({
      success: true,
      stored,
      skipped,
      keys: storedKeys,
      ...(failures.length > 0 ? { warnings: failures } : {}),
    })
  })

  return app
}

// ---------------------------------------------------------------------------
// Shared helpers (exported for the LearningEventProcessor)
// ---------------------------------------------------------------------------

/** Runtime validator for a `LearningPattern` shape. */
export function isLearningPattern(value: unknown): value is LearningPattern {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj['pattern'] === 'string' &&
    obj['pattern'].length > 0 &&
    typeof obj['context'] === 'string' &&
    typeof obj['confidence'] === 'number' &&
    Number.isFinite(obj['confidence'])
  )
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INGEST_THRESHOLD
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}
