/**
 * Multi-turn message route: POST /a2a/tasks/:id/messages
 *
 * RF-SEC-05: messages can only be appended to tasks the caller owns.
 * Cross-owner attempts return 404 to avoid existence enumeration.
 */
import type { Hono } from 'hono'
import type { A2ARoutesConfig } from './helpers.js'
import { callerOwnsTask, getCallerScope } from './helpers.js'

export function registerMessageRoutes(app: Hono, config: A2ARoutesConfig): void {
  app.post('/a2a/tasks/:id/messages', async (c) => {
    const taskId = c.req.param('id')
    const body = await c.req.json<{ role: string; parts: Array<{ type: string; text?: string; data?: Record<string, unknown> }> }>()

    if (!body.role || !Array.isArray(body.parts)) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'role and parts are required' } },
        400,
      )
    }

    const scope = getCallerScope(c)
    const task = await config.taskStore.get(taskId)
    if (!task || !callerOwnsTask(scope, task)) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Task not found' } },
        404,
      )
    }

    const updated = await config.taskStore.appendMessage(taskId, {
      role: body.role as 'user' | 'agent',
      parts: body.parts,
    })

    return c.json(updated)
  })
}
