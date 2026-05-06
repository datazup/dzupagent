/**
 * Run management routes — router only.
 *
 * Endpoint inventory:
 *
 *   POST /api/runs                — Trigger a new run
 *   GET  /api/runs                — List runs (filter by agent, status)
 *   GET  /api/runs/:id            — Get run details
 *   POST /api/runs/:id/cancel     — Cancel a running execution
 *   POST /api/runs/:id/pause      — Cooperatively pause a running execution
 *   POST /api/runs/:id/resume     — Resume a paused/suspended execution
 *   POST /api/runs/:id/fork       — Fork a run from a checkpoint step
 *   GET  /api/runs/:id/checkpoints — List available checkpoints for a run
 *   GET  /api/runs/:id/logs       — Get run logs
 *   GET  /api/runs/:id/trace      — Execution trace with events + usage summary
 *   GET  /api/runs/:id/stream     — SSE stream of run events
 *
 * Each handler is implemented under `./runs/`. This file is intentionally a
 * thin Hono wiring layer (RF-22) so the registration block can be scanned at
 * a glance and individual handlers remain unit-testable in isolation.
 *
 * Owner scoping (RF-S02): when a run has a non-null `ownerId` and the caller
 * presents a different `apiKey.id`, read/write handlers return 404 as if the
 * run did not exist. The NOT_FOUND shape prevents leaking existence of other
 * tenants' runs via status code probing.
 */
import { Hono } from 'hono'

import type { ForgeServerConfig } from '../composition/types.js'
import type { AppEnv } from '../types.js'
import { handleCreateRun } from './runs/create-handler.js'
import {
  handleGetRun,
  handleGetLogs,
  handleGetTrace,
  handleListCheckpoints,
  handleListRuns,
} from './runs/list-handler.js'
import {
  handleCancelRun,
  handleForkRun,
  handlePauseRun,
  handleResumeRun,
} from './runs/control-handler.js'
import { handleStreamRun } from './runs/stream-handler.js'

/**
 * Register all run routes on a new Hono sub-app. Each endpoint delegates to a
 * named handler from `./runs/*` — the factory itself carries no business logic
 * beyond wiring.
 */
export function createRunRoutes(config: ForgeServerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.post('/', (c) => handleCreateRun(c, config))
  app.get('/', (c) => handleListRuns(c, config))
  app.get('/:id', (c) => handleGetRun(c, config))
  app.post('/:id/cancel', (c) => handleCancelRun(c, config))
  app.post('/:id/pause', (c) => handlePauseRun(c, config))
  app.post('/:id/resume', (c) => handleResumeRun(c, config))
  app.post('/:id/fork', (c) => handleForkRun(c, config))
  app.get('/:id/checkpoints', (c) => handleListCheckpoints(c, config))
  app.get('/:id/logs', (c) => handleGetLogs(c, config))
  app.get('/:id/trace', (c) => handleGetTrace(c, config))
  app.get('/:id/stream', (c) => handleStreamRun(c, config))
  return app
}
