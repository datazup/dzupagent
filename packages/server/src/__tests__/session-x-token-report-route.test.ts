/**
 * Session X: GET /api/runs/:id/token-report.
 *
 * The route exposes a flattened TokenLifecycleReport with phase breakdown
 * and an optional haltReason. It reads from (in priority order):
 *   1. config.tokenLifecycleRegistry (live run)
 *   2. run.metadata.tokenLifecycleReport (terminal run)
 *   3. run.output.tokenLifecycle (Session W promotion)
 *
 * Returns 404 when the run does not exist; returns 200 with a zero-state
 * payload when no report is available from any source.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import type { TokenLifecycleLike, TokenLifecycleRegistry } from '../routes/run-context.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'

function createTestConfig(overrides: Partial<ForgeServerConfig> = {}): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    ...overrides,
  }
}

function fakeLifecycle(opts: {
  used: number
  available: number
  status?: TokenLifecycleLike['status']
  phases?: Array<{ phase: string; tokens: number; timestamp: number }>
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
      phases: opts.phases ?? [
        { phase: 'system-prompt', tokens: opts.used, timestamp: 1700000000000 },
      ],
    },
  }
}

function makeRegistry(map: Map<string, TokenLifecycleLike>): TokenLifecycleRegistry {
  return { get: (id) => map.get(id) }
}

type CompressionLogEntryShape = {
  before: number
  after: number
  summary: string | null
  ts: number
}

type TokenReportResponse = {
  data: {
    runId: string
    phases: Array<{ phase: string; tokens: number; timestamp: number }>
    status: 'ok' | 'warn' | 'critical' | 'exhausted'
    used: number
    available: number
    pct: number
    haltReason: string | null
    compressionLog: CompressionLogEntryShape[]
  }
}

describe('GET /api/runs/:id/token-report (Session X)', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>
  let runId: string

  beforeEach(async () => {
    config = createTestConfig()
    app = createForgeApp(config)
    await config.agentStore.save({
      id: 'x-agent',
      name: 'X Agent',
      instructions: 'test',
      modelTier: 'chat',
    })
    const run = await config.runStore.create({ agentId: 'x-agent', input: 'hi' })
    runId = run.id
  })

  it('returns 404 when the run does not exist', async () => {
    const res = await app.request('/api/runs/nonexistent/token-report')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns the live report from the lifecycle registry', async () => {
    const phases = [
      { phase: 'system-prompt', tokens: 400, timestamp: 1700000000000 },
      { phase: 'user-input', tokens: 600, timestamp: 1700000001000 },
    ]
    const registry = new Map<string, TokenLifecycleLike>()
    registry.set(runId, fakeLifecycle({ used: 1000, available: 8000, status: 'ok', phases }))

    const appR = createForgeApp(createTestConfig({
      runStore: config.runStore,
      agentStore: config.agentStore,
      eventBus: config.eventBus,
      modelRegistry: config.modelRegistry,
      tokenLifecycleRegistry: makeRegistry(registry),
    }))

    const res = await appR.request(`/api/runs/${runId}/token-report`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as TokenReportResponse
    expect(body.data.runId).toBe(runId)
    expect(body.data.used).toBe(1000)
    expect(body.data.available).toBe(8000)
    expect(body.data.pct).toBeCloseTo(0.125, 5)
    expect(body.data.status).toBe('ok')
    expect(body.data.phases).toEqual(phases)
    expect(body.data.haltReason).toBeNull()
  })

  it('falls back to persisted run.metadata.tokenLifecycleReport for terminal runs', async () => {
    const phases = [
      { phase: 'system-prompt', tokens: 500, timestamp: 1700000000000 },
      { phase: 'tool-output', tokens: 1000, timestamp: 1700000002000 },
    ]
    await config.runStore.update(runId, {
      status: 'halted',
      metadata: {
        tokenLifecycleReport: {
          used: 1500,
          available: 4000,
          pct: 0.375,
          status: 'warn',
          phases,
        },
      },
      completedAt: new Date(),
    })

    const res = await app.request(`/api/runs/${runId}/token-report`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as TokenReportResponse
    expect(body.data.used).toBe(1500)
    expect(body.data.available).toBe(4000)
    expect(body.data.pct).toBeCloseTo(0.375, 5)
    expect(body.data.status).toBe('warn')
    expect(body.data.phases).toEqual(phases)
  })

  it('returns zero-state when no report exists anywhere', async () => {
    const res = await app.request(`/api/runs/${runId}/token-report`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as TokenReportResponse
    expect(body.data).toEqual({
      runId,
      phases: [],
      status: 'ok',
      used: 0,
      available: 0,
      pct: 0,
      haltReason: null,
      compressionLog: [],
    })
  })

  it('populates haltReason from run.metadata.haltReason', async () => {
    await config.runStore.update(runId, {
      status: 'halted',
      metadata: {
        halted: true,
        haltReason: 'token_exhausted',
        tokenLifecycleReport: {
          used: 8000,
          available: 8000,
          pct: 1,
          status: 'exhausted',
          phases: [{ phase: 'final', tokens: 8000, timestamp: 1700000003000 }],
        },
      },
      completedAt: new Date(),
    })

    const res = await app.request(`/api/runs/${runId}/token-report`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as TokenReportResponse
    expect(body.data.haltReason).toBe('token_exhausted')
    expect(body.data.status).toBe('exhausted')
    expect(body.data.used).toBe(8000)
    expect(body.data.available).toBe(8000)
    expect(body.data.pct).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // Session AA: compressionLog passthrough from run.metadata.compressionLog.
  //
  // The run-worker (Session Y) merges a non-empty GenerateResult.compressionLog
  // into run.metadata.compressionLog. This endpoint surfaces that list to
  // telemetry consumers. When no compression happened (or the key is absent),
  // the endpoint returns an empty array so the frontend can render without
  // branching on undefined.
  // ---------------------------------------------------------------------------
  describe('Session AA: compressionLog', () => {
    it('includes compressionLog when run.metadata.compressionLog has entries', async () => {
      const compressionLog = [
        { before: 8000, after: 3200, summary: 'Compressed early turns', ts: 1700000010000 },
        { before: 7500, after: 2800, summary: null, ts: 1700000020000 },
      ]
      await config.runStore.update(runId, {
        status: 'completed',
        metadata: {
          compressionLog,
          tokenLifecycleReport: {
            used: 2800,
            available: 8000,
            pct: 0.35,
            status: 'ok',
            phases: [{ phase: 'post-compress', tokens: 2800, timestamp: 1700000020000 }],
          },
        },
        completedAt: new Date(),
      })

      const res = await app.request(`/api/runs/${runId}/token-report`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as TokenReportResponse
      expect(body.data.compressionLog).toEqual(compressionLog)
      expect(body.data.compressionLog).toHaveLength(2)
    })

    it('returns empty compressionLog array when metadata.compressionLog is absent', async () => {
      // No compressionLog on metadata — Session Y only merges when entries > 0.
      await config.runStore.update(runId, {
        status: 'completed',
        metadata: {
          tokenLifecycleReport: {
            used: 100,
            available: 8000,
            pct: 0.0125,
            status: 'ok',
            phases: [],
          },
        },
        completedAt: new Date(),
      })

      const res = await app.request(`/api/runs/${runId}/token-report`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as TokenReportResponse
      expect(body.data.compressionLog).toEqual([])
      expect(Array.isArray(body.data.compressionLog)).toBe(true)
    })

    it('preserves the CompressionLogEntry shape (before, after, summary, ts)', async () => {
      const entry = { before: 6400, after: 2100, summary: 'Rolled up tool results', ts: 1700000030000 }
      await config.runStore.update(runId, {
        status: 'completed',
        metadata: { compressionLog: [entry] },
        completedAt: new Date(),
      })

      const res = await app.request(`/api/runs/${runId}/token-report`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as TokenReportResponse
      expect(body.data.compressionLog).toHaveLength(1)
      const [got] = body.data.compressionLog
      expect(got.before).toBe(6400)
      expect(got.after).toBe(2100)
      expect(got.summary).toBe('Rolled up tool results')
      expect(got.ts).toBe(1700000030000)
      // Ensure only canonical fields pass the filter — no extra keys leak through
      // beyond the four-field contract exported from @dzupagent/agent.
      expect(Object.keys(got).sort()).toEqual(['after', 'before', 'summary', 'ts'])
    })
  })
})
