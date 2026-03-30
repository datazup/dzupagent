import { describe, it, expect } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzipagent/core'

function createTestConfig(): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    benchmark: {
      executeTarget: async (_targetId, input) => `answer:${input}`,
    },
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

describe('Benchmark routes', () => {
  it('creates benchmark run and fetches it by id', async () => {
    const app = createForgeApp(createTestConfig())
    const createRes = await req(app, 'POST', '/api/benchmarks/runs', {
      suiteId: 'qa',
      targetId: 'target-1',
      strict: false,
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json() as {
      data: { id: string; suiteId: string; targetId: string; result: { suiteId: string } }
    }
    expect(created.data.suiteId).toBe('qa')
    expect(created.data.targetId).toBe('target-1')
    expect(created.data.result.suiteId).toBe('qa')

    const getRes = await app.request(`/api/benchmarks/runs/${created.data.id}`)
    expect(getRes.status).toBe(200)
    const fetched = await getRes.json() as { data: { id: string } }
    expect(fetched.data.id).toBe(created.data.id)
  })

  it('sets and lists baselines, then compares current run against baseline', async () => {
    const app = createForgeApp(createTestConfig())
    const run1Res = await req(app, 'POST', '/api/benchmarks/runs', {
      suiteId: 'qa',
      targetId: 'target-1',
    })
    const run1 = await run1Res.json() as { data: { id: string } }

    const baselineRes = await req(app, 'PUT', '/api/benchmarks/baselines/qa', {
      targetId: 'target-1',
      runId: run1.data.id,
    })
    expect(baselineRes.status).toBe(200)

    const listRes = await app.request('/api/benchmarks/baselines?suiteId=qa&targetId=target-1')
    expect(listRes.status).toBe(200)
    const listed = await listRes.json() as { count: number; data: Array<{ runId: string }> }
    expect(listed.count).toBe(1)
    expect(listed.data[0]?.runId).toBe(run1.data.id)

    const run2Res = await req(app, 'POST', '/api/benchmarks/runs', {
      suiteId: 'qa',
      targetId: 'target-1',
    })
    const run2 = await run2Res.json() as { data: { id: string } }

    const compareRes = await req(app, 'POST', '/api/benchmarks/compare', {
      currentRunId: run2.data.id,
    })
    expect(compareRes.status).toBe(200)
    const compared = await compareRes.json() as {
      data: {
        currentRun: { id: string }
        previousRun: { id: string }
        comparison: { improved: string[]; regressed: string[]; unchanged: string[] }
      }
    }
    expect(compared.data.currentRun.id).toBe(run2.data.id)
    expect(compared.data.previousRun.id).toBe(run1.data.id)
    expect(Array.isArray(compared.data.comparison.unchanged)).toBe(true)
  })

  it('returns 404 for unknown benchmark suite', async () => {
    const app = createForgeApp(createTestConfig())
    const res = await req(app, 'POST', '/api/benchmarks/runs', {
      suiteId: 'does-not-exist',
      targetId: 'target-1',
    })
    expect(res.status).toBe(404)
  })
})

