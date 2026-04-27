/**
 * Run trace routes — step-by-step message replay for debugging.
 *
 * GET /api/runs/:id/messages          — full trace (all steps)
 * GET /api/runs/:id/messages?from=&to= — paginated step range
 */
import { Hono } from 'hono'
import type { RunStore } from '@dzupagent/core'
import type { RunTraceStore } from '../persistence/run-trace-store.js'
import { computeStepDistribution } from '../persistence/run-trace-store.js'
import { requireOwnedRun } from './run-guard.js'

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

    // MJ-SEC-02: shared owner/tenant guard. Returns 404 (not 403) on
    // cross-owner access to prevent enumeration of foreign run ids.
    const ownedRun = await requireOwnedRun(c, runId, runStore)
    if (ownedRun instanceof Response) return ownedRun

    // Await to support both sync (InMemory) and async (Drizzle) implementations.
    const trace = await traceStore.getTrace(runId)
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

      const steps = await traceStore.getSteps(runId, from, to)
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
