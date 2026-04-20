/**
 * Mailbox routes for inter-agent messaging.
 *
 * POST /api/mailbox/:agentId/send                  — Send a message from an agent
 * GET  /api/mailbox/:agentId/messages               — List messages for an agent
 * POST /api/mailbox/:agentId/messages/:messageId/ack — Acknowledge (mark read) a message
 */
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { MailboxStore, MailMessage } from '@dzupagent/agent'
import type { DrizzleDlqStore } from '../persistence/drizzle-dlq-store.js'
import { MailRateLimitError } from '../notifications/mail-rate-limiter.js'

export interface MailboxRouteConfig {
  mailboxStore: MailboxStore
  /** Optional DLQ store. Enables POST /dlq/:id/redeliver when provided. */
  dlqStore?: DrizzleDlqStore
}

export function createMailboxRoutes(config: MailboxRouteConfig): Hono {
  const app = new Hono()
  const { mailboxStore, dlqStore } = config

  // POST /:agentId/send — Send a message from this agent
  app.post('/:agentId/send', async (c) => {
    const agentId = c.req.param('agentId')
    const body = await c.req.json<{ to: string; subject: string; body: Record<string, unknown> }>()

    if (!body.to || !body.subject || !body.body) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'to, subject, and body are required' } },
        400,
      )
    }

    const message: MailMessage = {
      id: randomUUID(),
      from: agentId,
      to: body.to,
      subject: body.subject,
      body: body.body,
      createdAt: Date.now(),
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

    const limitStr = c.req.query('limit')
    const unreadOnlyStr = c.req.query('unreadOnly')
    const sinceStr = c.req.query('since')

    const messages = await mailboxStore.findByRecipient(agentId, {
      limit: limitStr ? Number(limitStr) : undefined,
      unreadOnly: unreadOnlyStr !== undefined ? unreadOnlyStr === 'true' : undefined,
      since: sinceStr ? Number(sinceStr) : undefined,
    })

    return c.json(messages)
  })

  // POST /:agentId/messages/:messageId/ack — Acknowledge a message
  app.post('/:agentId/messages/:messageId/ack', async (c) => {
    const messageId = c.req.param('messageId')
    await mailboxStore.markRead(messageId)
    return c.body(null, 204)
  })

  return app
}
