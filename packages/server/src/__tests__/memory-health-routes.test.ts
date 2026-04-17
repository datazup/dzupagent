import { describe, it, expect } from 'vitest'
import type { Hono } from 'hono'
import { createMemoryHealthRoutes, type HealthProvider } from '../routes/memory-health.js'

function createApp(retriever: HealthProvider): Hono {
  return createMemoryHealthRoutes({ retriever })
}

describe('Memory health routes — GET /health', () => {
  it('returns healthy status when all providers have high success rate', async () => {
    const retriever: HealthProvider = {
      health: () => [
        { source: 'vector-db', successCount: 100, failureCount: 0, totalLatencyMs: 5000, avgLatencyMs: 50, successRate: 1.0 },
        { source: 'keyword-search', successCount: 90, failureCount: 10, totalLatencyMs: 3000, avgLatencyMs: 33, successRate: 0.9 },
      ],
    }

    const app = createApp(retriever)
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const data = await res.json() as { data: { status: string; overallSuccessRate: number; providers: unknown[] } }
    expect(data.data.status).toBe('healthy')
    expect(data.data.overallSuccessRate).toBe(0.95)
    expect(data.data.providers).toHaveLength(2)
  })

  it('returns degraded status when average success rate falls below 0.5', async () => {
    const retriever: HealthProvider = {
      health: () => [
        { source: 'vector-db', successCount: 20, failureCount: 80, totalLatencyMs: 5000, avgLatencyMs: 50, successRate: 0.2 },
        { source: 'keyword-search', successCount: 30, failureCount: 70, totalLatencyMs: 3000, avgLatencyMs: 33, successRate: 0.3 },
      ],
    }

    const app = createApp(retriever)
    const res = await app.request('/health')
    const data = await res.json() as { data: { status: string } }
    expect(data.data.status).toBe('degraded')
  })

  it('returns healthy with rate 1 when no providers exist', async () => {
    const retriever: HealthProvider = {
      health: () => [],
    }

    const app = createApp(retriever)
    const res = await app.request('/health')
    const data = await res.json() as { data: { status: string; overallSuccessRate: number } }
    expect(data.data.status).toBe('healthy')
    expect(data.data.overallSuccessRate).toBe(1)
  })

  it('serializes lastFailure timestamp as ISO string', async () => {
    const failDate = new Date('2025-01-15T10:00:00Z')
    const retriever: HealthProvider = {
      health: () => [
        {
          source: 'vector-db',
          successCount: 50,
          failureCount: 50,
          totalLatencyMs: 5000,
          avgLatencyMs: 50,
          successRate: 0.5,
          lastFailure: { error: 'connection timeout', timestamp: failDate },
        },
      ],
    }

    const app = createApp(retriever)
    const res = await app.request('/health')
    const data = await res.json() as {
      data: {
        providers: Array<{
          lastFailure: { error: string; timestamp: string } | null
        }>
      }
    }
    expect(data.data.providers[0]?.lastFailure?.error).toBe('connection timeout')
    expect(data.data.providers[0]?.lastFailure?.timestamp).toBe('2025-01-15T10:00:00.000Z')
  })

  it('sets lastFailure to null when provider has no failures', async () => {
    const retriever: HealthProvider = {
      health: () => [
        { source: 'vector-db', successCount: 100, failureCount: 0, totalLatencyMs: 1000, avgLatencyMs: 10, successRate: 1.0 },
      ],
    }

    const app = createApp(retriever)
    const res = await app.request('/health')
    const data = await res.json() as {
      data: { providers: Array<{ lastFailure: null }> }
    }
    expect(data.data.providers[0]?.lastFailure).toBeNull()
  })
})
