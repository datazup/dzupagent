import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@forgeagent/core'
import type { MemoryServiceLike } from '@forgeagent/memory-ipc'

/**
 * Minimal in-memory MemoryServiceLike implementation for testing.
 */
function createMockMemoryService(): MemoryServiceLike {
  const store = new Map<string, Record<string, unknown>[]>()

  function storeKey(ns: string, scope: Record<string, string>): string {
    const sortedScope = Object.entries(scope).sort(([a], [b]) => a.localeCompare(b))
    return `${ns}:${JSON.stringify(sortedScope)}`
  }

  return {
    async get(
      namespace: string,
      scope: Record<string, string>,
      key?: string,
    ): Promise<Record<string, unknown>[]> {
      const sk = storeKey(namespace, scope)
      const records = store.get(sk) ?? []
      if (key) {
        return records.filter((r) => r['key'] === key)
      }
      return records
    },
    async search(
      namespace: string,
      scope: Record<string, string>,
      _query: string,
      limit?: number,
    ): Promise<Record<string, unknown>[]> {
      const sk = storeKey(namespace, scope)
      const records = store.get(sk) ?? []
      return records.slice(0, limit ?? 100)
    },
    async put(
      namespace: string,
      scope: Record<string, string>,
      key: string,
      value: Record<string, unknown>,
    ): Promise<void> {
      const sk = storeKey(namespace, scope)
      const records = store.get(sk) ?? []
      const idx = records.findIndex((r) => r['key'] === key)
      const record = { ...value, key }
      if (idx >= 0) {
        records[idx] = record
      } else {
        records.push(record)
      }
      store.set(sk, records)
    },
  }
}

function createTestConfig(memoryService?: MemoryServiceLike): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    memoryService,
  }
}

describe('Memory analytics routes', () => {
  let app: ReturnType<typeof createForgeApp>
  let memoryService: MemoryServiceLike

  beforeEach(async () => {
    // Reset the analytics handler cache between tests
    const { _resetAnalyticsCache } = await import('../routes/analytics-handler.js')
    _resetAnalyticsCache()

    memoryService = createMockMemoryService()
    await memoryService.put('lessons', {}, 'lesson-1', {
      text: 'Always validate inputs',
      category: 'best-practice',
      importance: 0.8,
    })
    await memoryService.put('lessons', {}, 'lesson-2', {
      text: 'Use parameterized queries',
      category: 'security',
      importance: 0.9,
    })
    app = createForgeApp(createTestConfig(memoryService))
  })

  afterEach(async () => {
    const { _resetAnalyticsCache } = await import('../routes/analytics-handler.js')
    _resetAnalyticsCache()
  })

  describe('GET /api/memory/analytics/decay-trends', () => {
    it('returns 503 when DuckDB is not installed', async () => {
      // DuckDB-WASM is not installed in the test environment,
      // so all analytics routes should return 503
      const res = await app.request('/api/memory/analytics/decay-trends?window=day')
      expect(res.status).toBe(503)
      const body = await res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('DUCKDB_UNAVAILABLE')
      expect(body.error.message).toContain('DuckDB-WASM')
    })

    it('defaults to day window when invalid window param given', async () => {
      const res = await app.request('/api/memory/analytics/decay-trends?window=invalid')
      // Still 503 due to DuckDB, but verifies route is reachable
      expect(res.status).toBe(503)
    })
  })

  describe('GET /api/memory/analytics/namespace-stats', () => {
    it('returns 503 when DuckDB is not installed', async () => {
      const res = await app.request('/api/memory/analytics/namespace-stats')
      expect(res.status).toBe(503)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('DUCKDB_UNAVAILABLE')
    })
  })

  describe('GET /api/memory/analytics/expiring', () => {
    it('returns 503 when DuckDB is not installed', async () => {
      const res = await app.request('/api/memory/analytics/expiring?horizonMs=86400000')
      expect(res.status).toBe(503)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('DUCKDB_UNAVAILABLE')
    })

    it('returns 400 for invalid horizonMs', async () => {
      const res = await app.request('/api/memory/analytics/expiring?horizonMs=-1')
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.message).toContain('horizonMs')
    })

    it('returns 400 for non-numeric horizonMs', async () => {
      const res = await app.request('/api/memory/analytics/expiring?horizonMs=abc')
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION_ERROR')
    })
  })

  describe('GET /api/memory/analytics/agent-performance', () => {
    it('returns 503 when DuckDB is not installed', async () => {
      const res = await app.request('/api/memory/analytics/agent-performance')
      expect(res.status).toBe(503)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('DUCKDB_UNAVAILABLE')
    })
  })

  describe('GET /api/memory/analytics/usage-patterns', () => {
    it('returns 503 when DuckDB is not installed', async () => {
      const res = await app.request('/api/memory/analytics/usage-patterns?bucketMs=3600000')
      expect(res.status).toBe(503)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('DUCKDB_UNAVAILABLE')
    })

    it('returns 400 for invalid bucketMs', async () => {
      const res = await app.request('/api/memory/analytics/usage-patterns?bucketMs=0')
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.message).toContain('bucketMs')
    })
  })

  describe('GET /api/memory/analytics/duplicates', () => {
    it('returns 503 when DuckDB is not installed', async () => {
      const res = await app.request('/api/memory/analytics/duplicates?prefixLength=50')
      expect(res.status).toBe(503)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('DUCKDB_UNAVAILABLE')
    })

    it('returns 400 for invalid prefixLength', async () => {
      const res = await app.request('/api/memory/analytics/duplicates?prefixLength=-5')
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.message).toContain('prefixLength')
    })
  })

  describe('Routes not mounted without memoryService', () => {
    it('returns 404 for analytics routes when memoryService is not provided', async () => {
      const appWithout = createForgeApp(createTestConfig())

      const res = await appWithout.request('/api/memory/analytics/namespace-stats')
      expect(res.status).toBe(404)
    })
  })

  describe('analytics-handler helpers', () => {
    it('isDuckDBError recognizes DuckDB unavailable errors', async () => {
      const { isDuckDBError } = await import('../routes/analytics-handler.js')

      const duckError = new Error('@duckdb/duckdb-wasm is not installed')
      duckError.name = 'DuckDBUnavailableError'
      expect(isDuckDBError(duckError)).toBe(true)

      const genericError = new Error('Something else')
      expect(isDuckDBError(genericError)).toBe(false)

      expect(isDuckDBError('not an error')).toBe(false)
      expect(isDuckDBError(null)).toBe(false)
    })

    it('analyticsResultToJson converts result correctly', async () => {
      const { analyticsResultToJson } = await import('../routes/analytics-handler.js')

      const mockResult = {
        arrowTable: {} as never,
        rows: [{ namespace: 'test', count: 5 }],
        rowCount: 1,
        executionMs: 12.345678,
      }

      const json = analyticsResultToJson(mockResult)
      expect(json.rows).toEqual([{ namespace: 'test', count: 5 }])
      expect(json.rowCount).toBe(1)
      expect(json.executionMs).toBe(12.35)
      // No arrowTable in the result
      expect('arrowTable' in json).toBe(false)
    })
  })
})
