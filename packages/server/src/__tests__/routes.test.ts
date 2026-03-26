import { describe, it, expect, beforeEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@forgeagent/core'
import type { RunQueue, RunJob, JobProcessor, QueueStats } from '../queue/run-queue.js'

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

describe('Health routes', () => {
  it('GET /api/health returns 200', async () => {
    const app = createForgeApp(createTestConfig())
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data['status']).toBe('ok')
  })

  it('GET /api/health/ready checks stores', async () => {
    const app = createForgeApp(createTestConfig())
    const res = await app.request('/api/health/ready')
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data['status']).toBe('ok')
  })
})

describe('Agent routes', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>

  beforeEach(() => {
    config = createTestConfig()
    app = createForgeApp(config)
  })

  it('POST /api/agents creates an agent', async () => {
    const res = await req(app, 'POST', '/api/agents', {
      name: 'Test Agent',
      instructions: 'You are a test agent',
      modelTier: 'chat',
    })
    expect(res.status).toBe(201)
    const data = await res.json() as { data: { id: string; name: string } }
    expect(data.data.name).toBe('Test Agent')
    expect(data.data.id).toBeTruthy()
  })

  it('GET /api/agents lists agents', async () => {
    await req(app, 'POST', '/api/agents', { name: 'A1', instructions: 'i1', modelTier: 'chat' })
    await req(app, 'POST', '/api/agents', { name: 'A2', instructions: 'i2', modelTier: 'codegen' })

    const res = await app.request('/api/agents')
    expect(res.status).toBe(200)
    const data = await res.json() as { data: unknown[]; count: number }
    expect(data.count).toBe(2)
  })

  it('GET /api/agents/:id returns 404 for unknown', async () => {
    const res = await app.request('/api/agents/nonexistent')
    expect(res.status).toBe(404)
  })

  it('PATCH /api/agents/:id updates agent', async () => {
    const createRes = await req(app, 'POST', '/api/agents', { name: 'Original', instructions: 'i1', modelTier: 'chat' })
    const created = await createRes.json() as { data: { id: string } }
    const id = created.data.id

    const updateRes = await req(app, 'PATCH', `/api/agents/${id}`, { name: 'Updated' })
    expect(updateRes.status).toBe(200)
    const updated = await updateRes.json() as { data: { name: string } }
    expect(updated.data.name).toBe('Updated')
  })

  it('DELETE /api/agents/:id soft-deletes', async () => {
    const createRes = await req(app, 'POST', '/api/agents', { name: 'ToDelete', instructions: 'i1', modelTier: 'chat' })
    const created = await createRes.json() as { data: { id: string } }

    const delRes = await req(app, 'DELETE', `/api/agents/${created.data.id}`)
    expect(delRes.status).toBe(200)
  })

  it('POST /api/agents returns 400 without required fields', async () => {
    const res = await req(app, 'POST', '/api/agents', { name: 'NoInstructions' })
    expect(res.status).toBe(400)
  })
})

describe('Run routes', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>

  beforeEach(async () => {
    config = createTestConfig()
    app = createForgeApp(config)
    // Create an agent first
    await config.agentStore.save({
      id: 'agent-1',
      name: 'Test Agent',
      instructions: 'test',
      modelTier: 'chat',
    })
  })

  it('POST /api/runs creates a run', async () => {
    const res = await req(app, 'POST', '/api/runs', {
      agentId: 'agent-1',
      input: { task: 'test' },
    })
    expect(res.status).toBe(201)
    const data = await res.json() as { data: { id: string; status: string } }
    expect(data.data.status).toBe('queued')
  })

  it('POST /api/runs returns 404 when agent does not exist', async () => {
    const res = await req(app, 'POST', '/api/runs', {
      agentId: 'missing-agent',
      input: { task: 'test' },
    })
    expect(res.status).toBe(404)
  })

  it('POST /api/runs enqueues work and returns 202 when runQueue is configured', async () => {
    class MockRunQueue implements RunQueue {
      enqueued: Array<Omit<RunJob, 'id' | 'createdAt' | 'attempts'>> = []
      async enqueue(job: Omit<RunJob, 'id' | 'createdAt' | 'attempts'>): Promise<RunJob> {
        this.enqueued.push(job)
        return {
          ...job,
          attempts: 0,
          id: 'job-1',
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
        }
      }
      start(_processor: JobProcessor): void {}
      async stop(_waitForActive?: boolean): Promise<void> {}
      cancel(_runId: string): boolean { return false }
      stats(): QueueStats {
        return { pending: this.enqueued.length, active: 0, completed: 0, failed: 0, deadLetter: 0 }
      }
      getDeadLetter() { return [] }
      clearDeadLetter(): void {}
    }

    const runQueue = new MockRunQueue()
    const queueConfig = createTestConfig()
    queueConfig.runQueue = runQueue
    queueConfig.runExecutor = async () => ({ message: 'ok' })
    await queueConfig.agentStore.save({
      id: 'agent-queue',
      name: 'Queue Agent',
      instructions: 'test',
      modelTier: 'chat',
    })
    const queueApp = createForgeApp(queueConfig)

    const res = await req(queueApp, 'POST', '/api/runs', {
      agentId: 'agent-queue',
      input: { task: 'queued' },
      metadata: { priority: 2 },
    })
    expect(res.status).toBe(202)
    const data = await res.json() as {
      data: { id: string; status: string; agentId: string }
      queue: { accepted: boolean; jobId: string; priority: number }
    }
    expect(data.data.status).toBe('queued')
    expect(data.data.agentId).toBe('agent-queue')
    expect(data.queue.accepted).toBe(true)
    expect(data.queue.jobId).toBe('job-1')
    expect(data.queue.priority).toBe(2)
    expect(runQueue.enqueued).toHaveLength(1)
    expect(runQueue.enqueued[0]?.runId).toBe(data.data.id)
  })

  it('POST /api/runs enqueues successfully with default executor when runQueue is configured without runExecutor', async () => {
    class MockRunQueue implements RunQueue {
      async enqueue(job: Omit<RunJob, 'id' | 'createdAt' | 'attempts'>): Promise<RunJob> {
        return {
          ...job,
          attempts: 0,
          id: 'job-unexpected',
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
        }
      }
      start(_processor: JobProcessor): void {}
      async stop(_waitForActive?: boolean): Promise<void> {}
      cancel(_runId: string): boolean { return false }
      stats(): QueueStats {
        return { pending: 0, active: 0, completed: 0, failed: 0, deadLetter: 0 }
      }
      getDeadLetter() { return [] }
      clearDeadLetter(): void {}
    }

    const queueConfig = createTestConfig()
    queueConfig.runQueue = new MockRunQueue()
    await queueConfig.agentStore.save({
      id: 'agent-queue-misconfigured',
      name: 'Queue Agent',
      instructions: 'test',
      modelTier: 'chat',
    })
    const queueApp = createForgeApp(queueConfig)

    const res = await req(queueApp, 'POST', '/api/runs', {
      agentId: 'agent-queue-misconfigured',
      input: { task: 'queued' },
    })
    expect(res.status).toBe(202)
    const data = await res.json() as { queue: { accepted: boolean; jobId: string } }
    expect(data.queue.accepted).toBe(true)
    expect(data.queue.jobId).toBe('job-unexpected')
  })

  it('GET /api/runs lists runs', async () => {
    await req(app, 'POST', '/api/runs', { agentId: 'agent-1', input: 'task1' })
    await req(app, 'POST', '/api/runs', { agentId: 'agent-1', input: 'task2' })

    const res = await app.request('/api/runs')
    expect(res.status).toBe(200)
    const data = await res.json() as { data: unknown[]; count: number }
    expect(data.count).toBe(2)
  })

  it('GET /api/runs/:id returns a run', async () => {
    const createRes = await req(app, 'POST', '/api/runs', { agentId: 'agent-1', input: 'test' })
    const created = await createRes.json() as { data: { id: string } }

    const res = await app.request(`/api/runs/${created.data.id}`)
    expect(res.status).toBe(200)
  })

  it('GET /api/runs/:id returns 404 for unknown', async () => {
    const res = await app.request('/api/runs/nonexistent')
    expect(res.status).toBe(404)
  })

  it('POST /api/runs/:id/cancel cancels a run', async () => {
    const createRes = await req(app, 'POST', '/api/runs', { agentId: 'agent-1', input: 'test' })
    const created = await createRes.json() as { data: { id: string } }

    const cancelRes = await req(app, 'POST', `/api/runs/${created.data.id}/cancel`)
    expect(cancelRes.status).toBe(200)
    const data = await cancelRes.json() as { data: { status: string } }
    expect(data.data.status).toBe('cancelled')
  })

  it('POST /api/runs returns 400 without agentId', async () => {
    const res = await req(app, 'POST', '/api/runs', { input: 'no agent' })
    expect(res.status).toBe(400)
  })

  it('GET /api/runs filters by agentId', async () => {
    await req(app, 'POST', '/api/runs', { agentId: 'agent-1', input: 'a' })

    const res = await app.request('/api/runs?agentId=agent-1')
    const data = await res.json() as { data: unknown[] }
    expect(data.data.length).toBeGreaterThanOrEqual(1)
  })
})

describe('Approval routes', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>

  beforeEach(async () => {
    config = createTestConfig()
    app = createForgeApp(config)
    // Create agent and run in awaiting_approval state
    await config.agentStore.save({ id: 'a1', name: 'A', instructions: 'i', modelTier: 'chat' })
    const run = await config.runStore.create({ agentId: 'a1', input: 'test' })
    await config.runStore.update(run.id, { status: 'awaiting_approval' })
  })

  it('POST /api/runs/:id/approve approves a run', async () => {
    const runs = await config.runStore.list()
    const run = runs[0]!
    expect(run.status).toBe('awaiting_approval')

    const res = await req(app, 'POST', `/api/runs/${run.id}/approve`)
    expect(res.status).toBe(200)
    const data = await res.json() as { data: { status: string } }
    expect(data.data.status).toBe('approved')
  })

  it('POST /api/runs/:id/reject rejects a run', async () => {
    const runs = await config.runStore.list()
    const run = runs[0]!

    const res = await req(app, 'POST', `/api/runs/${run.id}/reject`, { reason: 'Not ready' })
    expect(res.status).toBe(200)
    const data = await res.json() as { data: { status: string; reason: string } }
    expect(data.data.status).toBe('rejected')
    expect(data.data.reason).toBe('Not ready')
  })

  it('POST /api/runs/:id/approve returns 400 if not awaiting', async () => {
    const run = await config.runStore.create({ agentId: 'a1', input: 'test2' })
    // status is 'queued', not 'awaiting_approval'

    const res = await req(app, 'POST', `/api/runs/${run.id}/approve`)
    expect(res.status).toBe(400)
  })
})
