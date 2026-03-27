import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@dzipagent/core'
import type { MemoryServiceLike } from '@dzipagent/memory-ipc'

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

async function req(
  app: ReturnType<typeof createForgeApp>,
  method: string,
  path: string,
  body?: unknown,
) {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body) init.body = JSON.stringify(body)
  return app.request(path, init)
}

describe('Memory routes', () => {
  let app: ReturnType<typeof createForgeApp>
  let memoryService: MemoryServiceLike

  beforeEach(async () => {
    memoryService = createMockMemoryService()
    // Seed some test data
    await memoryService.put('lessons', { tenant: 't1' }, 'lesson-1', {
      text: 'Always validate inputs',
      category: 'best-practice',
      importance: 0.8,
    })
    await memoryService.put('lessons', { tenant: 't1' }, 'lesson-2', {
      text: 'Use parameterized queries',
      category: 'security',
      importance: 0.9,
    })
    app = createForgeApp(createTestConfig(memoryService))
  })

  describe('GET /api/memory/schema', () => {
    it('returns the memory frame schema with fields', async () => {
      const res = await app.request('/api/memory/schema')
      expect(res.status).toBe(200)
      const body = await res.json() as { data: { schema_version: number; fields: unknown[] } }
      expect(body.data.schema_version).toBeGreaterThanOrEqual(1)
      expect(body.data.fields).toBeInstanceOf(Array)
      expect(body.data.fields.length).toBeGreaterThan(0)

      // Each field should have name, type, nullable, description
      const first = body.data.fields[0] as Record<string, unknown>
      expect(first).toHaveProperty('name')
      expect(first).toHaveProperty('type')
      expect(first).toHaveProperty('nullable')
      expect(first).toHaveProperty('description')
    })
  })

  describe('POST /api/memory/export', () => {
    it('exports memories in arrow_ipc format', async () => {
      const res = await req(app, 'POST', '/api/memory/export', {
        namespace: 'lessons',
        scope: { tenant: 't1' },
        format: 'arrow_ipc',
      })
      expect(res.status).toBe(200)
      const body = await res.json() as {
        data: { format: string; record_count: number; data: string; schema_version: number }
      }
      expect(body.data.format).toBe('arrow_ipc')
      expect(body.data.record_count).toBe(2)
      expect(body.data.data).toBeTruthy()
      expect(body.data.schema_version).toBeGreaterThanOrEqual(1)
    })

    it('exports memories in json format', async () => {
      const res = await req(app, 'POST', '/api/memory/export', {
        namespace: 'lessons',
        scope: { tenant: 't1' },
        format: 'json',
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { data: { format: string; record_count: number } }
      expect(body.data.format).toBe('json')
      expect(body.data.record_count).toBe(2)
    })

    it('returns 400 for invalid input (missing namespace)', async () => {
      const res = await req(app, 'POST', '/api/memory/export', {
        format: 'arrow_ipc',
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION_ERROR')
    })

    it('returns empty result for non-existent namespace', async () => {
      const res = await req(app, 'POST', '/api/memory/export', {
        namespace: 'nonexistent',
        scope: { tenant: 't1' },
        format: 'arrow_ipc',
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { data: { record_count: number } }
      expect(body.data.record_count).toBe(0)
    })
  })

  describe('POST /api/memory/import', () => {
    it('imports memories from previously exported arrow_ipc data', async () => {
      // First export
      const exportRes = await req(app, 'POST', '/api/memory/export', {
        namespace: 'lessons',
        scope: { tenant: 't1' },
        format: 'arrow_ipc',
      })
      const exportBody = await exportRes.json() as { data: { data: string } }

      // Then import into a different scope
      const importRes = await req(app, 'POST', '/api/memory/import', {
        data: exportBody.data.data,
        format: 'arrow_ipc',
        namespace: 'lessons',
        scope: { tenant: 't2' },
        merge_strategy: 'upsert',
      })
      expect(importRes.status).toBe(200)
      const importBody = await importRes.json() as {
        data: { imported: number; skipped: number; conflicts: number; warnings: string[] }
      }
      expect(importBody.data.imported).toBeGreaterThanOrEqual(0)
      expect(importBody.data.warnings).toBeInstanceOf(Array)
    })

    it('returns 400 for invalid input (missing data)', async () => {
      const res = await req(app, 'POST', '/api/memory/import', {
        format: 'arrow_ipc',
        namespace: 'lessons',
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('VALIDATION_ERROR')
    })
  })

  describe('Routes not mounted without memoryService', () => {
    it('returns 404 when memoryService is not provided', async () => {
      const appWithout = createForgeApp(createTestConfig())

      const schemaRes = await appWithout.request('/api/memory/schema')
      expect(schemaRes.status).toBe(404)

      const exportRes = await req(appWithout, 'POST', '/api/memory/export', {
        namespace: 'test',
      })
      expect(exportRes.status).toBe(404)
    })
  })
})
