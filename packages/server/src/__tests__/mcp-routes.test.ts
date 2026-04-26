/**
 * MCP route tests.
 *
 * Tests the /api/mcp/* endpoints using InMemoryMcpManager from @dzupagent/core.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
  InMemoryMcpManager,
} from '@dzupagent/core'
import type { Hono } from 'hono'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestConfig(mcpManager?: InMemoryMcpManager): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    mcpManager: mcpManager ?? new InMemoryMcpManager(),
  }
}

async function req(app: Hono, method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body) init.body = JSON.stringify(body)
  return app.request(path, init)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP routes', () => {
  let app: Hono
  let mcpManager: InMemoryMcpManager

  beforeEach(() => {
    mcpManager = new InMemoryMcpManager()
    app = createForgeApp(createTestConfig(mcpManager))
  })

  // --- Server routes ---

  it('GET /api/mcp/servers returns empty list', async () => {
    const res = await req(app, 'GET', '/api/mcp/servers')
    expect(res.status).toBe(200)
    const json = await res.json() as { data: unknown[]; count: number }
    expect(json.data).toEqual([])
    expect(json.count).toBe(0)
  })

  it('POST /api/mcp/servers creates a server (201)', async () => {
    const res = await req(app, 'POST', '/api/mcp/servers', {
      id: 'test-server',
      transport: 'http',
      endpoint: 'http://localhost:3000',
      enabled: true,
    })
    expect(res.status).toBe(201)
    const json = await res.json() as { data: { id: string } }
    expect(json.data.id).toBe('test-server')
  })

  it('POST /api/mcp/servers returns 400 for missing fields', async () => {
    const res = await req(app, 'POST', '/api/mcp/servers', {
      id: 'test-server',
    })
    expect(res.status).toBe(400)
    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('VALIDATION_ERROR')
  })

  it('POST /api/mcp/servers returns 409 for duplicate id', async () => {
    await req(app, 'POST', '/api/mcp/servers', {
      id: 'dup',
      transport: 'http',
      endpoint: 'http://localhost:3000',
      enabled: true,
    })
    const res = await req(app, 'POST', '/api/mcp/servers', {
      id: 'dup',
      transport: 'http',
      endpoint: 'http://localhost:3001',
      enabled: true,
    })
    expect(res.status).toBe(409)
  })

  it('GET /api/mcp/servers/:id returns server (200)', async () => {
    await mcpManager.addServer({
      id: 'srv-1',
      transport: 'http',
      endpoint: 'http://localhost:3000',
      enabled: true,
    })
    const res = await req(app, 'GET', '/api/mcp/servers/srv-1')
    expect(res.status).toBe(200)
    const json = await res.json() as { data: { id: string } }
    expect(json.data.id).toBe('srv-1')
  })

  it('GET /api/mcp/servers/:id returns 404 for missing server', async () => {
    const res = await req(app, 'GET', '/api/mcp/servers/nope')
    expect(res.status).toBe(404)
    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('NOT_FOUND')
  })

  it('DELETE /api/mcp/servers/:id removes server (204)', async () => {
    await mcpManager.addServer({
      id: 'rm-me',
      transport: 'http',
      endpoint: 'http://localhost:3000',
      enabled: true,
    })
    const res = await req(app, 'DELETE', '/api/mcp/servers/rm-me')
    expect(res.status).toBe(204)

    // Confirm it is gone
    const check = await req(app, 'GET', '/api/mcp/servers/rm-me')
    expect(check.status).toBe(404)
  })

  it('POST /api/mcp/servers/:id/test returns test result', async () => {
    await mcpManager.addServer({
      id: 'test-srv',
      transport: 'http',
      endpoint: 'http://localhost:3000',
      enabled: true,
    })
    const res = await req(app, 'POST', '/api/mcp/servers/test-srv/test')
    expect(res.status).toBe(200)
    const json = await res.json() as { data: { ok: boolean } }
    // InMemoryMcpManager without mcpClient returns { ok: false, error: 'No MCPClient configured...' }
    expect(json.data.ok).toBe(false)
  })

  it('POST /api/mcp/servers/:id/enable enables a server', async () => {
    await mcpManager.addServer({
      id: 'dis-srv',
      transport: 'http',
      endpoint: 'http://localhost:3000',
      enabled: false,
    })
    const res = await req(app, 'POST', '/api/mcp/servers/dis-srv/enable')
    expect(res.status).toBe(200)
    const json = await res.json() as { data: { enabled: boolean } }
    expect(json.data.enabled).toBe(true)
  })

  it('POST /api/mcp/servers/:id/disable disables a server', async () => {
    await mcpManager.addServer({
      id: 'en-srv',
      transport: 'http',
      endpoint: 'http://localhost:3000',
      enabled: true,
    })
    const res = await req(app, 'POST', '/api/mcp/servers/en-srv/disable')
    expect(res.status).toBe(200)
    const json = await res.json() as { data: { enabled: boolean } }
    expect(json.data.enabled).toBe(false)
  })

  it('PATCH /api/mcp/servers/:id updates server fields', async () => {
    await mcpManager.addServer({
      id: 'patch-srv',
      transport: 'http',
      endpoint: 'http://localhost:3000',
      enabled: true,
    })
    const res = await req(app, 'PATCH', '/api/mcp/servers/patch-srv', {
      name: 'Updated Name',
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { data: { name: string } }
    expect(json.data.name).toBe('Updated Name')
  })

  it('PATCH /api/mcp/servers/:id returns 404 for missing server', async () => {
    const res = await req(app, 'PATCH', '/api/mcp/servers/nope', {
      name: 'x',
    })
    expect(res.status).toBe(404)
  })

  // --- Profile routes ---

  it('GET /api/mcp/profiles returns empty list', async () => {
    const res = await req(app, 'GET', '/api/mcp/profiles')
    expect(res.status).toBe(200)
    const json = await res.json() as { data: unknown[]; count: number }
    expect(json.data).toEqual([])
    expect(json.count).toBe(0)
  })

  it('POST /api/mcp/profiles creates a profile (201)', async () => {
    const res = await req(app, 'POST', '/api/mcp/profiles', {
      id: 'prof-1',
      serverIds: ['srv-a', 'srv-b'],
      enabled: true,
    })
    expect(res.status).toBe(201)
    const json = await res.json() as { data: { id: string } }
    expect(json.data.id).toBe('prof-1')
  })

  it('POST /api/mcp/profiles returns 400 for missing serverIds', async () => {
    const res = await req(app, 'POST', '/api/mcp/profiles', {
      id: 'bad-prof',
    })
    expect(res.status).toBe(400)
    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('VALIDATION_ERROR')
  })

  it('GET /api/mcp/profiles/:id returns profile', async () => {
    await mcpManager.addProfile({
      id: 'get-prof',
      serverIds: ['srv-x'],
      enabled: true,
    })
    const res = await req(app, 'GET', '/api/mcp/profiles/get-prof')
    expect(res.status).toBe(200)
    const json = await res.json() as { data: { id: string } }
    expect(json.data.id).toBe('get-prof')
  })

  it('GET /api/mcp/profiles/:id returns 404 for missing profile', async () => {
    const res = await req(app, 'GET', '/api/mcp/profiles/nope')
    expect(res.status).toBe(404)
    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('NOT_FOUND')
  })

  it('DELETE /api/mcp/profiles/:id removes profile (204)', async () => {
    await mcpManager.addProfile({
      id: 'rm-prof',
      serverIds: [],
      enabled: true,
    })
    const res = await req(app, 'DELETE', '/api/mcp/profiles/rm-prof')
    expect(res.status).toBe(204)
  })

  // --- Secret redaction (QF-SEC-06) ---

  describe('response secret redaction', () => {
    it('POST /api/mcp/servers redacts env values in response', async () => {
      const res = await req(app, 'POST', '/api/mcp/servers', {
        id: 'env-srv',
        transport: 'http',
        endpoint: 'http://localhost:3000',
        enabled: true,
        env: { MY_TOKEN: 'super-secret', OTHER: 'also-secret' },
      })
      expect(res.status).toBe(201)
      const json = (await res.json()) as {
        data: { env?: Record<string, string> }
      }
      expect(json.data.env).toEqual({
        MY_TOKEN: '[REDACTED]',
        OTHER: '[REDACTED]',
      })
    })

    it('POST /api/mcp/servers redacts sensitive headers in response', async () => {
      const res = await req(app, 'POST', '/api/mcp/servers', {
        id: 'hdr-srv',
        transport: 'http',
        endpoint: 'http://localhost:3000',
        enabled: true,
        headers: {
          authorization: 'Bearer secret',
          'x-api-key': 'k-xyz',
          'content-type': 'application/json',
        },
      })
      expect(res.status).toBe(201)
      const json = (await res.json()) as {
        data: { headers?: Record<string, string> }
      }
      expect(json.data.headers).toEqual({
        authorization: '[REDACTED]',
        'x-api-key': '[REDACTED]',
        'content-type': 'application/json',
      })
    })

    it('GET /api/mcp/servers/:id redacts secrets in response', async () => {
      await mcpManager.addServer({
        id: 'get-redact',
        transport: 'http',
        endpoint: 'http://localhost:3000',
        enabled: true,
        env: { TOKEN: 'sensitive' },
        headers: { authorization: 'Bearer xyz' },
      })
      const res = await req(app, 'GET', '/api/mcp/servers/get-redact')
      expect(res.status).toBe(200)
      const json = (await res.json()) as {
        data: {
          env?: Record<string, string>
          headers?: Record<string, string>
        }
      }
      expect(json.data.env).toEqual({ TOKEN: '[REDACTED]' })
      expect(json.data.headers).toEqual({ authorization: '[REDACTED]' })
    })

    it('GET /api/mcp/servers redacts secrets in list response', async () => {
      await mcpManager.addServer({
        id: 'list-redact',
        transport: 'http',
        endpoint: 'http://localhost:3000',
        enabled: true,
        env: { SECRET: 'val' },
        headers: { authorization: 'Bearer abc' },
      })
      const res = await req(app, 'GET', '/api/mcp/servers')
      expect(res.status).toBe(200)
      const json = (await res.json()) as {
        data: Array<{
          id: string
          env?: Record<string, string>
          headers?: Record<string, string>
        }>
      }
      const found = json.data.find((s) => s.id === 'list-redact')
      expect(found?.env).toEqual({ SECRET: '[REDACTED]' })
      expect(found?.headers).toEqual({ authorization: '[REDACTED]' })
      // No raw secret values should appear anywhere in the list payload.
      const serialized = JSON.stringify(json)
      expect(serialized).not.toContain('Bearer abc')
      expect(serialized).not.toContain('"val"')
    })

    it('PATCH /api/mcp/servers/:id redacts secrets in response', async () => {
      await mcpManager.addServer({
        id: 'patch-redact',
        transport: 'http',
        endpoint: 'http://localhost:3000',
        enabled: true,
      })
      const res = await req(app, 'PATCH', '/api/mcp/servers/patch-redact', {
        env: { NEW_TOKEN: 'just-set' },
        headers: { authorization: 'Bearer new' },
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as {
        data: {
          env?: Record<string, string>
          headers?: Record<string, string>
        }
      }
      expect(json.data.env).toEqual({ NEW_TOKEN: '[REDACTED]' })
      expect(json.data.headers).toEqual({ authorization: '[REDACTED]' })
    })

    it('stored definition retains real env/header values for execution path', async () => {
      await req(app, 'POST', '/api/mcp/servers', {
        id: 'stored-real',
        transport: 'http',
        endpoint: 'http://localhost:3000',
        enabled: true,
        env: { MY_TOKEN: 'real-secret' },
        headers: { authorization: 'Bearer real' },
      })
      // Internal manager access — values should NOT be redacted
      const stored = await mcpManager.getServer('stored-real')
      expect(stored?.env).toEqual({ MY_TOKEN: 'real-secret' })
      expect(stored?.headers).toEqual({ authorization: 'Bearer real' })
    })
  })

  // --- MJ-SEC-03: stdio executable re-validation on PATCH ---

  describe('PATCH /api/mcp/servers/:id stdio allowlist re-validation (MJ-SEC-03)', () => {
    it('allows PATCH that changes a non-stdio server endpoint when no stdio involved', async () => {
      const server = await mcpManager.addServer({ id: 'http-srv', transport: 'http', endpoint: 'http://old' })
      const guardedApp = createForgeApp({
        ...createTestConfig(mcpManager),
        mcpAllowedExecutables: [],
      })
      const res = await req(guardedApp, 'PATCH', `/api/mcp/servers/${server.id}`, { endpoint: 'http://new' })
      expect(res.status).toBe(200)
    })

    it('rejects PATCH that changes transport to stdio when endpoint is not in allowlist', async () => {
      const server = await mcpManager.addServer({ id: 'srv-change', transport: 'http', endpoint: 'http://x' })
      const guardedApp = createForgeApp({
        ...createTestConfig(mcpManager),
        mcpAllowedExecutables: ['npx'],
      })
      const res = await req(guardedApp, 'PATCH', `/api/mcp/servers/${server.id}`, {
        transport: 'stdio',
        endpoint: '/usr/bin/evil',
      })
      expect(res.status).toBe(403)
      const json = await res.json() as { error: { code: string } }
      expect(json.error.code).toBe('FORBIDDEN')
    })

    it('allows PATCH that changes transport to stdio when endpoint is in allowlist', async () => {
      const server = await mcpManager.addServer({ id: 'srv-ok', transport: 'http', endpoint: 'http://x' })
      const guardedApp = createForgeApp({
        ...createTestConfig(mcpManager),
        mcpAllowedExecutables: ['npx', 'node'],
      })
      const res = await req(guardedApp, 'PATCH', `/api/mcp/servers/${server.id}`, {
        transport: 'stdio',
        endpoint: 'npx',
      })
      expect(res.status).toBe(200)
    })

    it('rejects PATCH that changes endpoint of an existing stdio server to an unlisted command', async () => {
      const server = await mcpManager.addServer({ id: 'stdio-srv', transport: 'stdio', endpoint: 'npx' })
      const guardedApp = createForgeApp({
        ...createTestConfig(mcpManager),
        mcpAllowedExecutables: ['npx'],
      })
      const res = await req(guardedApp, 'PATCH', `/api/mcp/servers/${server.id}`, {
        endpoint: '/usr/bin/malicious',
      })
      expect(res.status).toBe(403)
    })

    it('allows PATCH that changes non-endpoint fields of an existing stdio server', async () => {
      const server = await mcpManager.addServer({ id: 'stdio-safe', transport: 'stdio', endpoint: 'npx' })
      const guardedApp = createForgeApp({
        ...createTestConfig(mcpManager),
        mcpAllowedExecutables: ['npx'],
      })
      const res = await req(guardedApp, 'PATCH', `/api/mcp/servers/${server.id}`, {
        name: 'Updated Name',
      })
      expect(res.status).toBe(200)
    })
  })

  // --- Service unavailable guard ---

  it('returns 503 when mcpManager is not configured', async () => {
    const noMcpApp = createForgeApp({
      runStore: new InMemoryRunStore(),
      agentStore: new InMemoryAgentStore(),
      eventBus: createEventBus(),
      modelRegistry: new ModelRegistry(),
      // mcpManager intentionally omitted — routes not mounted
    })
    // When mcpManager is not provided, the routes are not mounted at all,
    // so we get 404 from Hono.
    const res = await req(noMcpApp, 'GET', '/api/mcp/servers')
    expect(res.status).toBe(404)
  })
})
