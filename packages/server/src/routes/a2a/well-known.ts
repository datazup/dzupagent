/**
 * Agent card discovery route: GET /.well-known/agent.json
 */
import { Hono } from 'hono'
import type { A2ARoutesConfig } from './helpers.js'

export function registerWellKnownRoutes(app: Hono, config: A2ARoutesConfig): void {
  app.get('/.well-known/agent.json', (c) => {
    return c.json(config.agentCard)
  })
}
