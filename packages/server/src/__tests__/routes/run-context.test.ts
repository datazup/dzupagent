/**
 * Tests for GET /api/runs/:id/context — token lifecycle, compression stats,
 * and context-health reporting.
 *
 * Uses InMemoryRunStore + InMemoryAgentStore — no DB, no network.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../../app.js'
import type { TokenLifecycleLike, TokenLifecycleRegistry } from '../../routes/run-context.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'

function makeAuthConfig(
  keyId: string,
  ownerId: string,
  base: Partial<ForgeServerConfig> = {},
): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    auth: {
      mode: 'api-key',
      validateKey: async (_k: string) => ({ id: keyId, ownerId, role: 'operator' }),
    },
    ...base,
  }
}

function bearerGet(app: ReturnType<typeof createForgeApp>, path: string): Promise<Response> {
  return app.request(path, { headers: { Authorization: 'Bearer tok' } })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestConfig(overrides: Partial<ForgeServerConfig> = {}): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    ...overrides,
  }
}

/**
 * Minimal fake lifecycle manager matching the structural TokenLifecycleLike
 * contract. Lets tests assert routing without depending on @dzupagent/context.
 */
function fakeLifecycle(opts: {
  used: number
  available: number
  status?: TokenLifecycleLike['status']
  recommendation?: string
}): TokenLifecycleLike {
  const status = opts.status ?? 'ok'
  return {
    usedTokens: opts.used,
    remainingTokens: Math.max(0, opts.available - opts.used),
    status,
    report: {
      used: opts.used,
      available: opts.available,
      pct: opts.available > 0 ? Math.min(1, opts.used / opts.available) : 1,
      status,
      phases: [{ phase: 'system-prompt', tokens: opts.used, timestamp: Date.now() }],
      ...(opts.recommendation !== undefined ? { recommendation: opts.recommendation } : {}),
    },
  }
}

function makeRegistry(map: Map<string, TokenLifecycleLike>): TokenLifecycleRegistry {
  return { get: (id) => map.get(id) }
}

type ContextResponse = {
  data: {
    runId: string
    tokenUsage: { used: number; remaining: number; total: number }
    compressionStats: { count: number; lastAt: string | null; savedTokens: number }
    status: 'ok' | 'warn' | 'critical' | 'exhausted'
    recommendations: string[]
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/runs/:id/context', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>
  let runId: string

  beforeEach(async () => {
    config = createTestConfig()
    app = createForgeApp(config)

    await config.agentStore.save({
      id: 'agent-1',
      name: 'Test Agent',
      instructions: 'test',
      modelTier: 'chat',
    })

    const run = await config.runStore.create({ agentId: 'agent-1', input: 'hello' })
    runId = run.id
  })

  it('returns 404 when the run does not exist', async () => {
    const res = await app.request('/api/runs/nonexistent/context')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns 200 with zero-state when no lifecycle or metadata is present', async () => {
    const res = await app.request(`/api/runs/${runId}/context`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ContextResponse
    expect(body.data.runId).toBe(runId)
    expect(body.data.tokenUsage).toEqual({ used: 0, remaining: 0, total: 0 })
    expect(body.data.status).toBe('ok')
    expect(body.data.compressionStats.count).toBe(0)
    expect(body.data.compressionStats.lastAt).toBeNull()
    expect(body.data.compressionStats.savedTokens).toBe(0)
    expect(body.data.recommendations).toEqual([])
  })

  it('returns 200 with token usage pulled from lifecycle registry', async () => {
    const registry = new Map<string, TokenLifecycleLike>()
    registry.set(runId, fakeLifecycle({ used: 1000, available: 8000, status: 'ok' }))

    const configWithRegistry = createTestConfig({
      runStore: config.runStore,
      agentStore: config.agentStore,
      eventBus: config.eventBus,
      modelRegistry: config.modelRegistry,
      tokenLifecycleRegistry: makeRegistry(registry),
    })
    const appR = createForgeApp(configWithRegistry)

    const res = await appR.request(`/api/runs/${runId}/context`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ContextResponse
    expect(body.data.tokenUsage).toEqual({ used: 1000, remaining: 7000, total: 8000 })
    expect(body.data.status).toBe('ok')
  })

  it('surfaces lifecycle recommendations when supplied by the manager', async () => {
    const registry = new Map<string, TokenLifecycleLike>()
    registry.set(runId, fakeLifecycle({
      used: 6500,
      available: 8000,
      status: 'warn',
      recommendation: 'Consider compressing conversation history',
    }))
    const appR = createForgeApp(createTestConfig({
      runStore: config.runStore,
      agentStore: config.agentStore,
      eventBus: config.eventBus,
      modelRegistry: config.modelRegistry,
      tokenLifecycleRegistry: makeRegistry(registry),
    }))

    const res = await appR.request(`/api/runs/${runId}/context`)
    const body = (await res.json()) as ContextResponse
    expect(body.data.status).toBe('warn')
    expect(body.data.recommendations).toContain('Consider compressing conversation history')
  })

  it('reports compression stats derived from run logs', async () => {
    await config.runStore.addLog(runId, {
      level: 'info',
      phase: 'compression',
      message: 'Compressed messages',
      data: { savedTokens: 1200 },
    })
    await config.runStore.addLog(runId, {
      level: 'info',
      phase: 'compress',
      message: 'Pruned tool results',
      data: { savedTokens: 300 },
    })
    await config.runStore.addLog(runId, {
      level: 'info',
      phase: 'run',
      message: 'unrelated log',
    })

    const res = await app.request(`/api/runs/${runId}/context`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ContextResponse
    expect(body.data.compressionStats.count).toBe(2)
    expect(body.data.compressionStats.savedTokens).toBe(1500)
    expect(body.data.compressionStats.lastAt).not.toBeNull()
  })

  it('returns exhausted status with default recommendation when registry reports exhausted', async () => {
    const registry = new Map<string, TokenLifecycleLike>()
    registry.set(runId, fakeLifecycle({
      used: 8000,
      available: 8000,
      status: 'exhausted',
    }))
    const appR = createForgeApp(createTestConfig({
      runStore: config.runStore,
      agentStore: config.agentStore,
      eventBus: config.eventBus,
      modelRegistry: config.modelRegistry,
      tokenLifecycleRegistry: makeRegistry(registry),
    }))

    const res = await appR.request(`/api/runs/${runId}/context`)
    const body = (await res.json()) as ContextResponse
    expect(body.data.status).toBe('exhausted')
    expect(body.data.tokenUsage.remaining).toBe(0)
    // No recommendation supplied → route fills in the default.
    expect(body.data.recommendations.length).toBeGreaterThan(0)
  })

  it('falls back to persisted tokenLifecycleReport metadata when no registry is configured', async () => {
    await config.runStore.update(runId, {
      metadata: {
        tokenLifecycleReport: {
          used: 1500,
          available: 4000,
          status: 'ok',
        },
      },
    })

    const res = await app.request(`/api/runs/${runId}/context`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ContextResponse
    expect(body.data.tokenUsage).toEqual({ used: 1500, remaining: 2500, total: 4000 })
    expect(body.data.status).toBe('ok')
  })

  it('falls back to run.tokenUsage totals when metadata report is absent', async () => {
    await config.runStore.update(runId, {
      tokenUsage: { input: 400, output: 600 },
    })

    const res = await app.request(`/api/runs/${runId}/context`)
    const body = (await res.json()) as ContextResponse
    expect(body.data.tokenUsage.used).toBe(1000)
    expect(body.data.tokenUsage.total).toBe(0)
    expect(body.data.tokenUsage.remaining).toBe(0)
    expect(body.data.status).toBe('ok')
  })

  it('does not break existing runs when TokenLifecycleManager is not configured', async () => {
    // This is the contract: routes for the same run (trace, logs, etc.) continue
    // to work when no tokenLifecycleRegistry is passed.
    const logsRes = await app.request(`/api/runs/${runId}/logs`)
    expect(logsRes.status).toBe(200)

    const ctxRes = await app.request(`/api/runs/${runId}/context`)
    expect(ctxRes.status).toBe(200)
    const body = (await ctxRes.json()) as ContextResponse
    expect(body.data.runId).toBe(runId)
    // Defaults to ok / zero-state, not an error.
    expect(body.data.status).toBe('ok')
  })

  it('isolates registry lookups per run (other runs are unaffected)', async () => {
    const other = await config.runStore.create({ agentId: 'agent-1', input: 'other' })
    const registry = new Map<string, TokenLifecycleLike>()
    registry.set(runId, fakeLifecycle({ used: 500, available: 8000, status: 'ok' }))
    // `other.id` is intentionally not registered.

    const appR = createForgeApp(createTestConfig({
      runStore: config.runStore,
      agentStore: config.agentStore,
      eventBus: config.eventBus,
      modelRegistry: config.modelRegistry,
      tokenLifecycleRegistry: makeRegistry(registry),
    }))

    const resHit = await appR.request(`/api/runs/${runId}/context`)
    const bodyHit = (await resHit.json()) as ContextResponse
    expect(bodyHit.data.tokenUsage.used).toBe(500)

    const resMiss = await appR.request(`/api/runs/${other.id}/context`)
    expect(resMiss.status).toBe(200)
    const bodyMiss = (await resMiss.json()) as ContextResponse
    expect(bodyMiss.data.tokenUsage).toEqual({ used: 0, remaining: 0, total: 0 })
  })

  // ---------------------------------------------------------------------
  // Session Z: deriveCompressionStats reads from run.metadata.compressionLog
  // (persisted by run-worker in Session Y) and falls back to log scanning.
  // ---------------------------------------------------------------------

  it('derives compression stats from run.metadata.compressionLog when present', async () => {
    const ts1 = Date.parse('2026-04-20T10:00:00.000Z')
    const ts2 = Date.parse('2026-04-20T10:05:30.000Z')
    await config.runStore.update(runId, {
      metadata: {
        compressionLog: [
          { before: 5000, after: 3800, summary: 'First pass', ts: ts1 },
          { before: 4200, after: 3100, summary: null, ts: ts2 },
        ],
      },
    })

    const res = await app.request(`/api/runs/${runId}/context`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ContextResponse
    expect(body.data.compressionStats.count).toBe(2)
    // (5000 - 3800) + (4200 - 3100) = 1200 + 1100 = 2300
    expect(body.data.compressionStats.savedTokens).toBe(2300)
    expect(body.data.compressionStats.lastAt).toBe(new Date(ts2).toISOString())
  })

  it('falls back to log scan when metadata.compressionLog is absent', async () => {
    // Only logs — no metadata.compressionLog
    await config.runStore.addLog(runId, {
      level: 'info',
      phase: 'compression',
      message: 'Compressed messages',
      data: { savedTokens: 777 },
    })

    const res = await app.request(`/api/runs/${runId}/context`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ContextResponse
    expect(body.data.compressionStats.count).toBe(1)
    expect(body.data.compressionStats.savedTokens).toBe(777)
    expect(body.data.compressionStats.lastAt).not.toBeNull()
  })

  it('falls back to log scan when metadata.compressionLog is an empty array', async () => {
    await config.runStore.update(runId, {
      metadata: {
        compressionLog: [],
      },
    })
    await config.runStore.addLog(runId, {
      level: 'info',
      phase: 'compress',
      message: 'Pruned tool results',
      data: { savedTokens: 250 },
    })

    const res = await app.request(`/api/runs/${runId}/context`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ContextResponse
    // Empty metadata log => log-scan fallback kicks in
    expect(body.data.compressionStats.count).toBe(1)
    expect(body.data.compressionStats.savedTokens).toBe(250)
    expect(body.data.compressionStats.lastAt).not.toBeNull()
  })

  it('prefers metadata.compressionLog over logs when both are present', async () => {
    const metaTs = Date.parse('2026-04-20T12:00:00.000Z')
    await config.runStore.update(runId, {
      metadata: {
        compressionLog: [
          { before: 8000, after: 6000, summary: 'meta', ts: metaTs },
        ],
      },
    })
    // Logs would have produced count=2, savedTokens=1500 — must be ignored.
    await config.runStore.addLog(runId, {
      level: 'info',
      phase: 'compression',
      message: 'log entry 1',
      data: { savedTokens: 1200 },
    })
    await config.runStore.addLog(runId, {
      level: 'info',
      phase: 'compress',
      message: 'log entry 2',
      data: { savedTokens: 300 },
    })

    const res = await app.request(`/api/runs/${runId}/context`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ContextResponse
    // Metadata source wins: 1 entry, savedTokens = 8000 - 6000 = 2000.
    expect(body.data.compressionStats.count).toBe(1)
    expect(body.data.compressionStats.savedTokens).toBe(2000)
    expect(body.data.compressionStats.lastAt).toBe(new Date(metaTs).toISOString())
  })

  it('returns an ISO timestamp for compressionStats.lastAt', async () => {
    await config.runStore.addLog(runId, {
      level: 'info',
      phase: 'compression',
      message: 'Compressed',
      data: { savedTokens: 100 },
    })
    const res = await app.request(`/api/runs/${runId}/context`)
    const body = (await res.json()) as ContextResponse
    expect(body.data.compressionStats.lastAt).toBeTypeOf('string')
    // Must parse cleanly back to a Date
    const parsed = new Date(body.data.compressionStats.lastAt as string)
    expect(Number.isNaN(parsed.getTime())).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// MJ-SEC-02: owner isolation — /context and /token-report must reject
// requests from a different owner/tenant.
// ---------------------------------------------------------------------------
describe('MJ-SEC-02: owner isolation on /context and /token-report', () => {
  it('returns 404 on /context when run belongs to a different owner', async () => {
    const cfg = makeAuthConfig('key-A', 'owner-A')
    await cfg.agentStore.save({ id: 'ag1', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({ agentId: 'ag1', input: 'hi', ownerId: 'owner-B', tenantId: 'owner-B' })
    const res = await bearerGet(createForgeApp(cfg), `/api/runs/${run.id}/context`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })

  it('returns 200 on /context when run owner matches requesting key', async () => {
    const cfg = makeAuthConfig('owner-A', 'owner-A')
    await cfg.agentStore.save({ id: 'ag2', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({ agentId: 'ag2', input: 'hi', ownerId: 'owner-A', tenantId: 'owner-A' })
    const res = await bearerGet(createForgeApp(cfg), `/api/runs/${run.id}/context`)
    expect(res.status).toBe(200)
  })

  it('returns 404 on /token-report when run belongs to a different owner', async () => {
    const cfg = makeAuthConfig('key-A', 'owner-A')
    await cfg.agentStore.save({ id: 'ag3', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({ agentId: 'ag3', input: 'hi', ownerId: 'owner-B', tenantId: 'owner-B' })
    const res = await bearerGet(createForgeApp(cfg), `/api/runs/${run.id}/token-report`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })

  it('returns 200 on /token-report when run owner matches requesting key', async () => {
    const cfg = makeAuthConfig('owner-A', 'owner-A')
    await cfg.agentStore.save({ id: 'ag4', name: 'A', instructions: '', modelTier: 'chat' })
    const run = await cfg.runStore.create({ agentId: 'ag4', input: 'hi', ownerId: 'owner-A', tenantId: 'owner-A' })
    const res = await bearerGet(createForgeApp(cfg), `/api/runs/${run.id}/token-report`)
    expect(res.status).toBe(200)
  })
})
