import { describe, it, expect, beforeEach } from 'vitest'
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

describe('Approval routes — extended', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>

  beforeEach(async () => {
    config = createTestConfig()
    app = createForgeApp(config)
    await config.agentStore.save({ id: 'a1', name: 'A', instructions: 'i', modelTier: 'chat' })
  })

  // ----------- Approve -----------

  it('approve returns 404 for unknown run', async () => {
    const res = await req(app, 'POST', '/api/runs/nonexistent/approve')
    expect(res.status).toBe(404)
  })

  it('approve emits approval:granted event', async () => {
    const run = await config.runStore.create({ agentId: 'a1', input: 'test' })
    await config.runStore.update(run.id, { status: 'awaiting_approval' })

    const events: unknown[] = []
    config.eventBus.onAny((e) => events.push(e))

    await req(app, 'POST', `/api/runs/${run.id}/approve`)

    const approvalEvent = events.find((e: unknown) => (e as { type: string }).type === 'approval:granted')
    expect(approvalEvent).toBeDefined()
    expect((approvalEvent as { runId: string }).runId).toBe(run.id)
  })

  it('approve adds a log entry', async () => {
    const run = await config.runStore.create({ agentId: 'a1', input: 'test' })
    await config.runStore.update(run.id, { status: 'awaiting_approval' })

    await req(app, 'POST', `/api/runs/${run.id}/approve`)

    const logs = await config.runStore.getLogs(run.id)
    expect(logs.some((l: { message: string }) => l.message === 'Run approved')).toBe(true)
  })

  // ----------- Reject -----------

  it('reject returns 404 for unknown run', async () => {
    const res = await req(app, 'POST', '/api/runs/nonexistent/reject')
    expect(res.status).toBe(404)
  })

  it('reject uses default reason when none provided', async () => {
    const run = await config.runStore.create({ agentId: 'a1', input: 'test' })
    await config.runStore.update(run.id, { status: 'awaiting_approval' })

    const res = await req(app, 'POST', `/api/runs/${run.id}/reject`)
    expect(res.status).toBe(200)
    const data = await res.json() as { data: { reason: string } }
    expect(data.data.reason).toBe('Rejected by user')
  })

  it('reject emits approval:rejected event with reason', async () => {
    const run = await config.runStore.create({ agentId: 'a1', input: 'test' })
    await config.runStore.update(run.id, { status: 'awaiting_approval' })

    const events: unknown[] = []
    config.eventBus.onAny((e) => events.push(e))

    await req(app, 'POST', `/api/runs/${run.id}/reject`, { reason: 'Too expensive' })

    const rejectEvent = events.find((e: unknown) => (e as { type: string }).type === 'approval:rejected')
    expect(rejectEvent).toBeDefined()
    expect((rejectEvent as { reason: string }).reason).toBe('Too expensive')
  })

  it('reject sets completedAt on the run', async () => {
    const run = await config.runStore.create({ agentId: 'a1', input: 'test' })
    await config.runStore.update(run.id, { status: 'awaiting_approval' })

    await req(app, 'POST', `/api/runs/${run.id}/reject`, { reason: 'No' })

    const updated = await config.runStore.get(run.id)
    expect(updated?.completedAt).toBeTruthy()
  })

  it('reject returns 400 for already-completed run', async () => {
    const run = await config.runStore.create({ agentId: 'a1', input: 'test' })
    await config.runStore.update(run.id, { status: 'completed' })

    const res = await req(app, 'POST', `/api/runs/${run.id}/reject`)
    expect(res.status).toBe(400)
  })

  it('reject handles malformed JSON body gracefully', async () => {
    const run = await config.runStore.create({ agentId: 'a1', input: 'test' })
    await config.runStore.update(run.id, { status: 'awaiting_approval' })

    const res = await app.request(`/api/runs/${run.id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    // Should still work with default reason
    expect(res.status).toBe(200)
    const data = await res.json() as { data: { reason: string } }
    expect(data.data.reason).toBe('Rejected by user')
  })
})
