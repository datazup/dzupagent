/**
 * Cross-tenant isolation coverage for benchmark routes (DZUPAGENT-SEC-H-01).
 *
 * Mirrors the pattern in `cluster-routes.test.ts` / `learning-routes.test.ts`:
 * a tiny middleware reads `x-test-tenant` and populates `c.set('apiKey', ...)`
 * so `getRequestingTenantId(c)` resolves to that tenant. Each test then
 * verifies that one tenant cannot list, fetch, mutate, or baseline the
 * benchmark rows owned by another tenant.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createBenchmarkRoutes } from '../routes/benchmarks.js'
import { InMemoryBenchmarkRunStore } from '../persistence/benchmark-run-store.js'
import { BenchmarkOrchestrator } from '@dzupagent/evals'
import type { BenchmarkSuite } from '@dzupagent/eval-contracts'
import type { AppEnv } from '../types.js'

const qaSuite: BenchmarkSuite = {
  id: 'qa',
  name: 'QA Suite',
  description: 'Default QA benchmark suite for tenant tests',
  category: 'qa',
  dataset: [{ id: 'q1', input: 'hello', expectedOutput: 'answer:hello' }],
  scorers: [],
  baselineThresholds: {},
}

function createTenantApp() {
  const store = new InMemoryBenchmarkRunStore()
  const suites = { qa: qaSuite }
  const orchestrator = new BenchmarkOrchestrator({
    suites,
    executeTarget: async (_targetId, input) => `answer:${input}`,
    store,
  })

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    const tenantId = c.req.header('x-test-tenant')
    if (tenantId) {
      c.set('apiKey', { id: `key-${tenantId}`, tenantId })
    }
    await next()
  })
  app.route(
    '/api/benchmarks',
    createBenchmarkRoutes({
      executeTarget: async (_targetId, input) => `answer:${input}`,
      suites,
      store,
      orchestrator,
    }),
  )
  return { app, store, orchestrator }
}

function tenantHeaders(tenantId: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'x-test-tenant': tenantId,
  }
}

async function createRun(app: Hono<AppEnv>, tenantId: string, body?: Record<string, unknown>) {
  return app.request('/api/benchmarks/runs', {
    method: 'POST',
    headers: tenantHeaders(tenantId),
    body: JSON.stringify({
      suiteId: 'qa',
      targetId: 'target-1',
      ...(body ?? {}),
    }),
  })
}

describe('Benchmark routes — tenant isolation (DZUPAGENT-SEC-H-01)', () => {
  let app: Hono<AppEnv>
  let store: InMemoryBenchmarkRunStore

  beforeEach(() => {
    const ctx = createTenantApp()
    app = ctx.app
    store = ctx.store
  })

  it('GET /runs returns only the requesting tenant\'s runs', async () => {
    const aRes = await createRun(app, 'tenant-a')
    expect(aRes.status).toBe(201)
    const bRes = await createRun(app, 'tenant-b')
    expect(bRes.status).toBe(201)
    const cRes = await createRun(app, 'tenant-a')
    expect(cRes.status).toBe(201)

    const listA = await app.request('/api/benchmarks/runs', {
      headers: tenantHeaders('tenant-a'),
    })
    expect(listA.status).toBe(200)
    const bodyA = await listA.json() as { count: number; data: Array<{ id: string }> }
    expect(bodyA.count).toBe(2)
    expect(bodyA.data.every((r) => r.id !== undefined)).toBe(true)

    const listB = await app.request('/api/benchmarks/runs', {
      headers: tenantHeaders('tenant-b'),
    })
    const bodyB = await listB.json() as { count: number; data: Array<{ id: string }> }
    expect(bodyB.count).toBe(1)
  })

  it('GET /runs/:id returns 404 for another tenant\'s run', async () => {
    const create = await createRun(app, 'tenant-a')
    const created = await create.json() as { data: { id: string } }
    const runId = created.data.id

    const ok = await app.request(`/api/benchmarks/runs/${runId}`, {
      headers: tenantHeaders('tenant-a'),
    })
    expect(ok.status).toBe(200)

    const denied = await app.request(`/api/benchmarks/runs/${runId}`, {
      headers: tenantHeaders('tenant-b'),
    })
    expect(denied.status).toBe(404)
    const deniedBody = await denied.json() as { error: { code: string } }
    expect(deniedBody.error.code).toBe('NOT_FOUND')
  })

  it('POST /runs forces metadata.tenantId to the requesting tenant even when spoofed', async () => {
    const spoofed = await createRun(app, 'tenant-a', {
      metadata: { tenantId: 'tenant-b', extra: 'value' },
    })
    expect(spoofed.status).toBe(201)
    const body = await spoofed.json() as {
      data: { id: string; metadata: Record<string, unknown> }
    }
    expect(body.data.metadata.tenantId).toBe('tenant-a')
    // Tenant B must NOT be able to read the run even though they were named
    // in the spoofed body.
    const otherTenant = await app.request(`/api/benchmarks/runs/${body.data.id}`, {
      headers: tenantHeaders('tenant-b'),
    })
    expect(otherTenant.status).toBe(404)
  })

  it('PUT /baselines/:suiteId rejects cross-tenant run references with 404', async () => {
    const aCreate = await createRun(app, 'tenant-a')
    const aRun = await aCreate.json() as { data: { id: string } }

    const denied = await app.request('/api/benchmarks/baselines/qa', {
      method: 'PUT',
      headers: tenantHeaders('tenant-b'),
      body: JSON.stringify({ targetId: 'target-1', runId: aRun.data.id }),
    })
    expect(denied.status).toBe(404)
    const deniedBody = await denied.json() as { error: { code: string; message: string } }
    expect(deniedBody.error.code).toBe('BASELINE_UPDATE_FAILED')
    expect(deniedBody.error.message).toContain('not found')

    // State did not mutate — tenant-b still cannot list any baselines, even
    // for the qa suite.
    const baselinesB = await app.request('/api/benchmarks/baselines?suiteId=qa', {
      headers: tenantHeaders('tenant-b'),
    })
    const baselinesBBody = await baselinesB.json() as { count: number }
    expect(baselinesBBody.count).toBe(0)
  })

  it('GET /baselines and GET /baselines (filtered) hide cross-tenant baselines', async () => {
    const aCreate = await createRun(app, 'tenant-a')
    const aRun = await aCreate.json() as { data: { id: string } }
    const setA = await app.request('/api/benchmarks/baselines/qa', {
      method: 'PUT',
      headers: tenantHeaders('tenant-a'),
      body: JSON.stringify({ targetId: 'target-1', runId: aRun.data.id }),
    })
    expect(setA.status).toBe(200)

    const listA = await app.request('/api/benchmarks/baselines?suiteId=qa', {
      headers: tenantHeaders('tenant-a'),
    })
    const listABody = await listA.json() as { count: number }
    expect(listABody.count).toBe(1)

    const listB = await app.request('/api/benchmarks/baselines?suiteId=qa', {
      headers: tenantHeaders('tenant-b'),
    })
    const listBBody = await listB.json() as { count: number }
    expect(listBBody.count).toBe(0)
  })

  it('POST /compare returns 404 when the current/previous run belongs to another tenant', async () => {
    const aCreate1 = await createRun(app, 'tenant-a')
    const aRun1 = await aCreate1.json() as { data: { id: string } }
    const aCreate2 = await createRun(app, 'tenant-a')
    const aRun2 = await aCreate2.json() as { data: { id: string } }

    // Tenant B tries to compare two tenant-A runs.
    const denied = await app.request('/api/benchmarks/compare', {
      method: 'POST',
      headers: tenantHeaders('tenant-b'),
      body: JSON.stringify({
        currentRunId: aRun2.data.id,
        previousRunId: aRun1.data.id,
      }),
    })
    expect(denied.status).toBe(404)
    const deniedBody = await denied.json() as { error: { code: string; message: string } }
    expect(deniedBody.error.code).toBe('BENCHMARK_COMPARE_FAILED')
    expect(deniedBody.error.message).toContain('not found')
  })

  it('GET /runs?suiteId paginates within tenant scope and excludes cross-tenant rows', async () => {
    // Seed three tenant-a runs interleaved with two tenant-b runs.
    await createRun(app, 'tenant-a', { targetId: 'a1' })
    await createRun(app, 'tenant-b', { targetId: 'b1' })
    await createRun(app, 'tenant-a', { targetId: 'a2' })
    await createRun(app, 'tenant-b', { targetId: 'b2' })
    await createRun(app, 'tenant-a', { targetId: 'a3' })

    // Sanity check: underlying store actually holds 5 rows.
    const all = await store.listRuns({ limit: 100 })
    expect(all.data.length).toBe(5)

    const tenantARes = await app.request('/api/benchmarks/runs?limit=10', {
      headers: tenantHeaders('tenant-a'),
    })
    expect(tenantARes.status).toBe(200)
    const tenantABody = await tenantARes.json() as {
      data: Array<{ id: string; metadata?: { tenantId: string } }>
      count: number
    }
    expect(tenantABody.count).toBe(3)
    expect(tenantABody.data.every((r) => r.metadata?.tenantId === 'tenant-a')).toBe(true)
  })
})
