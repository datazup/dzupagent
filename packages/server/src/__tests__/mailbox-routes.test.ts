import { describe, it, expect, beforeEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import { InMemoryMailboxStore } from '@dzupagent/agent'

function createTestConfig(): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    mailboxStore: new InMemoryMailboxStore(),
  }
}

async function req(app: ReturnType<typeof createForgeApp>, method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body) init.body = JSON.stringify(body)
  return app.request(path, init)
}

describe('Mailbox routes', () => {
  let app: ReturnType<typeof createForgeApp>

  beforeEach(() => {
    app = createForgeApp(createTestConfig())
  })

  it('POST /:agentId/send creates a message', async () => {
    const res = await req(app, 'POST', '/api/mailbox/agent-a/send', {
      to: 'agent-b',
      subject: 'Hello',
      body: { text: 'world' },
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { id: string; from: string; to: string; subject: string }
    expect(data.from).toBe('agent-a')
    expect(data.to).toBe('agent-b')
    expect(data.subject).toBe('Hello')
    expect(data.id).toBeTruthy()
  })

  it('POST /:agentId/send returns 400 when fields are missing', async () => {
    const res = await req(app, 'POST', '/api/mailbox/agent-a/send', {
      to: 'agent-b',
      // missing subject and body
    })
    expect(res.status).toBe(400)
    const data = await res.json() as { error: { code: string } }
    expect(data.error.code).toBe('BAD_REQUEST')
  })

  it('GET /:agentId/messages lists messages for recipient', async () => {
    // Send two messages to agent-b
    await req(app, 'POST', '/api/mailbox/agent-a/send', {
      to: 'agent-b',
      subject: 'First',
      body: { n: 1 },
    })
    await req(app, 'POST', '/api/mailbox/agent-a/send', {
      to: 'agent-b',
      subject: 'Second',
      body: { n: 2 },
    })

    const res = await app.request('/api/mailbox/agent-b/messages')
    expect(res.status).toBe(200)
    const data = await res.json() as Array<{ subject: string }>
    expect(data).toHaveLength(2)
  })

  it('GET /:agentId/messages returns empty array for unknown agent', async () => {
    const res = await app.request('/api/mailbox/unknown-agent/messages')
    expect(res.status).toBe(200)
    const data = await res.json() as unknown[]
    expect(data).toHaveLength(0)
  })

  it('GET /:agentId/messages supports limit query param', async () => {
    await req(app, 'POST', '/api/mailbox/a/send', { to: 'b', subject: 'M1', body: { n: 1 } })
    await req(app, 'POST', '/api/mailbox/a/send', { to: 'b', subject: 'M2', body: { n: 2 } })
    await req(app, 'POST', '/api/mailbox/a/send', { to: 'b', subject: 'M3', body: { n: 3 } })

    const res = await app.request('/api/mailbox/b/messages?limit=2')
    const data = await res.json() as unknown[]
    expect(data.length).toBeLessThanOrEqual(2)
  })

  it('POST /:agentId/messages/:messageId/ack acknowledges a message', async () => {
    const sendRes = await req(app, 'POST', '/api/mailbox/agent-a/send', {
      to: 'agent-b',
      subject: 'Ack me',
      body: { text: 'test' },
    })
    const msg = await sendRes.json() as { id: string }

    const ackRes = await req(app, 'POST', `/api/mailbox/agent-b/messages/${msg.id}/ack`)
    expect(ackRes.status).toBe(204)
  })
})
