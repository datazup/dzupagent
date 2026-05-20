/**
 * DZUPAGENT-SEC-M-03 sibling sweep: tenant/owner scoping on reflection
 * telemetry list + pattern endpoints.
 *
 * Mirrors `routing-stats-rbac.test.ts` and `routing-stats-routes.test.ts`:
 *   - No apiKey  → unfiltered behaviour (preserves library default).
 *   - apiKey with tenantId  → only reflections from owned/same-tenant runs.
 *   - apiKey present but lacking string `id`  → 403.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createReflectionRoutes } from '../routes/reflections.js'
import type { AppEnv } from '../types.js'
import type { ReflectionSummary, RunReflectionStore } from '@dzupagent/agent'
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

  await reflectionStore.save(makeSummary({
    runId: runA.id,
    qualityScore: 0.9,
    patterns: [{ type: 'repeated_tool', description: 'tenant-a tool', occurrences: 2, stepIndices: [0, 1] }],
  }))
  await reflectionStore.save(makeSummary({
    runId: runB.id,
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
      await fixture.reflectionStore.save(makeSummary({ runId: run.id }))
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
