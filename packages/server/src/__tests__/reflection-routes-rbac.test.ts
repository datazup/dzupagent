/**
 * DZUPAGENT-SEC-M-03 sibling sweep: tenant/owner scoping on reflection
 * telemetry list + pattern endpoints.
 *
 * Mirrors `routing-stats-rbac.test.ts` and `routing-stats-routes.test.ts`:
 *   - No apiKey  → unfiltered behaviour (preserves library default).
 *   - apiKey with tenantId  → only reflections from owned/same-tenant runs.
 *   - apiKey present but lacking string `id`  → 403.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { createReflectionRoutes } from '../routes/reflections.js'
import type { AppEnv } from '../types.js'
import type {
  ReflectionListOptions,
  ReflectionPattern,
  ReflectionPatternOptions,
  ReflectionSummary,
  RunReflectionStore,
} from '@dzupagent/agent'
import { InMemoryReflectionStore } from '@dzupagent/agent'
import { InMemoryRunStore } from '@dzupagent/core'

function makeSummary(overrides: Partial<ReflectionSummary> & { runId: string }): ReflectionSummary {
  return {
    completedAt: new Date('2026-05-20T12:00:00.000Z'),
    durationMs: 5000,
    totalSteps: 10,
    toolCallCount: 5,
    errorCount: 1,
    patterns: [],
    qualityScore: 0.85,
    ...overrides,
  }
}

interface Fixture {
  app: Hono<AppEnv>
  reflectionStore: RunReflectionStore
  runStore: InMemoryRunStore
}

async function makeFixture(): Promise<Fixture> {
  const reflectionStore = new InMemoryReflectionStore()
  const runStore = new InMemoryRunStore()

  // Two tenants, each with one run + one reflection.
  const runA = await runStore.create({
    agentId: 'agent-1',
    input: 'test',
    ownerId: 'key-tenant-a',
    tenantId: 'tenant-a',
  })
  const runB = await runStore.create({
    agentId: 'agent-1',
    input: 'test',
    ownerId: 'key-tenant-b',
    tenantId: 'tenant-b',
  })

  // RUN-REFLECTION-STORE-WIDEN: summaries now carry tenantId/ownerId so the
  // store-side filter is what makes the assertions pass (the route no longer
  // does a per-candidate runStore.get to figure out ownership).
  await reflectionStore.save(makeSummary({
    runId: runA.id,
    tenantId: 'tenant-a',
    ownerId: 'key-tenant-a',
    qualityScore: 0.9,
    patterns: [{ type: 'repeated_tool', description: 'tenant-a tool', occurrences: 2, stepIndices: [0, 1] }],
  }))
  await reflectionStore.save(makeSummary({
    runId: runB.id,
    tenantId: 'tenant-b',
    ownerId: 'key-tenant-b',
    qualityScore: 0.4,
    patterns: [{ type: 'repeated_tool', description: 'tenant-b tool', occurrences: 3, stepIndices: [0, 1, 2] }],
  }))

  const routes = createReflectionRoutes({ reflectionStore, runStore })
  const app = new Hono<AppEnv>()
  // Stub auth middleware: read the Bearer token and stash a fake apiKey on c.
  app.use('/api/reflections/*', async (c, next) => {
    const auth = c.req.header('Authorization')
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice('Bearer '.length)
      if (token === 'malformed') {
        c.set('apiKey', { tenantId: 'tenant-a' } as Record<string, unknown>)
      } else if (token === 'key-tenant-a') {
        c.set('apiKey', { id: 'key-tenant-a', tenantId: 'tenant-a' } as Record<string, unknown>)
      } else if (token === 'key-tenant-b') {
        c.set('apiKey', { id: 'key-tenant-b', tenantId: 'tenant-b' } as Record<string, unknown>)
      }
    }
    await next()
  })
  app.route('/api/reflections', routes)

  return { app, reflectionStore, runStore }
}

describe('Reflection routes — SEC-M-03 tenant/owner scoping (list)', () => {
  let fixture: Fixture
  beforeEach(async () => {
    fixture = await makeFixture()
  })

  it('returns all reflections when request is unauthenticated (legacy behaviour)', async () => {
    const res = await fixture.app.request('/api/reflections')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { reflections: ReflectionSummary[] }
    expect(body.reflections).toHaveLength(2)
  })

  it('scopes the list to the requesting tenant when authenticated', async () => {
    const res = await fixture.app.request('/api/reflections', {
      headers: { Authorization: 'Bearer key-tenant-a' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { reflections: ReflectionSummary[] }
    expect(body.reflections).toHaveLength(1)
    expect(body.reflections[0]!.qualityScore).toBe(0.9)
  })

  it('returns 403 when apiKey is present but has no string id', async () => {
    const res = await fixture.app.request('/api/reflections', {
      headers: { Authorization: 'Bearer malformed' },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toContain('reflections')
  })

  it('honours an over-fetch + post-filter when many reflections belong to other tenants', async () => {
    // Saturate tenant-b with extra reflections; tenant-a should still see only its own one.
    for (let i = 0; i < 50; i++) {
      const run = await fixture.runStore.create({
        agentId: 'agent-1',
        input: 'test',
        ownerId: 'key-tenant-b',
        tenantId: 'tenant-b',
      })
      await fixture.reflectionStore.save(makeSummary({
        runId: run.id,
        tenantId: 'tenant-b',
        ownerId: 'key-tenant-b',
      }))
    }
    const res = await fixture.app.request('/api/reflections?limit=10', {
      headers: { Authorization: 'Bearer key-tenant-a' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { reflections: ReflectionSummary[] }
    expect(body.reflections).toHaveLength(1)
  })
})

describe('Reflection routes — SEC-M-03 tenant/owner scoping (patterns)', () => {
  let fixture: Fixture
  beforeEach(async () => {
    fixture = await makeFixture()
  })

  it('returns all patterns when request is unauthenticated', async () => {
    const res = await fixture.app.request('/api/reflections/patterns/repeated_tool')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { patterns: Array<{ description: string }> }
    expect(body.patterns).toHaveLength(2)
  })

  it('scopes patterns to the requesting tenant when authenticated', async () => {
    const res = await fixture.app.request('/api/reflections/patterns/repeated_tool', {
      headers: { Authorization: 'Bearer key-tenant-a' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { patterns: Array<{ description: string }> }
    expect(body.patterns).toHaveLength(1)
    expect(body.patterns[0]!.description).toBe('tenant-a tool')
  })

  it('returns 403 when apiKey is present but has no string id', async () => {
    const res = await fixture.app.request('/api/reflections/patterns/repeated_tool', {
      headers: { Authorization: 'Bearer malformed' },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toContain('reflection patterns')
  })

  it('still validates pattern type before performing auth checks (400 wins)', async () => {
    const res = await fixture.app.request('/api/reflections/patterns/not_a_real_type', {
      headers: { Authorization: 'Bearer malformed' },
    })
    expect(res.status).toBe(400)
  })
})

describe('Reflection routes — GET /:runId ownership guard (MJ-SEC-02)', () => {
  let fixture: Fixture
  let runAId = ''
  let runBId = ''
  beforeEach(async () => {
    fixture = await makeFixture()
    runAId = ''
    runBId = ''
    // makeFixture creates exactly two runs + reflections; recover their ids
    // by joining the reflection summaries with their owning runs (the order
    // is an implementation detail of InMemoryReflectionStore.list()).
    const all = await fixture.reflectionStore.list(100)
    for (const r of all) {
      const run = await fixture.runStore.get(r.runId)
      if (run?.tenantId === 'tenant-a') runAId = r.runId
      if (run?.tenantId === 'tenant-b') runBId = r.runId
    }
  })

  it('returns the reflection unauth\'d when the runId exists (preserves legacy behaviour)', async () => {
    const res = await fixture.app.request(`/api/reflections/${runAId}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ReflectionSummary
    expect(body.qualityScore).toBe(0.9)
  })

  it('returns the reflection when authenticated request matches the run\'s tenant + owner', async () => {
    const res = await fixture.app.request(`/api/reflections/${runAId}`, {
      headers: { Authorization: 'Bearer key-tenant-a' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as ReflectionSummary
    expect(body.qualityScore).toBe(0.9)
  })

  it('returns 404 (not 403) when authenticated caller requests another tenant\'s run', async () => {
    const res = await fixture.app.request(`/api/reflections/${runBId}`, {
      headers: { Authorization: 'Bearer key-tenant-a' },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toBe('Run not found')
  })

  it('returns 404 when authenticated caller shares tenant but owner id differs', async () => {
    // Create a run in tenant-a but owned by a different key.
    const otherRun = await fixture.runStore.create({
      agentId: 'agent-1',
      input: 'test',
      ownerId: 'key-tenant-a-other',
      tenantId: 'tenant-a',
    })
    await fixture.reflectionStore.save(makeSummary({
      runId: otherRun.id,
      tenantId: 'tenant-a',
      ownerId: 'key-tenant-a-other',
      qualityScore: 0.1,
    }))

    const res = await fixture.app.request(`/api/reflections/${otherRun.id}`, {
      headers: { Authorization: 'Bearer key-tenant-a' },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns 404 for a runId that does not exist in the run store', async () => {
    const res = await fixture.app.request('/api/reflections/run-does-not-exist', {
      headers: { Authorization: 'Bearer key-tenant-a' },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toBe('Run not found')
  })
})

// ---------------------------------------------------------------------------
// RUN-REFLECTION-STORE-WIDEN: route delegates filtering to the store
// ---------------------------------------------------------------------------
describe('Reflection routes — store-side filter delegation (RUN-REFLECTION-STORE-WIDEN)', () => {
  /**
   * Build a spy store that records every call. The route should pass
   * `{ tenantId, ownerId, limit }` straight through and never do a
   * per-candidate `runStore.get(...)` lookup — that was the defense-in-depth
   * hack the widening retires.
   */
  function makeSpyStore(): RunReflectionStore & {
    listCalls: Array<number | ReflectionListOptions | undefined>
    getPatternsCalls: Array<[ReflectionPattern['type'], ReflectionPatternOptions | undefined]>
  } {
    const listCalls: Array<number | ReflectionListOptions | undefined> = []
    const getPatternsCalls: Array<[ReflectionPattern['type'], ReflectionPatternOptions | undefined]> = []
    const summary: ReflectionSummary = {
      runId: 'spy-run',
      completedAt: new Date('2026-05-20T00:00:00.000Z'),
      durationMs: 100,
      totalSteps: 1,
      toolCallCount: 0,
      errorCount: 0,
      patterns: [],
      qualityScore: 0.9,
      tenantId: 'tenant-a',
      ownerId: 'key-tenant-a',
    }
    const store: RunReflectionStore & {
      listCalls: typeof listCalls
      getPatternsCalls: typeof getPatternsCalls
    } = {
      save: vi.fn(async () => { /* noop */ }),
      get: vi.fn(async () => summary),
      list: vi.fn(async (opts?: number | ReflectionListOptions) => {
        listCalls.push(opts)
        return [summary]
      }),
      getPatterns: vi.fn(async (type: ReflectionPattern['type'], opts?: ReflectionPatternOptions) => {
        getPatternsCalls.push([type, opts])
        return []
      }),
      listCalls,
      getPatternsCalls,
    }
    return store
  }

  function buildApp(reflectionStore: RunReflectionStore, runStore?: InMemoryRunStore) {
    const routes = createReflectionRoutes(
      runStore ? { reflectionStore, runStore } : { reflectionStore },
    )
    const app = new Hono<AppEnv>()
    app.use('/api/reflections/*', async (c, next) => {
      const auth = c.req.header('Authorization')
      if (auth?.startsWith('Bearer ')) {
        const token = auth.slice('Bearer '.length)
        if (token === 'key-tenant-a') {
          c.set('apiKey', { id: 'key-tenant-a', tenantId: 'tenant-a' } as Record<string, unknown>)
        }
      }
      await next()
    })
    app.route('/api/reflections', routes)
    return app
  }

  it('GET / forwards { tenantId, ownerId, limit } to store.list', async () => {
    const spy = makeSpyStore()
    const app = buildApp(spy)
    const res = await app.request('/api/reflections?limit=7', {
      headers: { Authorization: 'Bearer key-tenant-a' },
    })
    expect(res.status).toBe(200)
    expect(spy.listCalls).toHaveLength(1)
    expect(spy.listCalls[0]).toEqual({ limit: 7, tenantId: 'tenant-a', ownerId: 'key-tenant-a' })
  })

  it('GET / sends limit-only opts when request is unauthenticated', async () => {
    const spy = makeSpyStore()
    const app = buildApp(spy)
    const res = await app.request('/api/reflections')
    expect(res.status).toBe(200)
    expect(spy.listCalls).toHaveLength(1)
    expect(spy.listCalls[0]).toEqual({ limit: 20 })
  })

  it('GET /patterns/:type forwards { tenantId, ownerId } to store.getPatterns', async () => {
    const spy = makeSpyStore()
    const app = buildApp(spy)
    const res = await app.request('/api/reflections/patterns/repeated_tool', {
      headers: { Authorization: 'Bearer key-tenant-a' },
    })
    expect(res.status).toBe(200)
    expect(spy.getPatternsCalls).toHaveLength(1)
    expect(spy.getPatternsCalls[0]).toEqual([
      'repeated_tool',
      { tenantId: 'tenant-a', ownerId: 'key-tenant-a' },
    ])
  })

  it('GET / does NOT call runStore.get per candidate (no defense-in-depth lookup)', async () => {
    const spy = makeSpyStore()
    const runStore = new InMemoryRunStore()
    const runStoreGetSpy = vi.spyOn(runStore, 'get')
    const app = buildApp(spy, runStore)
    const res = await app.request('/api/reflections', {
      headers: { Authorization: 'Bearer key-tenant-a' },
    })
    expect(res.status).toBe(200)
    expect(runStoreGetSpy).not.toHaveBeenCalled()
  })

  it('GET /patterns/:type does NOT call runStore.get per candidate', async () => {
    const spy = makeSpyStore()
    const runStore = new InMemoryRunStore()
    const runStoreGetSpy = vi.spyOn(runStore, 'get')
    const app = buildApp(spy, runStore)
    const res = await app.request('/api/reflections/patterns/repeated_tool', {
      headers: { Authorization: 'Bearer key-tenant-a' },
    })
    expect(res.status).toBe(200)
    expect(runStoreGetSpy).not.toHaveBeenCalled()
  })
})
