/**
 * Run trace routes — step-by-step message replay for debugging.
 *
 * GET /api/runs/:id/messages          — full trace (all steps)
 * GET /api/runs/:id/messages?from=&to= — paginated step range
 */
import { Hono } from 'hono'
import type { RunStore } from '@forgeagent/core'
import type { RunTraceStore } from '../persistence/run-trace-store.js'
import { computeStepDistribution } from '../persistence/run-trace-store.js'

export interface RunTraceRouteConfig {
  runStore: RunStore
  traceStore: RunTraceStore
}

export function createRunTraceRoutes(config: RunTraceRouteConfig): Hono {
  const app = new Hono()
  const { runStore, traceStore } = config

  // GET /api/runs/:id/messages — full trace or paginated range
  app.get('/:id/messages', async (c) => {
    const runId = c.req.param('id')

    // Validate that the run exists
    const run = await runStore.get(runId)
    if (!run) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Run not found' } },
        404,
      )
    }

    const trace = traceStore.getTrace(runId)
    if (!trace) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Trace not found for this run' } },
        404,
      )
    }

    const fromParam = c.req.query('from')
    const toParam = c.req.query('to')

    // Paginated range
    if (fromParam !== undefined || toParam !== undefined) {
      const from = parseInt(fromParam ?? '0', 10)
      const to = parseInt(toParam ?? String(trace.totalSteps), 10)

      if (Number.isNaN(from) || Number.isNaN(to)) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: 'from and to must be integers' } },
          400,
        )
      }

      const steps = traceStore.getSteps(runId, from, to)
      const distribution = computeStepDistribution(steps)

      return c.json({
        data: {
          runId: trace.runId,
          agentId: trace.agentId,
          steps,
          totalSteps: trace.totalSteps,
          range: { from, to },
          distribution,
          startedAt: trace.startedAt,
          completedAt: trace.completedAt,
        },
      })
    }

    // Full trace
    const distribution = computeStepDistribution(trace.steps)

    return c.json({
      data: {
        runId: trace.runId,
        agentId: trace.agentId,
        steps: trace.steps,
        totalSteps: trace.totalSteps,
        distribution,
        startedAt: trace.startedAt,
        completedAt: trace.completedAt,
      },
    })
  })

  return app
}
