/**
 * Approval management routes.
 *
 * POST /api/runs/:id/approve — Approve a pending run
 * POST /api/runs/:id/reject  — Reject a pending run with reason
 */
import { Hono } from 'hono'
import type { ForgeServerConfig } from '../app.js'

export function createApprovalRoutes(config: ForgeServerConfig): Hono {
  const app = new Hono()
  const { runStore, eventBus } = config

  // POST /api/runs/:id/approve — Approve a pending run
  app.post('/:id/approve', async (c) => {
    const id = c.req.param('id')
    const run = await runStore.get(id)

    if (!run) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
    }

    if (run.status !== 'awaiting_approval') {
      return c.json(
        { error: { code: 'INVALID_STATE', message: `Run is in "${run.status}" state, not awaiting approval` } },
        400,
      )
    }

    await runStore.update(id, { status: 'approved' })
    await runStore.addLog(id, { level: 'info', message: 'Run approved', phase: 'approval' })

    eventBus.emit({ type: 'approval:granted', runId: id })

    return c.json({ data: { id, status: 'approved' } })
  })

  // POST /api/runs/:id/reject — Reject a pending run
  app.post('/:id/reject', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined }))
    const reason = body.reason ?? 'Rejected by user'

    const run = await runStore.get(id)

    if (!run) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404)
    }

    if (run.status !== 'awaiting_approval') {
      return c.json(
        { error: { code: 'INVALID_STATE', message: `Run is in "${run.status}" state, not awaiting approval` } },
        400,
      )
    }

    await runStore.update(id, { status: 'rejected', error: reason, completedAt: new Date() })
    await runStore.addLog(id, { level: 'info', message: `Run rejected: ${reason}`, phase: 'approval' })

    eventBus.emit({ type: 'approval:rejected', runId: id, reason })

    return c.json({ data: { id, status: 'rejected', reason } })
  })

  return app
}
