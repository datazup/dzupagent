/**
 * Mailbox routes for inter-agent messaging.
 *
 * POST /api/mailbox/:agentId/send                  — Send a message from an agent
 * GET  /api/mailbox/:agentId/messages               — List messages for an agent
 * POST /api/mailbox/:agentId/messages/:messageId/ack — Acknowledge (mark read) a message
 */
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { randomUUID } from 'node:crypto'
import type { MailboxStore, MailMessage } from '@dzupagent/agent/mailbox'
import type { DrizzleDlqStore } from '../persistence/drizzle-dlq-store.js'
import { MailRateLimitError } from '../notifications/mail-rate-limiter.js'
import { getRequestingTenantId } from './tenant-scope.js'

export interface MailboxRouteConfig {
  mailboxStore: MailboxStore
  /** Optional DLQ store. Enables POST /dlq/:id/redeliver when provided. */
  dlqStore?: DrizzleDlqStore
}

export function createMailboxRoutes(config: MailboxRouteConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const { mailboxStore, dlqStore } = config

  // POST /:agentId/send — Send a message from this agent
  app.post('/:agentId/send', async (c) => {
    const agentId = c.req.param('agentId')
    const tenantId = getRequestingTenantId(c)
    const body = await c.req.json<{ to: string; subject: string; body: Record<string, unknown> }>()

    if (!body.to || !body.subject || !body.body) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'to, subject, and body are required' } },
        400,
      )
    }

    // SEC-H-03: the `:agentId` sender is client-supplied; stamp the message
    // with the caller's server-derived tenant so it cannot be read/spoofed by
    // another tenant. We do not trust the path param to select the tenant.
    const message: MailMessage = {
      id: randomUUID(),
      from: agentId,
      to: body.to,
      subject: body.subject,
      body: body.body,
      createdAt: Date.now(),
      tenantId,
    }

    try {
      await mailboxStore.save(message)
    } catch (err) {
      if (err instanceof MailRateLimitError) {
        return c.json(
          {
            error: {
              code: 'RATE_LIMITED',
              message: err.message,
              retryAfterMs: err.retryAfterMs,
            },
          },
          429,
        )
      }
      throw err
    }

    return c.json(message)
  })

  // POST /dlq/:id/redeliver — Move a DLQ entry back into the mailbox
  app.post('/dlq/:id/redeliver', async (c) => {
    if (!dlqStore) {
      return c.json(
        { error: { code: 'NOT_CONFIGURED', message: 'DLQ is not configured' } },
        501,
      )
    }
    const id = c.req.param('id')
    const ok = await dlqStore.redeliver(id)
    if (!ok) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: `DLQ entry ${id} not found` } },
        404,
      )
    }
    return c.json({ id, redelivered: true })
  })

  // GET /:agentId/messages — Retrieve messages for an agent
  app.get('/:agentId/messages', async (c) => {
    const agentId = c.req.param('agentId')
    const tenantId = getRequestingTenantId(c)

    const limitStr = c.req.query('limit')
    const unreadOnlyStr = c.req.query('unreadOnly')
    const sinceStr = c.req.query('since')

    // SEC-H-03: scope the read to the caller's tenant so tenant A cannot read
    // tenant B's mail even when the recipient agent id collides.
    const messages = await mailboxStore.findByRecipient(
      agentId,
      {
        limit: limitStr ? Number(limitStr) : undefined,
        unreadOnly: unreadOnlyStr !== undefined ? unreadOnlyStr === 'true' : undefined,
        since: sinceStr ? Number(sinceStr) : undefined,
      },
      tenantId,
    )

    return c.json(messages)
  })

  // POST /:agentId/messages/:messageId/ack — Acknowledge a message
  app.post('/:agentId/messages/:messageId/ack', async (c) => {
    const messageId = c.req.param('messageId')
    const tenantId = getRequestingTenantId(c)
    // SEC-H-03: a cross-tenant ack is scoped out (no-op) by the store.
    await mailboxStore.markRead(messageId, tenantId)
    return c.body(null, 204)
  })

  return app
}
