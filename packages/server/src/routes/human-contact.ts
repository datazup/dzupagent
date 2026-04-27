/**
 * Human contact response route.
 *
 * POST /api/runs/:id/human-contact/:contactId/respond
 *
 * Allows external systems (UI, Slack, email webhook) to respond to a pending
 * human contact request. Updates the run from suspended/awaiting_approval
 * back to running and stores the response in run metadata.
 */
import { Hono } from 'hono'
import type { ForgeServerConfig } from '../composition/types.js'
import { requireOwnedRun } from './run-guard.js'

export function createHumanContactRoutes(config: ForgeServerConfig): Hono {
  const app = new Hono()
  const { runStore, eventBus } = config

  // POST /api/runs/:id/human-contact/:contactId/respond
  app.post('/:id/human-contact/:contactId/respond', async (c) => {
    const runId = c.req.param('id')
    const contactId = c.req.param('contactId')

    // --- Validate body ---
    let body: Record<string, unknown>
    try {
      body = await c.req.json<Record<string, unknown>>()
    } catch {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' } },
        400,
      )
    }

    if (!body || typeof body !== 'object') {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Request body must be a JSON object' } },
        400,
      )
    }

    // --- Look up run (MJ-SEC-02: shared owner/tenant guard) ---
    const run = await requireOwnedRun(c, runId, runStore)
    if (run instanceof Response) return run

    // --- Validate run state ---
    if (run.status !== 'suspended' && run.status !== 'awaiting_approval') {
      return c.json(
        {
          error: {
            code: 'CONFLICT',
            message: `Run is in "${run.status}" state; expected "suspended" or "awaiting_approval"`,
          },
        },
        409,
      )
    }

    // --- Update run: store response + resume ---
    const existingMetadata = (run.metadata as Record<string, unknown> | undefined) ?? {}
    await runStore.update(runId, {
      status: 'running',
      metadata: {
        ...existingMetadata,
        humanContactResponse: {
          contactId,
          respondedAt: new Date().toISOString(),
          ...body,
        },
      },
    })

    await runStore.addLog(runId, {
      level: 'info',
      phase: 'human_contact',
      message: `Human contact response received for ${contactId}`,
      data: { contactId, responseType: body['type'] ?? 'unknown' },
    })

    // Emit events so the agent/event bridge can pick up the response
    eventBus.emit({
      type: 'human_contact:responded',
      runId,
      contactId,
      response: body,
    })

    // Also emit approval-specific events for backward compatibility
    if (body['type'] === 'approval') {
      const approved = body['approved'] === true
      if (approved) {
        eventBus.emit({ type: 'approval:granted', runId })
      } else {
        eventBus.emit({
          type: 'approval:rejected',
          runId,
          reason: typeof body['comment'] === 'string' ? body['comment'] : 'Rejected via human contact',
        })
      }
    }

    return c.json({
      data: { runId, contactId, status: 'resumed' },
    })
  })

  return app
}
