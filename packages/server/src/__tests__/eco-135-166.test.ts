/**
 * Tests for ECO-135, ECO-136, ECO-151, ECO-157, ECO-166.
 *
 * - InMemoryQuotaManager (resource quota)
 * - TracePrinter (dev CLI trace)
 * - configValidate / configShow (config CLI)
 * - memoryBrowse / memorySearch (memory CLI)
 * - Memory browse routes
 * - Run trace route
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { InMemoryQuotaManager } from '../runtime/memory-quota-manager.js'
import { QuotaExceededError } from '../runtime/resource-quota.js'
import type { ResourceDimensions } from '../runtime/resource-quota.js'
import { TracePrinter } from '../cli/trace-printer.js'
import { configValidate, configShow } from '../cli/config-command.js'
import { memoryBrowse, memorySearch } from '../cli/memory-command.js'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from '@forgeagent/core'
import type { ForgeEventBus } from '@forgeagent/core'
import type { MemoryServiceLike } from '@forgeagent/memory-ipc'
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockMemoryService(): MemoryServiceLike {
  const store = new Map<string, Record<string, unknown>[]>()

  function storeKey(ns: string, scope: Record<string, string>): string {
    const sorted = Object.entries(scope).sort(([a], [b]) => a.localeCompare(b))
    return `${ns}:${JSON.stringify(sorted)}`
  }

  return {
    async get(
      namespace: string,
      scope: Record<string, string>,
      key?: string,
    ): Promise<Record<string, unknown>[]> {
      const sk = storeKey(namespace, scope)
      const records = store.get(sk) ?? []
      if (key) return records.filter((r) => r['key'] === key)
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

// ===========================================================================
// ECO-135 / ECO-136: InMemoryQuotaManager
// ===========================================================================

describe('InMemoryQuotaManager', () => {
  let manager: InMemoryQuotaManager

  beforeEach(() => {
    manager = new InMemoryQuotaManager()
  })

  it('setQuota and getQuota', async () => {
    await manager.setQuota('t1', { concurrentRuns: 10, tokensPerMinute: 1000 })
    const quota = await manager.getQuota('t1')
    expect(quota).toBeDefined()
    expect(quota!.tenantId).toBe('t1')
    expect(quota!.dimensions.concurrentRuns).toBe(10)
    expect(quota!.dimensions.tokensPerMinute).toBe(1000)
    expect(quota!.updatedAt).toBeInstanceOf(Date)
  })

  it('getQuota returns undefined for unknown tenant', async () => {
    const quota = await manager.getQuota('nonexistent')
    expect(quota).toBeUndefined()
  })

  it('check returns allowed when within quota', async () => {
    await manager.setQuota('t1', { concurrentRuns: 5 })
    const result = await manager.check('t1', 'concurrentRuns', 1)
    expect(result.allowed).toBe(true)
  })

  it('check returns denied when exceeding quota', async () => {
    await manager.setQuota('t1', { concurrentRuns: 2 })
    await manager.reserve('t1', 'concurrentRuns', 2)

    const result = await manager.check('t1', 'concurrentRuns', 1)
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.dimension).toBe('concurrentRuns')
      expect(result.limit).toBe(2)
      expect(result.current).toBe(2)
    }
  })

  it('check returns allowed when no quota is set (unlimited)', async () => {
    const result = await manager.check('no-quota', 'concurrentRuns', 100)
    expect(result.allowed).toBe(true)
  })

  it('check returns allowed when dimension is not limited', async () => {
    await manager.setQuota('t1', { concurrentRuns: 5 })
    // tokensPerMinute is not set in the quota
    const result = await manager.check('t1', 'tokensPerMinute', 99999)
    expect(result.allowed).toBe(true)
  })

  it('reserve creates a reservation', async () => {
    const res = await manager.reserve('t1', 'concurrentRuns', 1)
    expect(res.id).toBeTruthy()
    expect(res.tenantId).toBe('t1')
    expect(res.dimension).toBe('concurrentRuns')
    expect(res.amount).toBe(1)
    expect(res.released).toBe(false)
    expect(res.reservedAt).toBeInstanceOf(Date)
    expect(res.expiresAt).toBeInstanceOf(Date)
    expect(res.expiresAt.getTime()).toBeGreaterThan(res.reservedAt.getTime())
  })

  it('release marks reservation as released', async () => {
    const res = await manager.reserve('t1', 'concurrentRuns', 1)
    await manager.release(res.id)

    // Usage should be 0 after release
    const usage = await manager.getUsage('t1')
    expect(usage.concurrentRuns ?? 0).toBe(0)
  })

  it('double release is idempotent', async () => {
    const res = await manager.reserve('t1', 'concurrentRuns', 1)
    await manager.release(res.id)
    await manager.release(res.id) // no error

    const usage = await manager.getUsage('t1')
    expect(usage.concurrentRuns ?? 0).toBe(0)
  })

  it('release of unknown reservation is a no-op', async () => {
    await manager.release('nonexistent-id') // no error
  })

  it('getUsage sums active reservations', async () => {
    await manager.reserve('t1', 'concurrentRuns', 2)
    await manager.reserve('t1', 'concurrentRuns', 3)
    await manager.reserve('t1', 'tokensPerMinute', 100)

    const usage = await manager.getUsage('t1')
    expect(usage.concurrentRuns).toBe(5)
    expect(usage.tokensPerMinute).toBe(100)
  })

  it('listReservations returns only active non-expired reservations', async () => {
    const r1 = await manager.reserve('t1', 'concurrentRuns', 1)
    await manager.reserve('t1', 'concurrentRuns', 1)
    await manager.release(r1.id)

    const list = await manager.listReservations('t1')
    expect(list.length).toBe(1)
  })

  it('sweepExpired removes expired and released reservations', async () => {
    // Create a reservation with 0 TTL (already expired)
    await manager.reserve('t1', 'concurrentRuns', 1, 0)
    // Create a released reservation
    const r2 = await manager.reserve('t1', 'concurrentRuns', 1)
    await manager.release(r2.id)
    // Create an active reservation
    await manager.reserve('t1', 'concurrentRuns', 1, 60000)

    const swept = await manager.sweepExpired()
    expect(swept).toBe(2)

    // Only the active one remains
    const list = await manager.listReservations('t1')
    expect(list.length).toBe(1)
  })

  it('QuotaExceededError carries dimension info', () => {
    const err = new QuotaExceededError('concurrentRuns', 5, 6)
    expect(err.dimension).toBe('concurrentRuns')
    expect(err.limit).toBe(5)
    expect(err.current).toBe(6)
    expect(err.message).toContain('concurrentRuns')
    expect(err.name).toBe('QuotaExceededError')
  })

  it('reserve throws QuotaExceededError when over quota', async () => {
    await manager.setQuota('t-enforce', { concurrentRuns: 2 })
    await manager.reserve('t-enforce', 'concurrentRuns', 2)

    await expect(
      manager.reserve('t-enforce', 'concurrentRuns', 1),
    ).rejects.toThrow(QuotaExceededError)
  })

  it('reserve succeeds when within quota', async () => {
    await manager.setQuota('t-ok', { concurrentRuns: 5 })
    const res = await manager.reserve('t-ok', 'concurrentRuns', 3)
    expect(res.id).toBeTruthy()

    // Second reserve still within limit
    const res2 = await manager.reserve('t-ok', 'concurrentRuns', 2)
    expect(res2.id).toBeTruthy()
  })

  it('reserve allows unlimited when no quota set', async () => {
    // No quota set for this tenant — should not throw
    const res = await manager.reserve('t-unlimited', 'concurrentRuns', 9999)
    expect(res.id).toBeTruthy()
  })

  it('reserve allows unlimited for unset dimension', async () => {
    await manager.setQuota('t-partial', { concurrentRuns: 2 })
    // tokensPerMinute not set — should not throw
    const res = await manager.reserve('t-partial', 'tokensPerMinute', 9999)
    expect(res.id).toBeTruthy()
  })

  it('reserve respects released reservations', async () => {
    await manager.setQuota('t-release', { concurrentRuns: 2 })
    const r1 = await manager.reserve('t-release', 'concurrentRuns', 2)
    await manager.release(r1.id)

    // After release, usage is 0 — should succeed
    const r2 = await manager.reserve('t-release', 'concurrentRuns', 2)
    expect(r2.id).toBeTruthy()
  })
})

// ===========================================================================
// ECO-151: TracePrinter
// ===========================================================================

describe('TracePrinter', () => {
  it('formats agent:started event', () => {
    const printer = new TracePrinter(false)
    const line = printer.formatEvent({
      type: 'agent:started',
      agentId: 'agent-1',
      runId: 'run-12345678-abcd',
    })

    expect(line).toContain('[')
    expect(line).toContain(']')
    expect(line).toContain('agent:started')
    expect(line).toContain('run-1234') // truncated runId
    expect(line).toContain('agent=agent-1')
  })

  it('formats tool:called event', () => {
    const printer = new TracePrinter(false)
    const line = printer.formatEvent({
      type: 'tool:called',
      toolName: 'search_code',
      input: { query: 'test' },
    })

    expect(line).toContain('tool:called')
    expect(line).toContain('tool=search_code')
    expect(line).toContain('[--------]') // no runId
  })

  it('verbose mode includes JSON data', () => {
    const printer = new TracePrinter(true)
    const line = printer.formatEvent({
      type: 'memory:written',
      namespace: 'lessons',
      key: 'lesson-1',
    })

    expect(line).toContain('memory:written')
    expect(line).toContain('"namespace"')
    expect(line).toContain('"lessons"')
  })

  it('attach and detach subscribe/unsubscribe from event bus', () => {
    const eventBus = createEventBus()
    const printer = new TracePrinter(false)

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    printer.attach(eventBus)
    eventBus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    expect(consoleSpy).toHaveBeenCalledTimes(1)

    printer.detach()
    eventBus.emit({ type: 'agent:started', agentId: 'a2', runId: 'r2' })
    // Should not receive second event
    expect(consoleSpy).toHaveBeenCalledTimes(1)

    consoleSpy.mockRestore()
  })
})

// ===========================================================================
// ECO-157: Config Commands
// ===========================================================================

describe('Config commands', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'forge-config-'))
  })

  afterEach(() => {
    // Best-effort cleanup
    try {
      const files = ['valid.json', 'invalid.json', 'bad-port.json']
      for (const f of files) {
        try { unlinkSync(join(tmpDir, f)) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  })

  it('configValidate returns valid for correct config', () => {
    const path = join(tmpDir, 'valid.json')
    writeFileSync(path, JSON.stringify({ port: 4000, auth: { mode: 'api-key' } }))

    const result = configValidate(path)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('configValidate returns errors for invalid port', () => {
    const path = join(tmpDir, 'bad-port.json')
    writeFileSync(path, JSON.stringify({ port: -1 }))

    const result = configValidate(path)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('port'))).toBe(true)
  })

  it('configValidate returns error for missing file', () => {
    const result = configValidate('/nonexistent/path/config.json')
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('Cannot read')
  })

  it('configValidate returns error for invalid JSON', () => {
    const path = join(tmpDir, 'invalid.json')
    writeFileSync(path, 'not json {{{')

    const result = configValidate(path)
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('not valid JSON')
  })

  it('configShow returns parsed config', () => {
    const path = join(tmpDir, 'valid.json')
    const config = { port: 4000, database: { url: 'postgres://localhost' } }
    writeFileSync(path, JSON.stringify(config))

    const result = configShow(path)
    expect(result['port']).toBe(4000)
    expect((result['database'] as Record<string, unknown>)['url']).toBe('postgres://localhost')
  })

  it('configShow returns empty object for missing file', () => {
    const result = configShow('/nonexistent/path.json')
    expect(result).toEqual({})
  })
})

// ===========================================================================
// ECO-157: Memory Commands
// ===========================================================================

describe('Memory commands', () => {
  let memoryService: MemoryServiceLike

  beforeEach(async () => {
    memoryService = createMockMemoryService()
    await memoryService.put('lessons', { tenant: 't1' }, 'lesson-1', {
      text: 'Always validate inputs',
      importance: 0.8,
    })
    await memoryService.put('lessons', { tenant: 't1' }, 'lesson-2', {
      text: 'Use parameterized queries',
      importance: 0.9,
    })
    await memoryService.put('conventions', { tenant: 't1' }, 'conv-1', {
      text: 'Use camelCase for variables',
    })
  })

  it('memoryBrowse returns entries', async () => {
    const entries = await memoryBrowse(memoryService, {
      namespace: 'lessons',
      scope: { tenant: 't1' },
    })
    expect(entries.length).toBe(2)
    expect(entries[0]!.key).toBe('lesson-1')
  })

  it('memoryBrowse respects limit', async () => {
    const entries = await memoryBrowse(memoryService, {
      namespace: 'lessons',
      scope: { tenant: 't1' },
      limit: 1,
    })
    expect(entries.length).toBe(1)
  })

  it('memoryBrowse with search uses search method', async () => {
    const entries = await memoryBrowse(memoryService, {
      namespace: 'lessons',
      scope: { tenant: 't1' },
      search: 'validate',
    })
    expect(entries.length).toBeGreaterThanOrEqual(1)
  })

  it('memorySearch returns scored results', async () => {
    const results = await memorySearch(
      memoryService,
      'validate',
      { tenant: 't1' },
      ['lessons'],
    )
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]!.namespace).toBe('lessons')
    expect(results[0]!.score).toBe(1.0)
  })

  it('memorySearch across multiple namespaces', async () => {
    const results = await memorySearch(
      memoryService,
      'anything',
      { tenant: 't1' },
      ['lessons', 'conventions'],
    )
    // Should get results from both namespaces
    expect(results.length).toBeGreaterThanOrEqual(2)
    const namespaces = new Set(results.map((r) => r.namespace))
    expect(namespaces.has('lessons')).toBe(true)
    expect(namespaces.has('conventions')).toBe(true)
  })
})

// ===========================================================================
// ECO-166: Memory Browse Routes
// ===========================================================================

describe('Memory browse routes', () => {
  let app: ReturnType<typeof createForgeApp>
  let memoryService: MemoryServiceLike

  beforeEach(async () => {
    memoryService = createMockMemoryService()
    await memoryService.put('lessons', { tenant: 't1' }, 'lesson-1', {
      text: 'Always validate inputs',
    })
    await memoryService.put('lessons', { tenant: 't1' }, 'lesson-2', {
      text: 'Use parameterized queries',
    })
    app = createForgeApp(createTestConfig(memoryService))
  })

  it('GET /api/memory-browse/:namespace returns entries', async () => {
    const scope = encodeURIComponent(JSON.stringify({ tenant: 't1' }))
    const res = await app.request(`/api/memory-browse/lessons?scope=${scope}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: unknown[]; total: number }
    expect(body.data.length).toBe(2)
    expect(body.total).toBe(2)
  })

  it('GET /api/memory-browse/:namespace respects limit', async () => {
    const scope = encodeURIComponent(JSON.stringify({ tenant: 't1' }))
    const res = await app.request(`/api/memory-browse/lessons?scope=${scope}&limit=1`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: unknown[]; total: number; limit: number }
    expect(body.data.length).toBe(1)
    expect(body.limit).toBe(1)
  })

  it('GET /api/memory-browse/:namespace with search', async () => {
    const scope = encodeURIComponent(JSON.stringify({ tenant: 't1' }))
    const res = await app.request(`/api/memory-browse/lessons?scope=${scope}&search=validate`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: unknown[] }
    expect(body.data.length).toBeGreaterThanOrEqual(1)
  })

  it('GET /api/memory-browse/:namespace returns 400 for invalid scope JSON', async () => {
    const res = await app.request('/api/memory-browse/lessons?scope=not-json')
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('routes not mounted without memoryService', async () => {
    const appWithout = createForgeApp(createTestConfig())
    const res = await appWithout.request('/api/memory-browse/lessons')
    expect(res.status).toBe(404)
  })
})

// ===========================================================================
// ECO-166: Run Trace Route
// ===========================================================================

describe('Run trace route', () => {
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

  it('GET /api/runs/:id/trace returns trace data', async () => {
    const createRes = await req(app, 'POST', '/api/runs', {
      agentId: 'agent-1',
      input: { task: 'do something' },
    })
    const created = await createRes.json() as { data: { id: string } }
    const runId = created.data.id

    // Add some logs
    await config.runStore.addLog(runId, {
      level: 'info',
      phase: 'planning',
      message: 'Starting planning phase',
    })
    await config.runStore.addLog(runId, {
      level: 'info',
      phase: 'tool_call',
      message: 'Called search_code',
      data: { toolName: 'search_code', input: 'test' },
    })

    const res = await app.request(`/api/runs/${runId}/trace`)
    expect(res.status).toBe(200)

    const body = await res.json() as {
      data: {
        runId: string
        agentId: string
        status: string
        phases: string[]
        events: unknown[]
        toolCalls: unknown[]
        usage: { tokenUsage: { input: number; output: number }; costCents: number }
      }
    }

    expect(body.data.runId).toBe(runId)
    expect(body.data.agentId).toBe('agent-1')
    expect(body.data.status).toBe('queued')
    expect(body.data.phases).toContain('planning')
    expect(body.data.phases).toContain('tool_call')
    expect(body.data.events.length).toBe(2)
    expect(body.data.toolCalls.length).toBeGreaterThanOrEqual(1)
    expect(body.data.usage.tokenUsage).toEqual({ input: 0, output: 0 })
    expect(body.data.usage.costCents).toBe(0)
  })

  it('GET /api/runs/:id/trace returns 404 for unknown run', async () => {
    const res = await app.request('/api/runs/nonexistent/trace')
    expect(res.status).toBe(404)
  })
})
