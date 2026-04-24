/**
 * Cross-process approval routes (MC-GA02).
 *
 * These endpoints let an external operator resolve pending approvals held
 * by an in-process {@link ApprovalStateStore}. They complement the
 * run-scoped approval actions in `approval.ts` (which operate on a Run's
 * status) by exposing the generic `(runId, approvalId)` key-space used by
 * {@link ApprovalGate}.
 *
 *   POST /api/approvals/:runId/:approvalId/grant
 *   POST /api/approvals/:runId/:approvalId/reject
 *
 * Both routes accept an optional JSON body:
 *   - grant:  `{ response?: unknown }`
 *   - reject: `{ reason?: string }`
 *
 * When the configured store does not know about the `(runId, approvalId)`
 * pair, a 404 response is returned without leaking which half of the key
 * was missing. All other errors surface as 500 from the global error
 * handler in `app.ts`.
 */
import { Hono } from 'hono'
import type { ApprovalStateStore } from '@dzupagent/hitl-kit'
import { UnknownApprovalError } from '@dzupagent/hitl-kit'
import type { DzupEventBus } from '@dzupagent/core'

export interface ApprovalRoutesConfig {
  approvalStore: ApprovalStateStore
  /** Optional event bus — when provided, grant/reject emit matching events. */
  eventBus?: DzupEventBus
}

export function createApprovalsRoutes(config: ApprovalRoutesConfig): Hono {
  const app = new Hono()
  const { approvalStore, eventBus } = config

  app.post('/:runId/:approvalId/grant', async (c) => {
    const runId = c.req.param('runId')
    const approvalId = c.req.param('approvalId')
    const body = await c.req.json<{ response?: unknown; approvedBy?: string }>().catch(() => ({}))

    try {
      await approvalStore.grant(runId, approvalId, body.response)
    } catch (err) {
      if (err instanceof UnknownApprovalError) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: 'Unknown approval' } },
          404,
        )
      }
      throw err
    }

    eventBus?.emit({
      type: 'approval:granted',
      runId,
      ...(typeof body.approvedBy === 'string' ? { approvedBy: body.approvedBy } : {}),
    })

    return c.json({ data: { runId, approvalId, decision: 'granted' } })
  })

  app.post('/:runId/:approvalId/reject', async (c) => {
    const runId = c.req.param('runId')
    const approvalId = c.req.param('approvalId')
    const body = await c.req.json<{ reason?: string }>().catch(() => ({}))
    const reason = body.reason ?? 'Rejected by operator'

    try {
      await approvalStore.reject(runId, approvalId, reason)
    } catch (err) {
      if (err instanceof UnknownApprovalError) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: 'Unknown approval' } },
          404,
        )
      }
      throw err
    }

    eventBus?.emit({ type: 'approval:rejected', runId, reason })

    return c.json({ data: { runId, approvalId, decision: 'rejected', reason } })
  })

  return app
}
