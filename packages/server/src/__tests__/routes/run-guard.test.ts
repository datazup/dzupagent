/**
 * MJ-SEC-02: cross-owner / cross-tenant denial coverage for the shared
 * `requireOwnedRun` guard applied to every `/api/runs/:id/*` subroute.
 *
 * The guard itself lives in `routes/run-guard.ts` and reuses
 * `enforceOwnerAccess` from `routes/runs.ts`. These tests intentionally
 * exercise the wired-up Hono app (rather than calling the helper directly)
 * to prove that each subroute file imports + applies the guard correctly.
 *
 * Two scenarios per subroute:
 *   - Cross-owner access returns **404** (NOT 403, to prevent enumeration).
 *   - Same-owner access still returns the expected 2xx / 4xx-state response.
 *
 * Routes covered:
 *   GET  /api/runs/:id/context             (run-context.ts)
 *   GET  /api/runs/:id/token-report        (run-context.ts)
 *   GET  /api/runs/:id/messages            (run-trace.ts)
 *   POST /api/runs/:id/approve             (approval.ts)
 *   POST /api/runs/:id/reject              (approval.ts)
 *   POST /api/runs/:id/human-contact/:cid/respond (human-contact.ts)
 *   GET  /api/runs/:id/enrichment-metrics  (enrichment-metrics.ts)
 */
import { describe, it, expect } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import { InMemoryRunTraceStore } from '../../persistence/run-trace-store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildConfig(keyId: string, ownerId: string): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    traceStore: new InMemoryRunTraceStore(),
    auth: {
      mode: 'api-key',
      validateKey: async (_key: string) => ({
        id: keyId,
        ownerId,
        role: 'operator',
      }),
    },
  }
}

const AUTH_HEADERS = { Authorization: 'Bearer some-token', 'Content-Type': 'application/json' }

async function jsonError(res: Response): Promise<{ code: string }> {
  const body = (await res.json()) as { error: { code: string } }
  return body.error
}

// ---------------------------------------------------------------------------
// /context — denial + same-owner success
// ---------------------------------------------------------------------------

describe('MJ-SEC-02 run-guard: GET /api/runs/:id/context', () => {
  it('returns 404 to a foreign owner (no enumeration leak)', async () => {
    const cfg = buildConfig('key-A', 'owner-A')
    await cfg.agentStore.save({ id: 'ag', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({
      agentId: 'ag', input: 'hi',
      ownerId: 'owner-B', tenantId: 'owner-B',
    })

    const app = createForgeApp(cfg)
    const res = await app.request(`/api/runs/${run.id}/context`, { headers: AUTH_HEADERS })

    expect(res.status).toBe(404)
    expect((await jsonError(res)).code).toBe('NOT_FOUND')
  })

  it('returns 200 when the requesting key matches the run owner', async () => {
    const cfg = buildConfig('owner-A', 'owner-A')
    await cfg.agentStore.save({ id: 'ag', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({
      agentId: 'ag', input: 'hi',
      ownerId: 'owner-A', tenantId: 'owner-A',
    })

    const app = createForgeApp(cfg)
    const res = await app.request(`/api/runs/${run.id}/context`, { headers: AUTH_HEADERS })

    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// /messages — denial + same-owner success
// ---------------------------------------------------------------------------

describe('MJ-SEC-02 run-guard: GET /api/runs/:id/messages', () => {
  it('returns 404 to a foreign owner (no enumeration leak)', async () => {
    const cfg = buildConfig('key-A', 'owner-A')
    await cfg.agentStore.save({ id: 'ag', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({
      agentId: 'ag', input: 'hi',
      ownerId: 'owner-B', tenantId: 'owner-B',
    })

    // Populate a trace so the guard, not trace-absence, is the failure mode.
    const traceStore = cfg.traceStore as InMemoryRunTraceStore
    traceStore.startTrace(run.id, 'ag')
    traceStore.addStep(run.id, { timestamp: 1, type: 'user_input', content: 'hello' })
    traceStore.completeTrace(run.id)

    const app = createForgeApp(cfg)
    const res = await app.request(`/api/runs/${run.id}/messages`, { headers: AUTH_HEADERS })

    expect(res.status).toBe(404)
    expect((await jsonError(res)).code).toBe('NOT_FOUND')
  })

  it('returns 200 when the requesting key matches the run owner', async () => {
    const cfg = buildConfig('owner-A', 'owner-A')
    await cfg.agentStore.save({ id: 'ag', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({
      agentId: 'ag', input: 'hi',
      ownerId: 'owner-A', tenantId: 'owner-A',
    })

    const traceStore = cfg.traceStore as InMemoryRunTraceStore
    traceStore.startTrace(run.id, 'ag')
    traceStore.addStep(run.id, { timestamp: 1, type: 'user_input', content: 'hello' })
    traceStore.completeTrace(run.id)

    const app = createForgeApp(cfg)
    const res = await app.request(`/api/runs/${run.id}/messages`, { headers: AUTH_HEADERS })

    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// /approve and /reject — denial + same-owner success
// ---------------------------------------------------------------------------

describe('MJ-SEC-02 run-guard: POST /api/runs/:id/approve', () => {
  it('returns 404 to a foreign owner (does not leak run existence)', async () => {
    const cfg = buildConfig('key-A', 'owner-A')
    await cfg.agentStore.save({ id: 'ag', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({
      agentId: 'ag', input: 'hi',
      ownerId: 'owner-B', tenantId: 'owner-B',
    })
    await cfg.runStore.update(run.id, { status: 'awaiting_approval' })

    const app = createForgeApp(cfg)
    const res = await app.request(`/api/runs/${run.id}/approve`, {
      method: 'POST',
      headers: AUTH_HEADERS,
    })

    expect(res.status).toBe(404)
    expect((await jsonError(res)).code).toBe('NOT_FOUND')
    // Run state must remain unchanged on a denied request.
    const after = await cfg.runStore.get(run.id)
    expect(after?.status).toBe('awaiting_approval')
  })

  it('approves the run when the requesting key matches the owner', async () => {
    const cfg = buildConfig('owner-A', 'owner-A')
    await cfg.agentStore.save({ id: 'ag', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({
      agentId: 'ag', input: 'hi',
      ownerId: 'owner-A', tenantId: 'owner-A',
    })
    await cfg.runStore.update(run.id, { status: 'awaiting_approval' })

    const app = createForgeApp(cfg)
    const res = await app.request(`/api/runs/${run.id}/approve`, {
      method: 'POST',
      headers: AUTH_HEADERS,
    })

    expect(res.status).toBe(200)
    const after = await cfg.runStore.get(run.id)
    expect(after?.status).toBe('approved')
  })
})

describe('MJ-SEC-02 run-guard: POST /api/runs/:id/reject', () => {
  it('returns 404 to a foreign owner', async () => {
    const cfg = buildConfig('key-A', 'owner-A')
    await cfg.agentStore.save({ id: 'ag', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({
      agentId: 'ag', input: 'hi',
      ownerId: 'owner-B', tenantId: 'owner-B',
    })
    await cfg.runStore.update(run.id, { status: 'awaiting_approval' })

    const app = createForgeApp(cfg)
    const res = await app.request(`/api/runs/${run.id}/reject`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ reason: 'no' }),
    })

    expect(res.status).toBe(404)
    const after = await cfg.runStore.get(run.id)
    expect(after?.status).toBe('awaiting_approval')
  })
})

// ---------------------------------------------------------------------------
// /human-contact/:contactId/respond — denial + same-owner success
// ---------------------------------------------------------------------------

describe('MJ-SEC-02 run-guard: POST /api/runs/:id/human-contact/:cid/respond', () => {
  it('returns 404 to a foreign owner', async () => {
    const cfg = buildConfig('key-A', 'owner-A')
    await cfg.agentStore.save({ id: 'ag', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({
      agentId: 'ag', input: 'hi',
      ownerId: 'owner-B', tenantId: 'owner-B',
    })
    await cfg.runStore.update(run.id, { status: 'suspended' })

    const app = createForgeApp(cfg)
    const res = await app.request(
      `/api/runs/${run.id}/human-contact/contact-1/respond`,
      {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({ type: 'approval', approved: true }),
      },
    )

    expect(res.status).toBe(404)
    expect((await jsonError(res)).code).toBe('NOT_FOUND')
    const after = await cfg.runStore.get(run.id)
    expect(after?.status).toBe('suspended')
  })

  it('resumes the run when the requesting key matches the owner', async () => {
    const cfg = buildConfig('owner-A', 'owner-A')
    await cfg.agentStore.save({ id: 'ag', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({
      agentId: 'ag', input: 'hi',
      ownerId: 'owner-A', tenantId: 'owner-A',
    })
    await cfg.runStore.update(run.id, { status: 'suspended' })

    const app = createForgeApp(cfg)
    const res = await app.request(
      `/api/runs/${run.id}/human-contact/contact-1/respond`,
      {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({ type: 'approval', approved: true }),
      },
    )

    expect(res.status).toBe(200)
    const after = await cfg.runStore.get(run.id)
    expect(after?.status).toBe('running')
  })
})

// ---------------------------------------------------------------------------
// /enrichment-metrics — denial + same-owner success
// ---------------------------------------------------------------------------

describe('MJ-SEC-02 run-guard: GET /api/runs/:id/enrichment-metrics', () => {
  it('returns 404 to a foreign owner', async () => {
    const cfg = buildConfig('key-A', 'owner-A')
    await cfg.agentStore.save({ id: 'ag', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({
      agentId: 'ag', input: 'hi',
      ownerId: 'owner-B', tenantId: 'owner-B',
    })

    const app = createForgeApp(cfg)
    const res = await app.request(`/api/runs/${run.id}/enrichment-metrics`, {
      headers: AUTH_HEADERS,
    })

    expect(res.status).toBe(404)
  })

  it('returns 200 when the requesting key matches the owner', async () => {
    const cfg = buildConfig('owner-A', 'owner-A')
    await cfg.agentStore.save({ id: 'ag', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({
      agentId: 'ag', input: 'hi',
      ownerId: 'owner-A', tenantId: 'owner-A',
    })

    const app = createForgeApp(cfg)
    const res = await app.request(`/api/runs/${run.id}/enrichment-metrics`, {
      headers: AUTH_HEADERS,
    })

    expect(res.status).toBe(200)
  })
})
