/**
 * Integration tests for run CRUD routes.
 *
 * POST   /api/runs                  — create
 * GET    /api/runs                  — list (with filters)
 * GET    /api/runs/:id              — get detail
 * POST   /api/runs/:id/cancel       — cancel
 * GET    /api/runs/:id/logs         — logs
 * GET    /api/runs/:id/checkpoints  — checkpoints
 *
 * Uses InMemoryRunStore and InMemoryAgentStore — no DB, no Docker, no network.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestConfig(): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
  }
}

async function req(
  app: ReturnType<typeof createForgeApp>,
  method: string,
  path: string,
  body?: unknown,
) {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  return app.request(path, init)
}

// ---------------------------------------------------------------------------
// POST /api/runs — create
// ---------------------------------------------------------------------------

describe('POST /api/runs', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>

  beforeEach(async () => {
    config = createTestConfig()
    app = createForgeApp(config)
    await config.agentStore.save({
      id: 'agent-1',
      name: 'Test Agent',
      instructions: 'test',
      modelTier: 'chat',
    })
  })

  it('201 — creates a run and returns it with queued status', async () => {
    const res = await req(app, 'POST', '/api/runs', {
      agentId: 'agent-1',
      input: { task: 'do something' },
    })
    expect(res.status).toBe(201)

    const body = (await res.json()) as { data: { id: string; agentId: string; status: string; input: unknown } }
    expect(body.data.id).toBeTruthy()
    expect(body.data.agentId).toBe('agent-1')
    expect(body.data.status).toBe('queued')
    expect(body.data.input).toEqual({ task: 'do something' })
  })

  it('201 — persists the run so it can be retrieved afterwards', async () => {
    const createRes = await req(app, 'POST', '/api/runs', {
      agentId: 'agent-1',
      input: 'persist test',
    })
    const created = (await createRes.json()) as { data: { id: string } }
    const runId = created.data.id

    const getRes = await app.request(`/api/runs/${runId}`)
    expect(getRes.status).toBe(200)
  })

  it('400 — returns VALIDATION_ERROR when agentId is missing', async () => {
    const res = await req(app, 'POST', '/api/runs', { input: 'no agent' })
    expect(res.status).toBe(400)

    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toMatch(/agentId/)
  })

  it('404 — returns NOT_FOUND when agentId does not exist', async () => {
    const res = await req(app, 'POST', '/api/runs', {
      agentId: 'nonexistent-agent',
      input: 'task',
    })
    expect(res.status).toBe(404)

    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('201 — stores custom metadata on the run', async () => {
    const res = await req(app, 'POST', '/api/runs', {
      agentId: 'agent-1',
      input: 'task',
      metadata: { environment: 'test', version: '1.0' },
    })
    expect(res.status).toBe(201)

    const body = (await res.json()) as { data: { metadata?: Record<string, unknown> } }
    expect(body.data.metadata?.['environment']).toBe('test')
    expect(body.data.metadata?.['version']).toBe('1.0')
  })

  it('strips connector and MCP secrets before persisting run metadata', async () => {
    const res = await req(app, 'POST', '/api/runs', {
      agentId: 'agent-1',
      input: 'task',
      metadata: {
        environment: 'test',
        githubToken: 'ghp-secret',
        slackToken: 'xoxb-secret',
        httpHeaders: { Authorization: 'Bearer secret' },
        httpProfile: 'public-api',
        githubProfile: 'release',
        slackProfile: 'ops',
        mcpServers: [
          {
            id: 'mcp-1',
            url: 'https://mcp.example.com',
            env: { TOKEN: 'mcp-secret' },
            headers: { authorization: 'Bearer mcp-secret' },
          },
        ],
      },
    })
    expect(res.status).toBe(201)

    const body = (await res.json()) as { data: { id: string; metadata?: Record<string, unknown> } }
    const persisted = await config.runStore.get(body.data.id)
    const responseSerialized = JSON.stringify(body)
    const persistedSerialized = JSON.stringify(persisted)

    expect(body.data.metadata?.['environment']).toBe('test')
    expect(body.data.metadata?.['httpProfile']).toBe('public-api')
    expect(body.data.metadata?.['githubProfile']).toBe('release')
    expect(body.data.metadata?.['slackProfile']).toBe('ops')
    expect(responseSerialized).not.toContain('ghp-secret')
    expect(responseSerialized).not.toContain('xoxb-secret')
    expect(responseSerialized).not.toContain('Bearer secret')
    expect(responseSerialized).not.toContain('mcp-secret')
    expect(persistedSerialized).not.toContain('ghp-secret')
    expect(persistedSerialized).not.toContain('xoxb-secret')
    expect(persistedSerialized).not.toContain('Bearer secret')
    expect(persistedSerialized).not.toContain('mcp-secret')
  })

  it('emits agent:started event after creating a run', async () => {
    const events: Array<{ type: string }> = []
    config.eventBus.onAny((e) => events.push(e as { type: string }))

    await req(app, 'POST', '/api/runs', {
      agentId: 'agent-1',
      input: 'event test',
    })

    const startedEvent = events.find((e) => e.type === 'agent:started')
    expect(startedEvent).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// GET /api/runs — list
// ---------------------------------------------------------------------------

describe('GET /api/runs', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>

  beforeEach(async () => {
    config = createTestConfig()
    app = createForgeApp(config)
    await config.agentStore.save({
      id: 'agent-alpha',
      name: 'Alpha Agent',
      instructions: 'alpha',
      modelTier: 'chat',
    })
    await config.agentStore.save({
      id: 'agent-beta',
      name: 'Beta Agent',
      instructions: 'beta',
      modelTier: 'chat',
    })
  })

  it('200 — returns all runs with data array and count', async () => {
    await config.runStore.create({ agentId: 'agent-alpha', input: 'run-1' })
    await config.runStore.create({ agentId: 'agent-beta', input: 'run-2' })

    const res = await app.request('/api/runs')
    expect(res.status).toBe(200)

    const body = (await res.json()) as { data: unknown[]; count: number }
    expect(body.data).toHaveLength(2)
    expect(body.count).toBe(2)
  })

  it('redacts legacy secret metadata from list responses', async () => {
    await config.runStore.create({
      agentId: 'agent-alpha',
      input: 'legacy',
      metadata: {
        githubToken: 'ghp-legacy',
        httpHeaders: { authorization: 'Bearer legacy' },
        mcpServers: [{ id: 'mcp', url: 'https://mcp.example.com', env: { TOKEN: 'legacy-mcp' } }],
      },
    })

    const res = await app.request('/api/runs')
    expect(res.status).toBe(200)
    const serialized = JSON.stringify(await res.json())
    expect(serialized).not.toContain('ghp-legacy')
    expect(serialized).not.toContain('Bearer legacy')
    expect(serialized).not.toContain('legacy-mcp')
  })

  it('200 — returns empty list when no runs exist', async () => {
    const res = await app.request('/api/runs')
    expect(res.status).toBe(200)

    const body = (await res.json()) as { data: unknown[]; count: number }
    expect(body.data).toHaveLength(0)
    expect(body.count).toBe(0)
  })

  it('200 — filters by agentId returns only matching runs', async () => {
    await config.runStore.create({ agentId: 'agent-alpha', input: 'a1' })
    await config.runStore.create({ agentId: 'agent-alpha', input: 'a2' })
    await config.runStore.create({ agentId: 'agent-beta', input: 'b1' })

    const res = await app.request('/api/runs?agentId=agent-alpha')
    expect(res.status).toBe(200)

    const body = (await res.json()) as { data: Array<{ agentId: string }>; count: number }
    expect(body.count).toBe(2)
    for (const run of body.data) {
      expect(run.agentId).toBe('agent-alpha')
    }
  })

  it('200 — filters by status returns only runs in that state', async () => {
    const r1 = await config.runStore.create({ agentId: 'agent-alpha', input: 'x' })
    await config.runStore.update(r1.id, { status: 'completed' })
    await config.runStore.create({ agentId: 'agent-alpha', input: 'y' })

    const res = await app.request('/api/runs?status=completed')
    expect(res.status).toBe(200)

    const body = (await res.json()) as { data: Array<{ status: string }> }
    for (const run of body.data) {
      expect(run.status).toBe('completed')
    }
    expect(body.data.length).toBeGreaterThanOrEqual(1)
  })

  it('200 — limit caps the number of returned runs', async () => {
    for (let i = 0; i < 5; i++) {
      await config.runStore.create({ agentId: 'agent-alpha', input: `task-${i}` })
    }

    const res = await app.request('/api/runs?limit=3')
    expect(res.status).toBe(200)

    const body = (await res.json()) as { data: unknown[]; count: number }
    expect(body.data.length).toBeLessThanOrEqual(3)
    expect(body.count).toBeLessThanOrEqual(3)
  })

  it('200 — offset skips earlier runs', async () => {
    for (let i = 0; i < 4; i++) {
      await config.runStore.create({ agentId: 'agent-alpha', input: `task-${i}` })
    }

    const allRes = await app.request('/api/runs')
    const allBody = (await allRes.json()) as { data: unknown[] }
    const total = allBody.data.length

    const res = await app.request('/api/runs?offset=2')
    const body = (await res.json()) as { data: unknown[] }
    expect(body.data.length).toBeLessThanOrEqual(total - 2)
  })
})

// ---------------------------------------------------------------------------
// GET /api/runs/:id — get detail
// ---------------------------------------------------------------------------

describe('GET /api/runs/:id', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>

  beforeEach(async () => {
    config = createTestConfig()
    app = createForgeApp(config)
    await config.agentStore.save({
      id: 'agent-1',
      name: 'Test Agent',
      instructions: 'test',
      modelTier: 'chat',
    })
  })

  it('200 — returns run with all expected fields', async () => {
    const run = await config.runStore.create({
      agentId: 'agent-1',
      input: { prompt: 'hello' },
      metadata: { tag: 'integration' },
    })

    const res = await app.request(`/api/runs/${run.id}`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: {
        id: string
        agentId: string
        status: string
        input: unknown
        metadata: Record<string, unknown>
      }
    }
    expect(body.data.id).toBe(run.id)
    expect(body.data.agentId).toBe('agent-1')
    expect(body.data.status).toBe('queued')
    expect(body.data.input).toEqual({ prompt: 'hello' })
    expect(body.data.metadata['tag']).toBe('integration')
  })

  it('200 — returns run with updated status after state transition', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'test' })
    await config.runStore.update(run.id, { status: 'running' })

    const res = await app.request(`/api/runs/${run.id}`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { data: { status: string } }
    expect(body.data.status).toBe('running')
  })

  it('redacts legacy secret metadata from read responses', async () => {
    const run = await config.runStore.create({
      agentId: 'agent-1',
      input: 'legacy',
      metadata: {
        slackToken: 'xoxb-legacy',
        httpHeaders: { authorization: 'Bearer legacy-read' },
        mcpServers: [{ id: 'mcp', url: 'https://mcp.example.com', headers: { authorization: 'Bearer mcp-read' } }],
      },
    })

    const res = await app.request(`/api/runs/${run.id}`)
    expect(res.status).toBe(200)
    const serialized = JSON.stringify(await res.json())
    expect(serialized).not.toContain('xoxb-legacy')
    expect(serialized).not.toContain('Bearer legacy-read')
    expect(serialized).not.toContain('Bearer mcp-read')
  })

  it('404 — returns NOT_FOUND for unknown run id', async () => {
    const res = await app.request('/api/runs/does-not-exist')
    expect(res.status).toBe(404)

    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toMatch(/not found/i)
  })
})

// ---------------------------------------------------------------------------
// POST /api/runs/:id/cancel
// ---------------------------------------------------------------------------

describe('POST /api/runs/:id/cancel', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>

  beforeEach(async () => {
    config = createTestConfig()
    app = createForgeApp(config)
    await config.agentStore.save({
      id: 'agent-1',
      name: 'Test Agent',
      instructions: 'test',
      modelTier: 'chat',
    })
  })

  it('200 — cancels a queued run and returns cancelled status', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'queued task' })

    const res = await req(app, 'POST', `/api/runs/${run.id}/cancel`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { data: { status: string } }
    expect(body.data.status).toBe('cancelled')
  })

  it('200 — cancels a running run and persists the state change', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'running task' })
    await config.runStore.update(run.id, { status: 'running' })

    const res = await req(app, 'POST', `/api/runs/${run.id}/cancel`)
    expect(res.status).toBe(200)

    const persisted = await config.runStore.get(run.id)
    expect(persisted?.status).toBe('cancelled')
  })

  it('200 — emits agent:failed event after cancellation', async () => {
    const events: Array<{ type: string }> = []
    config.eventBus.onAny((e) => events.push(e as { type: string }))

    const run = await config.runStore.create({ agentId: 'agent-1', input: 'task' })
    await req(app, 'POST', `/api/runs/${run.id}/cancel`)

    const failedEvent = events.find((e) => e.type === 'agent:failed')
    expect(failedEvent).toBeDefined()
  })

  it('400 — returns INVALID_STATE for a completed run', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'done' })
    await config.runStore.update(run.id, { status: 'completed' })

    const res = await req(app, 'POST', `/api/runs/${run.id}/cancel`)
    expect(res.status).toBe(400)

    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INVALID_STATE')
    expect(body.error.message).toContain('completed')
  })

  it('400 — returns INVALID_STATE for a failed run', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'broken' })
    await config.runStore.update(run.id, { status: 'failed' })

    const res = await req(app, 'POST', `/api/runs/${run.id}/cancel`)
    expect(res.status).toBe(400)

    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_STATE')
  })

  it('400 — returns INVALID_STATE for an already-cancelled run', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'already done' })
    await config.runStore.update(run.id, { status: 'cancelled' })

    const res = await req(app, 'POST', `/api/runs/${run.id}/cancel`)
    expect(res.status).toBe(400)

    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INVALID_STATE')
    expect(body.error.message).toContain('cancelled')
  })

  it('404 — returns NOT_FOUND for unknown run id', async () => {
    const res = await req(app, 'POST', '/api/runs/no-such-run/cancel')
    expect(res.status).toBe(404)

    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// GET /api/runs/:id/logs
// ---------------------------------------------------------------------------

describe('GET /api/runs/:id/logs', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>

  beforeEach(async () => {
    config = createTestConfig()
    app = createForgeApp(config)
    await config.agentStore.save({
      id: 'agent-1',
      name: 'Test Agent',
      instructions: 'test',
      modelTier: 'chat',
    })
  })

  it('200 — returns empty log array for a run with no logs', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'quiet task' })

    const res = await app.request(`/api/runs/${run.id}/logs`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { data: unknown[] }
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data).toHaveLength(0)
  })

  it('200 — returns all logs with correct level, message and phase', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'logged task' })
    await config.runStore.addLog(run.id, { level: 'info', message: 'Starting phase', phase: 'init' })
    await config.runStore.addLog(run.id, { level: 'info', message: 'Calling LLM', phase: 'llm' })
    await config.runStore.addLog(run.id, { level: 'warn', message: 'Retrying tool', phase: 'tool_call' })

    const res = await app.request(`/api/runs/${run.id}/logs`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: Array<{ level: string; message: string; phase?: string }>
    }
    expect(body.data).toHaveLength(3)
    expect(body.data[0]?.level).toBe('info')
    expect(body.data[0]?.message).toBe('Starting phase')
    expect(body.data[0]?.phase).toBe('init')
    expect(body.data[2]?.level).toBe('warn')
    expect(body.data[2]?.phase).toBe('tool_call')
  })

  it('200 — logs include structured data payload when provided', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'data task' })
    await config.runStore.addLog(run.id, {
      level: 'info',
      message: 'Tool executed',
      phase: 'tool_call',
      data: { toolName: 'search', duration: 250 },
    })

    const res = await app.request(`/api/runs/${run.id}/logs`)
    const body = (await res.json()) as {
      data: Array<{ data?: Record<string, unknown> }>
    }
    expect(body.data[0]?.data?.['toolName']).toBe('search')
    expect(body.data[0]?.data?.['duration']).toBe(250)
  })

  it('404 — returns NOT_FOUND for unknown run id', async () => {
    const res = await app.request('/api/runs/ghost-run/logs')
    expect(res.status).toBe(404)

    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// GET /api/runs/:id/checkpoints
// ---------------------------------------------------------------------------

describe('GET /api/runs/:id/checkpoints', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>

  beforeEach(async () => {
    config = createTestConfig()
    app = createForgeApp(config)
    await config.agentStore.save({
      id: 'agent-1',
      name: 'Test Agent',
      instructions: 'test',
      modelTier: 'chat',
    })
  })

  it('501 — returns NOT_CONFIGURED when journal is absent', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'task' })

    const res = await app.request(`/api/runs/${run.id}/checkpoints`)
    expect(res.status).toBe(501)

    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_CONFIGURED')
  })

  it('404 — returns NOT_FOUND for unknown run when journal is configured', async () => {
    const configWithJournal = createTestConfig()
    configWithJournal.journal = {} as ForgeServerConfig['journal']
    const appWithJournal = createForgeApp(configWithJournal)

    const res = await appWithJournal.request('/api/runs/no-such-run/checkpoints')
    expect(res.status).toBe(404)

    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('200 — returns empty checkpoints array when journal has no entries for run', async () => {
    // Configure a minimal journal object — fromRunId will throw, which the handler
    // catches and returns empty checkpoints instead of an error.
    const configWithJournal = createTestConfig()
    configWithJournal.journal = {
      append: async () => {},
      read: async () => [],
    } as unknown as ForgeServerConfig['journal']
    await configWithJournal.agentStore.save({
      id: 'agent-1',
      name: 'Test Agent',
      instructions: 'test',
      modelTier: 'chat',
    })
    const appWithJournal = createForgeApp(configWithJournal)

    const run = await configWithJournal.runStore.create({ agentId: 'agent-1', input: 'fork base' })

    const res = await appWithJournal.request(`/api/runs/${run.id}/checkpoints`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { data: { runId: string; checkpoints: unknown[] } }
    expect(body.data.runId).toBe(run.id)
    expect(Array.isArray(body.data.checkpoints)).toBe(true)
  })
})
