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
  if (body) init.body = JSON.stringify(body)
  return app.request(path, init)
}

describe('Run pause/resume routes', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>

  beforeEach(async () => {
    config = createTestConfig()
    app = createForgeApp(config)
    // Seed an agent
    await config.agentStore.save({
      id: 'agent-1',
      name: 'Test Agent',
      instructions: 'test',
      modelTier: 'chat',
    })
  })

  // ── POST /api/runs/:id/pause ────────────────────────────────────────────

  describe('POST /api/runs/:id/pause', () => {
    it('happy path: running run transitions to paused', async () => {
      const run = await config.runStore.create({
        agentId: 'agent-1',
        input: 'task',
      })
      await config.runStore.update(run.id, { status: 'running' })

      const res = await req(app, 'POST', `/api/runs/${run.id}/pause`)
      expect(res.status).toBe(200)

      const data = (await res.json()) as { data: { runId: string; status: string } }
      expect(data.data.status).toBe('paused')
      expect(data.data.runId).toBe(run.id)

      // Verify persisted state
      const updated = await config.runStore.get(run.id)
      expect(updated!.status).toBe('paused')
    })

    it('returns 404 when run not found', async () => {
      const res = await req(app, 'POST', '/api/runs/nonexistent-id/pause')
      expect(res.status).toBe(404)

      const data = (await res.json()) as { error: { code: string } }
      expect(data.error.code).toBe('NOT_FOUND')
    })

    it('returns 400 when run is already in terminal state', async () => {
      const run = await config.runStore.create({
        agentId: 'agent-1',
        input: 'task',
      })
      await config.runStore.update(run.id, {
        status: 'completed',
        completedAt: new Date(),
      })

      const res = await req(app, 'POST', `/api/runs/${run.id}/pause`)
      expect(res.status).toBe(400)

      const data = (await res.json()) as { error: { code: string; message: string } }
      expect(data.error.code).toBe('INVALID_STATE')
      expect(data.error.message).toContain('completed')
    })

    it('returns 400 when run is in queued state (not running)', async () => {
      const run = await config.runStore.create({
        agentId: 'agent-1',
        input: 'task',
      })
      // Default status from create is 'queued' — not running

      const res = await req(app, 'POST', `/api/runs/${run.id}/pause`)
      expect(res.status).toBe(400)

      const data = (await res.json()) as { error: { code: string } }
      expect(data.error.code).toBe('INVALID_STATE')
    })
  })

  // ── POST /api/runs/:id/resume ───────────────────────────────────────────

  describe('POST /api/runs/:id/resume', () => {
    it('happy path: paused run transitions to running', async () => {
      const run = await config.runStore.create({
        agentId: 'agent-1',
        input: 'task',
      })
      await config.runStore.update(run.id, { status: 'paused' })

      const res = await req(app, 'POST', `/api/runs/${run.id}/resume`)
      expect(res.status).toBe(200)

      const data = (await res.json()) as { data: { runId: string; status: string } }
      expect(data.data.status).toBe('running')
      expect(data.data.runId).toBe(run.id)

      // Verify persisted state
      const updated = await config.runStore.get(run.id)
      expect(updated!.status).toBe('running')
    })

    it('returns 404 when run not found', async () => {
      const res = await req(app, 'POST', '/api/runs/nonexistent-id/resume')
      expect(res.status).toBe(404)

      const data = (await res.json()) as { error: { code: string } }
      expect(data.error.code).toBe('NOT_FOUND')
    })

    it('returns 400 when run is not paused or suspended', async () => {
      const run = await config.runStore.create({
        agentId: 'agent-1',
        input: 'task',
      })
      await config.runStore.update(run.id, { status: 'running' })

      const res = await req(app, 'POST', `/api/runs/${run.id}/resume`)
      expect(res.status).toBe(400)

      const data = (await res.json()) as { error: { code: string; message: string } }
      expect(data.error.code).toBe('INVALID_STATE')
      expect(data.error.message).toContain('running')
    })

    it('accepts resumeToken and input in request body', async () => {
      const run = await config.runStore.create({
        agentId: 'agent-1',
        input: 'task',
      })
      await config.runStore.update(run.id, { status: 'paused' })

      const res = await req(app, 'POST', `/api/runs/${run.id}/resume`, {
        resumeToken: 'tok-123',
        input: { approval: true },
      })
      expect(res.status).toBe(200)

      const data = (await res.json()) as { data: { status: string } }
      expect(data.data.status).toBe('running')
    })

    it('resumes a suspended run', async () => {
      const run = await config.runStore.create({
        agentId: 'agent-1',
        input: 'task',
      })
      await config.runStore.update(run.id, { status: 'suspended' })

      const res = await req(app, 'POST', `/api/runs/${run.id}/resume`)
      expect(res.status).toBe(200)

      const data = (await res.json()) as { data: { status: string } }
      expect(data.data.status).toBe('running')
    })
  })
})
