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
import { requireOwnedRun } from './run-guard.js'

export function createEnrichmentMetricsRoute(
  config: Pick<ForgeServerConfig, 'runStore'>,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const { runStore } = config

  app.get('/:id/enrichment-metrics', async (c) => {
    const runId = c.req.param('id')

    try {
      // MJ-SEC-02: shared owner/tenant guard. Returns 404 (not 403) on
      // cross-owner access to prevent enumeration of foreign run ids.
      const run = await requireOwnedRun(c, runId, runStore)
      if (run instanceof Response) return run

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
