/**
 * REST task lifecycle routes: create, get, list, cancel.
 *
 * RF-SEC-05: every handler enforces the authenticated caller's scope. Tasks
 * are stamped with `ownerId` + `tenantId` on creation; subsequent reads,
 * lists, and cancellations are filtered by the same fields. Cross-owner
 * accesses surface as 404 (not 403) to avoid existence enumeration.
 */
import type { Hono } from 'hono'
import type { A2ATaskState } from '../../a2a/task-handler.js'
import type { A2ARoutesConfig } from './helpers.js'
import { callerOwnsTask, getCallerScope } from './helpers.js'

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

    // RF-SEC-05: stamp the owning API key + tenant on creation so the rest
    // of the lifecycle can reject cross-caller access. When auth is
    // disabled both fields are `undefined` and the store records null —
    // preserving the library default that every caller can read every task.
    const scope = getCallerScope(c)

    const task = await config.taskStore.create({
      agentName: body.agentName,
      input: body.input,
      state: 'submitted',
      metadata: body.metadata,
      ownerId: scope.ownerId ?? null,
      tenantId: scope.tenantId ?? null,
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
    const scope = getCallerScope(c)
    const task = await config.taskStore.get(c.req.param('id'))
    // RF-SEC-05: a missing record and a cross-owner record both produce the
    // same NOT_FOUND response so an attacker cannot enumerate task ids.
    if (!task || !callerOwnsTask(scope, task)) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Task not found' } },
        404,
      )
    }
    return c.json(task)
  })

  // --- List tasks ---
  app.get('/a2a/tasks', async (c) => {
    const scope = getCallerScope(c)
    const agentName = c.req.query('agentName')
    const state = c.req.query('state') as A2ATaskState | undefined

    const tasks = await config.taskStore.list({
      agentName: agentName ?? undefined,
      state: state ?? undefined,
      // RF-SEC-05: scope filtering is applied at the store layer when the
      // caller is authenticated. Unauthenticated callers see the un-scoped
      // listing (legacy single-tenant default).
      ...(scope.ownerId !== undefined ? { ownerId: scope.ownerId } : {}),
      ...(scope.tenantId !== undefined ? { tenantId: scope.tenantId } : {}),
    })

    // Defensive double-filter: if a custom store ignores ownerId, the
    // route still drops cross-owner rows before responding.
    const visible = tasks.filter((t) => callerOwnsTask(scope, t))

    return c.json({ tasks: visible })
  })

  // --- Cancel task ---
  app.post('/a2a/tasks/:id/cancel', async (c) => {
    const scope = getCallerScope(c)
    const task = await config.taskStore.get(c.req.param('id'))
    // RF-SEC-05: cross-owner cancel attempts return 404, not 403 — same
    // shape and status as a missing record.
    if (!task || !callerOwnsTask(scope, task)) {
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
