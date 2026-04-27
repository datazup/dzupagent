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
