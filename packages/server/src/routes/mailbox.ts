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

export interface MailboxRouteConfig {
  mailboxStore: MailboxStore
}

export function createMailboxRoutes(config: MailboxRouteConfig): Hono {
  const app = new Hono()
  const { mailboxStore } = config

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

    await mailboxStore.save(message)

    return c.json(message)
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
