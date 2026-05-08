/**
 * Feedback recording, feedback statistics, and skill-pack management handlers
 * for the learning routes. Registered onto an existing Hono instance by
 * `createLearningRoutes`.
 */
import type { Hono } from 'hono'
import type { MemoryServiceLike } from '@dzupagent/memory-ipc'
import type { AppEnv } from '../types.js'
import {
  FeedbackSchema,
  SkillPackLoadSchema,
  resolveTenantId,
  tenantScope,
} from './learning-schemas.js'

export interface FeedbackHandlerDeps {
  memoryService: MemoryServiceLike
  defaultTenantId: string
}

export function registerFeedbackHandlers(
  app: Hono<AppEnv>,
  deps: FeedbackHandlerDeps,
): void {
  const { memoryService, defaultTenantId } = deps

  // ── POST /feedback — record user feedback ────────────────────
  app.post('/feedback', async (c) => {
    const tenantId = resolveTenantId(c, defaultTenantId)
    const scope = tenantScope(tenantId)

    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      return c.json({ success: false, error: 'invalid JSON body' }, 400)
    }
    const parsed = FeedbackSchema.safeParse(rawBody)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      const field = first?.path.join('.') ?? 'body'
      return c.json({ success: false, error: `${field}: ${first?.message ?? 'invalid'}` }, 400)
    }
    const body = parsed.data

    try {
      const feedbackKey = `feedback-${body.runId}-${Date.now()}`
      await memoryService.put('feedback', scope, feedbackKey, {
        runId: body.runId,
        type: typeof body.type === 'string' ? body.type : 'general',
        approved: body.approved,
        feedback: typeof body.feedback === 'string' ? body.feedback : undefined,
        featureCategory:
          typeof body.featureCategory === 'string' ? body.featureCategory : undefined,
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
    const tenantId = resolveTenantId(c, defaultTenantId)
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
    const tenantId = resolveTenantId(c, defaultTenantId)
    const scope = tenantScope(tenantId)

    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      return c.json({ success: false, error: 'invalid JSON body' }, 400)
    }
    const parsed = SkillPackLoadSchema.safeParse(rawBody)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      const field = first?.path.join('.') ?? 'packIds'
      return c.json({ success: false, error: `${field}: ${first?.message ?? 'invalid'}` }, 400)
    }
    const body = parsed.data

    try {
      const loaded: string[] = []
      for (const item of body.packIds) {
        if (typeof item !== 'string') continue
        await memoryService.put('packs_loaded', scope, item, {
          packId: item,
          loadedAt: new Date().toISOString(),
        })
        loaded.push(item)
      }

      return c.json({ success: true, result: { loaded } })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ success: false, error: message }, 500)
    }
  })

  // ── GET /skill-packs — list loaded skill pack IDs ────────────
  app.get('/skill-packs', async (c) => {
    const tenantId = resolveTenantId(c, defaultTenantId)
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
}
