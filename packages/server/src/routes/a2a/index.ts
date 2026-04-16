/**
 * A2A protocol routes — barrel module.
 *
 * Assembles all sub-routers into a single Hono app that is
 * backward-compatible with the original monolithic a2a.ts.
 *
 * REST endpoints:
 * - `GET  /.well-known/agent.json` — Agent card discovery
 * - `POST /a2a/tasks`              — Submit a new task
 * - `GET  /a2a/tasks/:id`          — Poll task status / result
 * - `GET  /a2a/tasks`              — List tasks (filter by agentName, state)
 * - `POST /a2a/tasks/:id/cancel`   — Cancel a running task
 * - `POST /a2a/tasks/:id/messages` — Append message (multi-turn)
 *
 * JSON-RPC 2.0 endpoint:
 * - `POST /a2a`                    — JSON-RPC 2.0 (single + batch)
 */
import { Hono } from 'hono'
import type { A2ARoutesConfig } from './helpers.js'
import { registerWellKnownRoutes } from './well-known.js'
import { registerTaskRoutes } from './task-routes.js'
import { registerMessageRoutes } from './message-routes.js'
import { registerJsonRpcRoute } from './jsonrpc-route.js'

export type { A2ARoutesConfig } from './helpers.js'

export function createA2ARoutes(config: A2ARoutesConfig): Hono {
  const app = new Hono()

  registerJsonRpcRoute(app, config)
  registerWellKnownRoutes(app, config)
  registerTaskRoutes(app, config)
  registerMessageRoutes(app, config)

  return app
}
