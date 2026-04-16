/**
 * REST task lifecycle routes: create, get, list, cancel.
 */
import { Hono } from 'hono'
import type { A2ATaskState } from '../../a2a/task-handler.js'
import type { A2ARoutesConfig } from './helpers.js'

export function registerTaskRoutes(app: Hono, config: A2ARoutesConfig): void {
  // --- Submit task ---
  app.post('/a2a/tasks', async (c) => {
    const body = await c.req.json<{
      agentName: string
      input: unknown
      metadata?: Record<string, unknown>
    }>()

    if (!body.agentName || body.input === undefined) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'agentName and input are required' } },
        400,
      )
    }

    // Verify the agent name is in the card's capabilities
    const known = config.agentCard.capabilities.some((cap) => cap.name === body.agentName)
    if (!known) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: `Unknown agent: ${body.agentName}` } },
        404,
      )
    }

    const task = await config.taskStore.create({
      agentName: body.agentName,
      input: body.input,
      state: 'submitted',
      metadata: body.metadata,
    })

    if (config.onTaskSubmitted) {
      // Fire-and-forget — caller polls for result
      config.onTaskSubmitted(task).catch(() => {
        void config.taskStore.update(task.id, {
          state: 'failed',
          error: 'Task execution callback failed',
        })
      })
    }

    return c.json(task, 201)
  })

  // --- Get task ---
  app.get('/a2a/tasks/:id', async (c) => {
    const task = await config.taskStore.get(c.req.param('id'))
    if (!task) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Task not found' } },
        404,
      )
    }
    return c.json(task)
  })

  // --- List tasks ---
  app.get('/a2a/tasks', async (c) => {
    const agentName = c.req.query('agentName')
    const state = c.req.query('state') as A2ATaskState | undefined
    const tasks = await config.taskStore.list({
      agentName: agentName ?? undefined,
      state: state ?? undefined,
    })
    return c.json({ tasks })
  })

  // --- Cancel task ---
  app.post('/a2a/tasks/:id/cancel', async (c) => {
    const task = await config.taskStore.get(c.req.param('id'))
    if (!task) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Task not found' } },
        404,
      )
    }

    const terminal: A2ATaskState[] = ['completed', 'failed', 'cancelled']
    if (terminal.includes(task.state)) {
      return c.json(
        { error: { code: 'CONFLICT', message: `Task already in terminal state: ${task.state}` } },
        409,
      )
    }

    const updated = await config.taskStore.update(task.id, { state: 'cancelled' })
    return c.json(updated)
  })
}
