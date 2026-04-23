/**
 * Enrichment metrics route — Wave H.
 *
 * GET /:id/enrichment-metrics — Returns per-phase timing metrics captured
 * during the most recent EnrichmentPipeline.apply() invocation (skills,
 * memory, promptShaping). Phases that were skipped are absent from the
 * response payload.
 *
 * The response shape mirrors `EnrichmentPipeline.metrics()` and is stable
 * for downstream consumers (dashboards, OTel exporters, replay viewers).
 */
import { Hono } from 'hono'
import { EnrichmentPipeline } from '@dzupagent/agent-adapters'
import type { ForgeServerConfig } from '../app.js'
import type { AppEnv } from '../types.js'

export function createEnrichmentMetricsRoute(
  config: Pick<ForgeServerConfig, 'runStore'>,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const { runStore } = config

  app.get('/:id/enrichment-metrics', async (c) => {
    const runId = c.req.param('id')

    try {
      const run = await runStore.get(runId)
      if (!run) {
        return c.json(
          { error: { code: 'RUN_NOT_FOUND', message: `Run '${runId}' not found` } },
          404,
        )
      }

      const metrics = EnrichmentPipeline.metrics()
      return c.json({ data: metrics }, 200)
    } catch {
      return c.json(
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to read enrichment metrics',
          },
        },
        500,
      )
    }
  })

  return app
}
