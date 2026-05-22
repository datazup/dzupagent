import { describe, it, expect, beforeEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'

const TEST_API_KEYS: Record<string, { id: string; tenantId: string }> = {
  'key-a': { id: 'key-a', tenantId: 'tenant-a' },
  'key-b': { id: 'key-b', tenantId: 'tenant-b' },
}

function createTestConfig(): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
  }
}

describe('Routing stats route — GET /api/runs/routing-stats', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>

  beforeEach(async () => {
    config = createTestConfig()
    app = createForgeApp(config)
    await config.agentStore.save({
      id: 'agent-1',
      name: 'Test Agent',
      instructions: 'test',
      modelTier: 'chat',
    })
  })

  it('returns empty stats when no runs exist', async () => {
    const res = await app.request('/api/runs/routing-stats')
    expect(res.status).toBe(200)
    const data = await res.json() as { data: { totalRuns: number } }
    expect(data.data.totalRuns).toBe(0)
  })

  it('does not expose routing stats on legacy health path', async () => {
    const res = await app.request('/api/health/routing')
    expect(res.status).toBe(404)
  })

  it('aggregates tier, reason, and complexity from run metadata', async () => {
    await config.runStore.create({
      agentId: 'agent-1',
      input: 'test',
      metadata: { modelTier: 'chat', routingReason: 'low_complexity', complexity: 'low' },
    })
    await config.runStore.create({
      agentId: 'agent-1',
      input: 'test2',
      metadata: { modelTier: 'codegen', routingReason: 'code_detected', complexity: 'high' },
    })
    await config.runStore.create({
      agentId: 'agent-1',
      input: 'test3',
      metadata: { modelTier: 'chat', routingReason: 'low_complexity', complexity: 'low' },
    })

    const res = await app.request('/api/runs/routing-stats')
    expect(res.status).toBe(200)
    const data = await res.json() as {
      data: {
        totalRuns: number
        byTier: Record<string, number>
        byReason: Record<string, number>
        byComplexity: Record<string, number>
      }
    }
    expect(data.data.totalRuns).toBe(3)
    expect(data.data.byTier['chat']).toBe(2)
    expect(data.data.byTier['codegen']).toBe(1)
    expect(data.data.byReason['low_complexity']).toBe(2)
    expect(data.data.byComplexity['high']).toBe(1)
  })

  it('defaults to "unknown" for runs without routing metadata', async () => {
    await config.runStore.create({
      agentId: 'agent-1',
      input: 'no metadata',
    })

    const res = await app.request('/api/runs/routing-stats')
    const data = await res.json() as {
      data: {
        byTier: Record<string, number>
        byReason: Record<string, number>
        byComplexity: Record<string, number>
      }
    }
    expect(data.data.byTier['unknown']).toBe(1)
    expect(data.data.byReason['unknown']).toBe(1)
    expect(data.data.byComplexity['unknown']).toBe(1)
  })

  it('includes quality metrics from reflectionScore in metadata', async () => {
    await config.runStore.create({
      agentId: 'agent-1',
      input: 'test',
      metadata: {
        modelTier: 'chat',
        reflectionScore: { overall: 0.9 },
      },
    })
    await config.runStore.create({
      agentId: 'agent-1',
      input: 'test2',
      metadata: {
        modelTier: 'chat',
        reflectionScore: { overall: 0.3 },
      },
    })

    const res = await app.request('/api/runs/routing-stats')
    const data = await res.json() as {
      data: {
        qualityMetrics: {
          avgQuality: number | null
          avgQualityByTier: Record<string, number | null>
          lowQualityRunCount: number
        }
      }
    }
    expect(data.data.qualityMetrics.avgQuality).toBe(0.6)
    expect(data.data.qualityMetrics.lowQualityRunCount).toBe(1)
    expect(data.data.qualityMetrics.avgQualityByTier['chat']).toBe(0.6)
  })

  it('returns null avgQuality when no runs have reflection scores', async () => {
    await config.runStore.create({ agentId: 'agent-1', input: 'x' })

    const res = await app.request('/api/runs/routing-stats')
    const data = await res.json() as {
      data: { qualityMetrics: { avgQuality: number | null } }
    }
    expect(data.data.qualityMetrics.avgQuality).toBeNull()
  })

  it('scopes aggregation by requesting API key tenant and owner when auth is enabled', async () => {
    const authedConfig = createTestConfig()
    await authedConfig.agentStore.save({
      id: 'agent-1',
      name: 'Test Agent',
      instructions: 'test',
      modelTier: 'chat',
    })

    const authedApp = createForgeApp({
      ...authedConfig,
      auth: {
        mode: 'api-key',
        validateKey: async (token: string) => {
          return TEST_API_KEYS[token] ?? null
        },
      },
    })

    await authedConfig.runStore.create({
      agentId: 'agent-1',
      input: 'tenant-a-owner-a',
      ownerId: 'key-a',
      tenantId: 'tenant-a',
      metadata: { modelTier: 'chat', routingReason: 'low_complexity', complexity: 'low' },
    })
    await authedConfig.runStore.create({
      agentId: 'agent-1',
      input: 'tenant-b-owner-b',
      ownerId: 'key-b',
      tenantId: 'tenant-b',
      metadata: { modelTier: 'codegen', routingReason: 'code_detected', complexity: 'high' },
    })
    await authedConfig.runStore.create({
      agentId: 'agent-1',
      input: 'tenant-a-owner-b',
      ownerId: 'key-b',
      tenantId: 'tenant-a',
      metadata: { modelTier: 'chat', routingReason: 'low_complexity', complexity: 'low' },
    })

    const unauthorized = await authedApp.request('/api/runs/routing-stats')
    expect(unauthorized.status).toBe(401)

    const scoped = await authedApp.request('/api/runs/routing-stats', {
      headers: { Authorization: 'Bearer key-a' },
    })
    expect(scoped.status).toBe(200)
    const body = await scoped.json() as {
      data: {
        totalRuns: number
        byTier: Record<string, number>
      }
    }
    expect(body.data.totalRuns).toBe(1)
    expect(body.data.byTier['chat']).toBe(1)
    expect(body.data.byTier['codegen']).toBeUndefined()
  })
})
