import { describe, it, expect, beforeEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import { InMemoryRunTraceStore } from '../persistence/run-trace-store.js'

function makeAuthTraceConfig(keyId: string, ownerId: string): ForgeServerConfig {
  const traceStore = new InMemoryRunTraceStore()
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    traceStore,
    auth: {
      mode: 'api-key',
      validateKey: async (_k: string) => ({ id: keyId, ownerId, role: 'operator' }),
    },
  }
}

function createTestConfig(): ForgeServerConfig {
  const traceStore = new InMemoryRunTraceStore()
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    traceStore,
  }
}

describe('Run trace routes — GET /api/runs/:id/messages', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>
  let traceStore: InMemoryRunTraceStore
  let runId: string

  beforeEach(async () => {
    config = createTestConfig()
    app = createForgeApp(config)
    traceStore = config.traceStore as InMemoryRunTraceStore

    await config.agentStore.save({
      id: 'agent-1',
      name: 'Test Agent',
      instructions: 'test',
      modelTier: 'chat',
    })

    const run = await config.runStore.create({ agentId: 'agent-1', input: 'test' })
    runId = run.id

    // Set up trace
    traceStore.startTrace(runId, 'agent-1')
    traceStore.addStep(runId, { timestamp: 1000, type: 'user_input', content: 'hello' })
    traceStore.addStep(runId, { timestamp: 2000, type: 'llm_request', content: 'req' })
    traceStore.addStep(runId, { timestamp: 3000, type: 'llm_response', content: 'response' })
    traceStore.addStep(runId, { timestamp: 4000, type: 'tool_call', content: { tool: 'search' } })
    traceStore.addStep(runId, { timestamp: 5000, type: 'tool_result', content: 'result' })
    traceStore.addStep(runId, { timestamp: 6000, type: 'output', content: 'final' })
    traceStore.completeTrace(runId)
  })

  it('returns full trace for a run', async () => {
    const res = await app.request(`/api/runs/${runId}/messages`)
    expect(res.status).toBe(200)
    const data = await res.json() as { data: { steps: unknown[]; totalSteps: number; distribution: Record<string, number> } }
    expect(data.data.totalSteps).toBe(6)
    expect(data.data.steps).toHaveLength(6)
    expect(data.data.distribution.user_input).toBe(1)
    expect(data.data.distribution.tool_call).toBe(1)
  })

  it('returns paginated range with from/to params', async () => {
    const res = await app.request(`/api/runs/${runId}/messages?from=1&to=4`)
    expect(res.status).toBe(200)
    const data = await res.json() as { data: { steps: unknown[]; range: { from: number; to: number } } }
    expect(data.data.steps).toHaveLength(3)
    expect(data.data.range.from).toBe(1)
    expect(data.data.range.to).toBe(4)
  })

  it('returns 400 for invalid from/to params', async () => {
    const res = await app.request(`/api/runs/${runId}/messages?from=abc&to=def`)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: { code: string } }
    expect(data.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 when run does not exist', async () => {
    const res = await app.request('/api/runs/nonexistent/messages')
    expect(res.status).toBe(404)
  })

  it('returns 404 when trace does not exist for a valid run', async () => {
    const run = await config.runStore.create({ agentId: 'agent-1', input: 'no trace' })
    const res = await app.request(`/api/runs/${run.id}/messages`)
    expect(res.status).toBe(404)
    const data = await res.json() as { error: { code: string } }
    expect(data.error.code).toBe('NOT_FOUND')
  })

  it('handles from-only pagination param', async () => {
    const res = await app.request(`/api/runs/${runId}/messages?from=3`)
    expect(res.status).toBe(200)
    const data = await res.json() as { data: { steps: unknown[] } }
    expect(data.data.steps).toHaveLength(3) // steps 3, 4, 5
  })

  it('handles to-only pagination param', async () => {
    const res = await app.request(`/api/runs/${runId}/messages?to=2`)
    expect(res.status).toBe(200)
    const data = await res.json() as { data: { steps: unknown[] } }
    expect(data.data.steps).toHaveLength(2) // steps 0, 1
  })
})

// ---------------------------------------------------------------------------
// MJ-SEC-02: owner isolation — /messages must reject cross-owner reads.
// ---------------------------------------------------------------------------
describe('MJ-SEC-02: owner isolation on /messages', () => {
  it('returns 404 on /messages when run belongs to a different owner', async () => {
    const cfg = makeAuthTraceConfig('key-A', 'owner-A')
    await cfg.agentStore.save({ id: 'ag1', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({ agentId: 'ag1', input: 'hi', ownerId: 'owner-B', tenantId: 'owner-B' })
    const traceStore = cfg.traceStore as InMemoryRunTraceStore
    traceStore.startTrace(run.id, 'ag1')
    traceStore.addStep(run.id, { timestamp: 1000, type: 'user_input', content: 'hello' })
    traceStore.completeTrace(run.id)
    const res = await createForgeApp(cfg).request(`/api/runs/${run.id}/messages`, {
      headers: { Authorization: 'Bearer tok' },
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })

  it('returns 200 on /messages when run owner matches requesting key', async () => {
    const cfg = makeAuthTraceConfig('owner-A', 'owner-A')
    await cfg.agentStore.save({ id: 'ag2', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({ agentId: 'ag2', input: 'hi', ownerId: 'owner-A', tenantId: 'owner-A' })
    const traceStore = cfg.traceStore as InMemoryRunTraceStore
    traceStore.startTrace(run.id, 'ag2')
    traceStore.addStep(run.id, { timestamp: 1000, type: 'user_input', content: 'hello' })
    traceStore.completeTrace(run.id)
    const res = await createForgeApp(cfg).request(`/api/runs/${run.id}/messages`, {
      headers: { Authorization: 'Bearer tok' },
    })
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// DZUPAGENT-ERR-H-01: owned-run logs and trace project failure detail safely.
// ---------------------------------------------------------------------------
describe('DZUPAGENT-ERR-H-01: client-safe projection of run logs and trace', () => {
  const MARKER = 'SECRET-MARKER-5e1d'
  const DETAIL = `connect ECONNREFUSED postgres://svc:${MARKER}@10.0.0.7:5432/runs`

  function makeRoleConfig(role: string): ForgeServerConfig {
    const cfg = makeAuthTraceConfig('owner-A', 'owner-A')
    return {
      ...cfg,
      auth: {
        mode: 'api-key',
        validateKey: async (_k: string) => ({ id: 'owner-A', ownerId: 'owner-A', role }),
      },
    }
  }

  async function seedFailedRun(cfg: ForgeServerConfig, ownerId = 'owner-A') {
    await cfg.agentStore.save({ id: 'ag-err', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({ agentId: 'ag-err', input: 'hi', ownerId, tenantId: ownerId })
    await cfg.runStore.addLog(run.id, {
      level: 'info',
      phase: 'tool_call',
      message: 'Tool call',
      data: {
        toolName: 'db.query',
        result: { rows: 0, error: { message: DETAIL, stack: `Error: ${DETAIL}\n    at query` } },
        attempts: [{ ok: false, errorMessage: DETAIL }],
      },
    })
    await cfg.runStore.addLog(run.id, {
      level: 'error',
      phase: 'run',
      message: 'Run failed',
      data: { error: DETAIL, traceId: 'trace-1' },
    })
    const traceStore = cfg.traceStore as InMemoryRunTraceStore
    traceStore.startTrace(run.id, 'ag-err')
    traceStore.addStep(run.id, { timestamp: 1000, type: 'user_input', content: 'hello' })
    traceStore.addStep(run.id, {
      timestamp: 2000,
      type: 'tool_result',
      content: { tool: 'db.query', error: DETAIL },
    })
    traceStore.addStep(run.id, {
      timestamp: 3000,
      type: 'system',
      content: { status: 'failed' },
      metadata: { error: DETAIL, nested: [{ cause: DETAIL }] },
    })
    traceStore.completeTrace(run.id)
    return run
  }

  async function get(cfg: ForgeServerConfig, path: string) {
    const res = await createForgeApp(cfg).request(path, { headers: { Authorization: 'Bearer tok' } })
    return { status: res.status, raw: await res.text() }
  }

  for (const role of ['viewer', 'operator']) {
    it(`redacts nested failure detail from /logs for a non-admin (${role}) owner`, async () => {
      const cfg = makeRoleConfig(role)
      const run = await seedFailedRun(cfg)

      const res = await get(cfg, `/api/runs/${run.id}/logs`)

      expect(res.status).toBe(200)
      expect(res.raw).not.toContain(MARKER)
      const body = JSON.parse(res.raw) as {
        data: Array<{ message: string; phase?: string; data?: Record<string, unknown> }>
      }
      expect(body.data).toHaveLength(2)
      const failure = body.data.find(l => l.message === 'Run failed')
      // Correlation and classification survive; only the detail is replaced.
      expect(failure?.data?.['traceId']).toBe('trace-1')
      expect(failure?.data?.['error']).toBe('Internal server error')
      const tool = body.data.find(l => l.phase === 'tool_call')
      expect(tool?.data?.['toolName']).toBe('db.query')
      expect((tool?.data?.['result'] as { rows: number }).rows).toBe(0)
    })

    it(`redacts nested failure detail from /trace for a non-admin (${role}) owner`, async () => {
      const cfg = makeRoleConfig(role)
      const run = await seedFailedRun(cfg)

      const res = await get(cfg, `/api/runs/${run.id}/trace`)

      expect(res.status).toBe(200)
      expect(res.raw).not.toContain(MARKER)
      const body = JSON.parse(res.raw) as {
        data: {
          events: unknown[]
          toolCalls: Array<{ data: Record<string, unknown> }>
          phases: string[]
          trace: { steps: Array<{ type: string; content: unknown; metadata?: Record<string, unknown> }>; totalSteps: number }
        }
      }
      expect(body.data.events).toHaveLength(2)
      expect(body.data.phases).toEqual(['tool_call', 'run'])
      expect(body.data.toolCalls[0]?.data['toolName']).toBe('db.query')
      expect(body.data.trace.totalSteps).toBe(3)
      const terminal = body.data.trace.steps.find(s => s.type === 'system')
      expect(terminal?.content).toEqual({ status: 'failed' })
      expect(terminal?.metadata?.['error']).toBe('Internal server error')
    })
  }

  it('keeps full failure detail on /logs and /trace for an admin', async () => {
    const cfg = makeRoleConfig('admin')
    const run = await seedFailedRun(cfg)

    const logs = await get(cfg, `/api/runs/${run.id}/logs`)
    const trace = await get(cfg, `/api/runs/${run.id}/trace`)

    expect(logs.status).toBe(200)
    expect(trace.status).toBe(200)
    expect(logs.raw).toContain(MARKER)
    expect(trace.raw).toContain(MARKER)
    const steps = (JSON.parse(trace.raw) as { data: { trace: { steps: Array<{ metadata?: Record<string, unknown> }> } } })
      .data.trace.steps
    expect(steps.some(s => s.metadata?.['error'] === DETAIL)).toBe(true)
  })

  it('still refuses a wrong-owner read of /logs and /trace with 404', async () => {
    const cfg = makeRoleConfig('operator')
    const run = await seedFailedRun(cfg, 'owner-B')

    for (const path of [`/api/runs/${run.id}/logs`, `/api/runs/${run.id}/trace`]) {
      const res = await get(cfg, path)
      expect(res.status).toBe(404)
      expect(res.raw).not.toContain(MARKER)
    }
  })

  // AUDIT-OTHER-REMOTE-FOUR-20261011-R1-A2: /messages replays the same steps.
  type MessagesBody = {
    data: {
      steps: Array<{ type: string; content: unknown; metadata?: Record<string, unknown> }>
      totalSteps: number
      distribution: Record<string, unknown>
    }
  }

  for (const role of ['viewer', 'operator']) {
    it(`redacts nested failure detail from full /messages for a non-admin (${role}) owner`, async () => {
      const cfg = makeRoleConfig(role)
      const run = await seedFailedRun(cfg)

      const res = await get(cfg, `/api/runs/${run.id}/messages`)

      expect(res.status).toBe(200)
      expect(res.raw).not.toContain(MARKER)
      const body = JSON.parse(res.raw) as MessagesBody
      expect(body.data.steps).toHaveLength(3)
      expect(body.data.totalSteps).toBe(3)
      expect(body.data.steps[0]?.content).toBe('hello')
      expect(body.data.steps[1]?.content).toEqual({ tool: 'db.query', error: 'Internal server error' })
      const terminal = body.data.steps.find(s => s.type === 'system')
      expect(terminal?.content).toEqual({ status: 'failed' })
      expect(terminal?.metadata).toEqual({
        error: 'Internal server error',
        nested: [{ cause: 'Internal server error' }],
      })
    })

    it(`redacts nested failure detail from paginated /messages for a non-admin (${role}) owner`, async () => {
      const cfg = makeRoleConfig(role)
      const run = await seedFailedRun(cfg)

      const res = await get(cfg, `/api/runs/${run.id}/messages?from=1&to=3`)

      expect(res.status).toBe(200)
      expect(res.raw).not.toContain(MARKER)
      const body = JSON.parse(res.raw) as MessagesBody
      expect(body.data.steps.map(s => s.type)).toEqual(['tool_result', 'system'])
      expect(body.data.steps[0]?.content).toEqual({ tool: 'db.query', error: 'Internal server error' })
      expect(body.data.steps[1]?.metadata?.['error']).toBe('Internal server error')
    })
  }

  it('keeps full failure detail on full and paginated /messages for an admin', async () => {
    const cfg = makeRoleConfig('admin')
    const run = await seedFailedRun(cfg)

    for (const path of [`/api/runs/${run.id}/messages`, `/api/runs/${run.id}/messages?from=1&to=3`]) {
      const res = await get(cfg, path)
      expect(res.status).toBe(200)
      expect(res.raw).toContain(MARKER)
      const steps = (JSON.parse(res.raw) as MessagesBody).data.steps
      expect(steps.some(s => s.metadata?.['error'] === DETAIL)).toBe(true)
    }
  })

  it('still refuses a wrong-owner read of full and paginated /messages with 404', async () => {
    const cfg = makeRoleConfig('operator')
    const run = await seedFailedRun(cfg, 'owner-B')

    for (const path of [`/api/runs/${run.id}/messages`, `/api/runs/${run.id}/messages?from=1&to=3`]) {
      const res = await get(cfg, path)
      expect(res.status).toBe(404)
      expect(res.raw).not.toContain(MARKER)
    }
  })
})
