import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'

function createTestConfig(): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
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

describe('Run routes — extended coverage', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>

  afterEach(() => {
    vi.restoreAllMocks()
  })

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

  // ----------- Pause -----------

  it('POST /api/runs/:id/pause pauses a running run', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'test' })
    await config.runStore.update(run.id, { status: 'running' })

    const res = await req(app, 'POST', `/api/runs/${run.id}/pause`)
    expect(res.status).toBe(200)
    const data = await res.json() as { data: { status: string } }
    expect(data.data.status).toBe('paused')
  })

  it('POST /api/runs/:id/pause returns 400 if run is not running', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'test' })
    // status is 'queued'

    const res = await req(app, 'POST', `/api/runs/${run.id}/pause`)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: { code: string } }
    expect(data.error.code).toBe('INVALID_STATE')
  })

  it('POST /api/runs/:id/pause returns 404 for unknown run', async () => {
    const res = await req(app, 'POST', '/api/runs/nonexistent/pause')
    expect(res.status).toBe(404)
  })

  // ----------- Resume -----------

  it('POST /api/runs/:id/resume resumes a paused run', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'test' })
    await config.runStore.update(run.id, { status: 'paused' })

    const res = await req(app, 'POST', `/api/runs/${run.id}/resume`)
    expect(res.status).toBe(200)
    const data = await res.json() as { data: { status: string } }
    expect(data.data.status).toBe('running')
  })

  it('POST /api/runs/:id/resume resumes a suspended run', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'test' })
    await config.runStore.update(run.id, { status: 'suspended' })

    const res = await req(app, 'POST', `/api/runs/${run.id}/resume`)
    expect(res.status).toBe(200)
  })

  it('POST /api/runs/:id/resume returns 400 if run is not paused/suspended', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'test' })
    // status is 'queued'

    const res = await req(app, 'POST', `/api/runs/${run.id}/resume`)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: { code: string } }
    expect(data.error.code).toBe('INVALID_STATE')
  })

  it('POST /api/runs/:id/resume returns 404 for unknown run', async () => {
    const res = await req(app, 'POST', '/api/runs/nonexistent/resume')
    expect(res.status).toBe(404)
  })

  it('POST /api/runs/:id/resume accepts resumeToken and input in body', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'test' })
    await config.runStore.update(run.id, { status: 'paused' })

    const events: unknown[] = []
    config.eventBus.onAny((e) => events.push(e))

    const res = await req(app, 'POST', `/api/runs/${run.id}/resume`, {
      resumeToken: 'token-abc',
      input: { extra: 'data' },
    })
    expect(res.status).toBe(200)

    // Verify the event was emitted with resumeToken
    const resumeEvent = events.find((e: unknown) => (e as { type: string }).type === 'run:resumed')
    expect(resumeEvent).toBeDefined()
    expect((resumeEvent as { resumeToken?: string }).resumeToken).toBe('token-abc')
  })

  // ----------- Cancel edge cases -----------

  it('POST /api/runs/:id/cancel returns 404 for unknown run', async () => {
    const res = await req(app, 'POST', '/api/runs/nonexistent/cancel')
    expect(res.status).toBe(404)
  })

  it('POST /api/runs/:id/cancel returns 400 for completed run', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'test' })
    await config.runStore.update(run.id, { status: 'completed' })

    const res = await req(app, 'POST', `/api/runs/${run.id}/cancel`)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: { code: string } }
    expect(data.error.code).toBe('INVALID_STATE')
  })

  it('POST /api/runs/:id/cancel returns 400 for failed run', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'test' })
    await config.runStore.update(run.id, { status: 'failed' })

    const res = await req(app, 'POST', `/api/runs/${run.id}/cancel`)
    expect(res.status).toBe(400)
  })

  // ----------- Logs -----------

  it('GET /api/runs/:id/logs returns logs for a run', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'test' })
    await config.runStore.addLog(run.id, { level: 'info', message: 'Step 1', phase: 'init' })
    await config.runStore.addLog(run.id, { level: 'info', message: 'Step 2', phase: 'exec' })

    const res = await app.request(`/api/runs/${run.id}/logs`)
    expect(res.status).toBe(200)
    const data = await res.json() as { data: Array<{ message: string }> }
    expect(data.data).toHaveLength(2)
  })

  it('GET /api/runs/:id/logs returns 404 for unknown run', async () => {
    const res = await app.request('/api/runs/nonexistent/logs')
    expect(res.status).toBe(404)
  })

  // ----------- Trace -----------

  it('GET /api/runs/:id/trace returns execution trace with usage', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'test' })
    await config.runStore.addLog(run.id, {
      level: 'info',
      message: 'Called search',
      phase: 'tool_call',
      data: { toolName: 'search' },
    })
    await config.runStore.addLog(run.id, { level: 'info', message: 'LLM response', phase: 'llm' })

    const res = await app.request(`/api/runs/${run.id}/trace`)
    expect(res.status).toBe(200)
    const data = await res.json() as {
      data: {
        runId: string
        phases: string[]
        events: unknown[]
        toolCalls: unknown[]
        usage: { tokenUsage: { input: number; output: number } }
      }
    }
    expect(data.data.runId).toBe(run.id)
    expect(data.data.phases).toContain('tool_call')
    expect(data.data.phases).toContain('llm')
    expect(data.data.toolCalls).toHaveLength(1)
    expect(data.data.usage.tokenUsage.input).toBe(0)
  })

  it('GET /api/runs/:id/trace returns 404 for unknown run', async () => {
    const res = await app.request('/api/runs/nonexistent/trace')
    expect(res.status).toBe(404)
  })

  // ----------- List with filters -----------

  it('GET /api/runs filters by status', async () => {
    const run1 = await config.runStore.create({ agentId: 'agent-1', input: 'a' })
    await config.runStore.update(run1.id, { status: 'completed' })
    await config.runStore.create({ agentId: 'agent-1', input: 'b' })

    const res = await app.request('/api/runs?status=completed')
    const data = await res.json() as { data: Array<{ status: string }> }
    for (const run of data.data) {
      expect(run.status).toBe('completed')
    }
  })

  it('GET /api/runs respects limit and offset params', async () => {
    for (let i = 0; i < 5; i++) {
      await config.runStore.create({ agentId: 'agent-1', input: `task-${i}` })
    }

    const res = await app.request('/api/runs?limit=2&offset=1')
    expect(res.status).toBe(200)
    const data = await res.json() as { data: unknown[]; count: number }
    expect(data.count).toBeLessThanOrEqual(2)
  })

  // ----------- Fork / Checkpoints (no journal) -----------

  it('POST /api/runs/:id/fork returns 501 when journal is not configured', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'test' })
    const res = await req(app, 'POST', `/api/runs/${run.id}/fork`)
    expect(res.status).toBe(501)
    const data = await res.json() as { error: { code: string } }
    expect(data.error.code).toBe('NOT_CONFIGURED')
  })

  it('GET /api/runs/:id/checkpoints returns 501 when journal is not configured', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'test' })
    const res = await app.request(`/api/runs/${run.id}/checkpoints`)
    expect(res.status).toBe(501)
    const data = await res.json() as { error: { code: string } }
    expect(data.error.code).toBe('NOT_CONFIGURED')
  })

  it('POST /api/runs/:id/fork returns 404 for unknown run', async () => {
    // Need journal to get past the 501 check; mock a minimal journal
    const configWithJournal = createTestConfig()
    configWithJournal.journal = {} as ForgeServerConfig['journal']
    const appWithJournal = createForgeApp(configWithJournal)

    const res = await req(appWithJournal, 'POST', '/api/runs/nonexistent/fork')
    expect(res.status).toBe(404)
  })

  it('GET /api/runs/:id/checkpoints returns 404 for unknown run', async () => {
    const configWithJournal = createTestConfig()
    configWithJournal.journal = {} as ForgeServerConfig['journal']
    const appWithJournal = createForgeApp(configWithJournal)

    const res = await appWithJournal.request('/api/runs/nonexistent/checkpoints')
    expect(res.status).toBe(404)
  })
})
