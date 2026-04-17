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

describe('Routing stats route — GET /api/health/routing', () => {
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
    const res = await app.request('/api/health/routing')
    expect(res.status).toBe(200)
    const data = await res.json() as { data: { totalRuns: number } }
    expect(data.data.totalRuns).toBe(0)
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

    const res = await app.request('/api/health/routing')
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

    const res = await app.request('/api/health/routing')
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

    const res = await app.request('/api/health/routing')
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

    const res = await app.request('/api/health/routing')
    const data = await res.json() as {
      data: { qualityMetrics: { avgQuality: number | null } }
    }
    expect(data.data.qualityMetrics.avgQuality).toBeNull()
  })
})
