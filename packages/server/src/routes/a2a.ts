/**
 * A2A protocol routes.
 *
 * - `GET  /.well-known/agent.json` — Agent card discovery
 * - `POST /a2a/tasks`              — Submit a new task
 * - `GET  /a2a/tasks/:id`          — Poll task status / result
 * - `GET  /a2a/tasks`              — List tasks (filter by agentName, state)
 * - `POST /a2a/tasks/:id/cancel`   — Cancel a running task
 */
import { Hono } from 'hono'
import type { AgentCard } from '../a2a/agent-card.js'
import type { A2ATask, A2ATaskState, A2ATaskStore } from '../a2a/task-handler.js'

export interface A2ARoutesConfig {
  agentCard: AgentCard
  taskStore: A2ATaskStore
  /** Called after a task is created so the host can start execution. */
  onTaskSubmitted?: (task: A2ATask) => Promise<void>
}

export function createA2ARoutes(config: A2ARoutesConfig): Hono {
  const app = new Hono()

  // --- Agent card discovery ---
  app.get('/.well-known/agent.json', (c) => {
    return c.json(config.agentCard)
  })

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

  return app
}
