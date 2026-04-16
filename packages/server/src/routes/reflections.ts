/**
 * Reflection HTTP routes — list, get, and query patterns from run reflections.
 *
 * Reflections are read-only from the HTTP perspective (created by the
 * run-worker after each completed run). These routes expose the stored
 * ReflectionSummary data for dashboards and analysis.
 */
import { Hono } from 'hono'
import type { RunReflectionStore, ReflectionPattern } from '@dzupagent/agent'

export interface ReflectionRouteConfig {
  reflectionStore: RunReflectionStore
}

const VALID_PATTERN_TYPES = new Set<ReflectionPattern['type']>([
  'repeated_tool',
  'error_loop',
  'successful_strategy',
  'slow_step',
])

export function createReflectionRoutes(config: ReflectionRouteConfig): Hono {
  const app = new Hono()

  // --- List reflections ---
  app.get('/', async (c) => {
    const limitParam = c.req.query('limit')
    let limit = 20
    if (limitParam !== undefined) {
      const parsed = parseInt(limitParam, 10)
      if (!Number.isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 100)
      }
    }

    const reflections = await config.reflectionStore.list(limit)
    return c.json({ reflections })
  })

  // --- Get patterns by type ---
  // NOTE: This route must be registered BEFORE /:runId to avoid
  // "patterns" being interpreted as a runId parameter.
  app.get('/patterns/:type', async (c) => {
    const type = c.req.param('type') as ReflectionPattern['type']

    if (!VALID_PATTERN_TYPES.has(type)) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: `Invalid pattern type: ${type}. Valid types: ${[...VALID_PATTERN_TYPES].join(', ')}` } },
        400,
      )
    }

    const patterns = await config.reflectionStore.getPatterns(type)
    return c.json({ patterns })
  })

  // --- Get single reflection by runId ---
  app.get('/:runId', async (c) => {
    const runId = c.req.param('runId')
    const reflection = await config.reflectionStore.get(runId)

    if (!reflection) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Reflection not found' } },
        404,
      )
    }

    return c.json(reflection)
  })

  return app
}
