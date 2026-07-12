/**
 * SEC-H-02 / SEC-H-03 — cross-tenant IDOR regression tests.
 *
 * Verifies that the MCP server/profile routes and the mailbox routes scope
 * every store read/write to the authenticated caller's tenant. Tenant A must
 * not be able to see, repoint, or delete tenant B's MCP endpoints/profiles,
 * nor read or acknowledge tenant B's mailbox messages.
 *
 * Harness mirrors `tenant-isolation-routes.test.ts`: an `x-test-tenant` header
 * is projected into the `apiKey` context variable so `getRequestingTenantId`
 * derives the caller's tenant server-side (never from client-controlled body).
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { Hono } from 'hono'
import {
  InMemoryMcpManager,
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import { InMemoryMailboxStore } from '@dzupagent/agent'
import { createMcpRoutes } from '../routes/mcp.js'
import { createMailboxRoutes } from '../routes/mailbox.js'
import type { ForgeServerConfig } from '../app.js'
import type { AppEnv } from '../types.js'

const tenantA = 'tenant-a'
const tenantB = 'tenant-b'

function installTenantHeader(app: Hono<AppEnv>): void {
  app.use('*', async (c, next) => {
    const tenantId = c.req.header('x-test-tenant')
    if (tenantId) {
      c.set('apiKey', { id: `key-${tenantId}`, tenantId })
    }
    await next()
  })
}

function jsonRequest(method: string, tenantId: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-test-tenant': tenantId,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }
}

describe('SEC-H-02 MCP routes: cross-tenant isolation', () => {
  let app: Hono<AppEnv>

  beforeEach(() => {
    const config = {
      runStore: new InMemoryRunStore(),
      agentStore: new InMemoryAgentStore(),
      eventBus: createEventBus(),
      modelRegistry: new ModelRegistry(),
      mcpManager: new InMemoryMcpManager(),
    } satisfies ForgeServerConfig
    app = new Hono<AppEnv>()
    installTenantHeader(app)
    app.route('/api/mcp', createMcpRoutes(config))
  })

  async function createServerForA(): Promise<void> {
    const res = await app.request(
      '/api/mcp/servers',
      jsonRequest('POST', tenantA, {
        id: 'srv-a',
        transport: 'http',
        endpoint: 'https://93.184.216.34',
        enabled: true,
      }),
    )
    expect(res.status).toBe(201)
  }

  it("tenant B cannot list tenant A's servers", async () => {
    await createServerForA()

    const listA = await app.request('/api/mcp/servers', jsonRequest('GET', tenantA))
    const bodyA = (await listA.json()) as { data: unknown[]; count: number }
    expect(bodyA.count).toBe(1)

    const listB = await app.request('/api/mcp/servers', jsonRequest('GET', tenantB))
    const bodyB = (await listB.json()) as { data: unknown[]; count: number }
    expect(bodyB.count).toBe(0)
  })

  it("tenant B cannot GET tenant A's server (404)", async () => {
    await createServerForA()
    const res = await app.request('/api/mcp/servers/srv-a', jsonRequest('GET', tenantB))
    expect(res.status).toBe(404)
  })

  it("tenant B cannot repoint tenant A's server via PATCH (404)", async () => {
    await createServerForA()
    const res = await app.request(
      '/api/mcp/servers/srv-a',
      jsonRequest('PATCH', tenantB, { endpoint: 'https://10.0.0.1' }),
    )
    expect(res.status).toBe(404)

    // Tenant A's endpoint is untouched.
    const check = await app.request('/api/mcp/servers/srv-a', jsonRequest('GET', tenantA))
    const body = (await check.json()) as { data: { endpoint: string } }
    expect(body.data.endpoint).toBe('https://93.184.216.34')
  })

  it("tenant B cannot DELETE tenant A's server (404) and it survives", async () => {
    await createServerForA()
    const del = await app.request('/api/mcp/servers/srv-a', jsonRequest('DELETE', tenantB))
    expect(del.status).toBe(404)

    const check = await app.request('/api/mcp/servers/srv-a', jsonRequest('GET', tenantA))
    expect(check.status).toBe(200)
  })

  it('a client-supplied tenantId in the body is ignored (cannot plant into another tenant)', async () => {
    // Tenant A creates a server but tries to stamp it as tenant B's.
    const res = await app.request(
      '/api/mcp/servers',
      jsonRequest('POST', tenantA, {
        id: 'srv-spoof',
        transport: 'http',
        endpoint: 'https://93.184.216.34',
        enabled: true,
        tenantId: tenantB,
      }),
    )
    expect(res.status).toBe(201)

    // It belongs to A (the authenticated caller), not B.
    const seenByB = await app.request('/api/mcp/servers/srv-spoof', jsonRequest('GET', tenantB))
    expect(seenByB.status).toBe(404)
    const seenByA = await app.request('/api/mcp/servers/srv-spoof', jsonRequest('GET', tenantA))
    expect(seenByA.status).toBe(200)
  })

  it("tenant B cannot see or delete tenant A's profile", async () => {
    const create = await app.request(
      '/api/mcp/profiles',
      jsonRequest('POST', tenantA, { id: 'prof-a', serverIds: [], enabled: true }),
    )
    expect(create.status).toBe(201)

    const listB = await app.request('/api/mcp/profiles', jsonRequest('GET', tenantB))
    const bodyB = (await listB.json()) as { data: unknown[]; count: number }
    expect(bodyB.count).toBe(0)

    const getB = await app.request('/api/mcp/profiles/prof-a', jsonRequest('GET', tenantB))
    expect(getB.status).toBe(404)

    const delB = await app.request('/api/mcp/profiles/prof-a', jsonRequest('DELETE', tenantB))
    expect(delB.status).toBe(404)

    // Still visible to tenant A.
    const getA = await app.request('/api/mcp/profiles/prof-a', jsonRequest('GET', tenantA))
    expect(getA.status).toBe(200)
  })
})

describe('SEC-H-03 mailbox routes: cross-tenant isolation', () => {
  let app: Hono<AppEnv>

  beforeEach(() => {
    app = new Hono<AppEnv>()
    installTenantHeader(app)
    app.route('/api/mailbox', createMailboxRoutes({ mailboxStore: new InMemoryMailboxStore() }))
  })

  async function sendForA(): Promise<string> {
    const res = await app.request(
      '/api/mailbox/agent-1/send',
      jsonRequest('POST', tenantA, {
        to: 'agent-2',
        subject: 'secret',
        body: { text: 'tenant A only' },
      }),
    )
    expect(res.status).toBe(200)
    const msg = (await res.json()) as { id: string }
    return msg.id
  }

  it("tenant B cannot read tenant A's messages even with a colliding recipient id", async () => {
    await sendForA()

    // Tenant A sees its own message.
    const readA = await app.request(
      '/api/mailbox/agent-2/messages?unreadOnly=false',
      jsonRequest('GET', tenantA),
    )
    const listA = (await readA.json()) as unknown[]
    expect(listA).toHaveLength(1)

    // Tenant B, querying the same recipient agent id, sees nothing.
    const readB = await app.request(
      '/api/mailbox/agent-2/messages?unreadOnly=false',
      jsonRequest('GET', tenantB),
    )
    const listB = (await readB.json()) as unknown[]
    expect(listB).toHaveLength(0)
  })

  it("tenant B cannot acknowledge (mark read) tenant A's message", async () => {
    const messageId = await sendForA()

    // Tenant B attempts to ack tenant A's message.
    const ackB = await app.request(
      `/api/mailbox/agent-2/messages/${messageId}/ack`,
      jsonRequest('POST', tenantB),
    )
    expect(ackB.status).toBe(204)

    // The message is still unread for tenant A (the ack was a no-op).
    const stillUnread = await app.request(
      '/api/mailbox/agent-2/messages?unreadOnly=true',
      jsonRequest('GET', tenantA),
    )
    const list = (await stillUnread.json()) as unknown[]
    expect(list).toHaveLength(1)
  })
})
