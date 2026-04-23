/**
 * Tests for `POST /ingest` on the learning route — validates pattern persistence,
 * confidence filtering, provenance fields, and error handling.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { MemoryServiceLike } from '@dzupagent/memory-ipc'

import { createLearningRoutes } from '../learning.js'

// ---------------------------------------------------------------------------
// Mock MemoryServiceLike — simple Map-backed implementation.
// ---------------------------------------------------------------------------

class MockMemoryService implements MemoryServiceLike {
  readonly store = new Map<string, Record<string, unknown>>()
  putCalls = 0
  throwOnPut = false

  private makeKey(namespace: string, scope: Record<string, string>, key: string): string {
    return `${namespace}|${JSON.stringify(scope)}|${key}`
  }

  async get(): Promise<Record<string, unknown>[]> {
    return []
  }

  async search(
    namespace: string,
    scope: Record<string, string>,
  ): Promise<Record<string, unknown>[]> {
    const prefix = `${namespace}|${JSON.stringify(scope)}|`
    const results: Record<string, unknown>[] = []
    for (const [k, v] of this.store.entries()) {
      if (k.startsWith(prefix)) results.push(v)
    }
    return results
  }

  async put(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    this.putCalls++
    if (this.throwOnPut) {
      throw new Error('simulated-put-failure')
    }
    this.store.set(this.makeKey(namespace, scope, key), value)
  }

  async delete(): Promise<boolean> {
    return true
  }
}

function makeApp(overrides: Partial<Parameters<typeof createLearningRoutes>[0]> = {}) {
  const memoryService = new MockMemoryService()
  const app = createLearningRoutes({ memoryService, ...overrides })
  return { app, memoryService }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('POST /ingest — learning pattern ingestion', () => {
  let app: ReturnType<typeof makeApp>['app']
  let memoryService: MockMemoryService

  beforeEach(() => {
    const setup = makeApp()
    app = setup.app
    memoryService = setup.memoryService
  })

  it('stores patterns at or above the default confidence threshold (0.5)', async () => {
    const res = await app.request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-1',
        score: 0.9,
        patterns: [
          { pattern: 'use retry-on-429', context: 'http', confidence: 0.8 },
          { pattern: 'cache results', context: 'perf', confidence: 0.7 },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['success']).toBe(true)
    expect(body['stored']).toBe(2)
    expect(body['skipped']).toBe(0)
    expect(memoryService.store.size).toBe(2)
  })

  it('skips patterns below the confidence threshold', async () => {
    const res = await app.request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-2',
        score: 0.6,
        patterns: [
          { pattern: 'high conf', context: 'x', confidence: 0.9 },
          { pattern: 'low conf', context: 'x', confidence: 0.2 },
          { pattern: 'mid conf', context: 'x', confidence: 0.4 },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['stored']).toBe(1)
    expect(body['skipped']).toBe(2)
  })

  it('honours a custom ingestConfidenceThreshold', async () => {
    const setup = makeApp({ ingestConfidenceThreshold: 0.8 })
    const res = await setup.app.request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-3',
        score: 0.95,
        patterns: [
          { pattern: 'above threshold', context: 'x', confidence: 0.85 },
          { pattern: 'below threshold', context: 'x', confidence: 0.75 },
        ],
      }),
    })
    const body = (await res.json()) as Record<string, unknown>
    expect(body['stored']).toBe(1)
    expect(body['skipped']).toBe(1)
  })

  it('rejects request when runId is missing', async () => {
    const res = await app.request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: 0.8, patterns: [] }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(String(body['error'])).toMatch(/runId/)
  })

  it('rejects request when score is not a finite number', async () => {
    const res = await app.request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'run-x', patterns: [] }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(String(body['error'])).toMatch(/score/)
  })

  it('rejects request when patterns is not an array', async () => {
    const res = await app.request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'run-x', score: 0.5, patterns: 'nope' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(String(body['error'])).toMatch(/patterns/)
  })

  it('rejects an invalid JSON body', async () => {
    const res = await app.request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    })
    expect(res.status).toBe(400)
  })

  it('handles an empty patterns array cleanly', async () => {
    const res = await app.request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'run-empty', score: 1, patterns: [] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['stored']).toBe(0)
    expect(body['skipped']).toBe(0)
    expect(memoryService.store.size).toBe(0)
  })

  it('skips malformed pattern entries (non-objects, missing fields)', async () => {
    const res = await app.request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-skip',
        score: 0.5,
        patterns: [
          null,
          'not an object',
          { pattern: 'good', context: 'x', confidence: 0.9 },
          { pattern: '', context: 'x', confidence: 0.9 }, // empty pattern text
          { pattern: 'no conf', context: 'x' }, // missing confidence
        ],
      }),
    })
    const body = (await res.json()) as Record<string, unknown>
    expect(body['stored']).toBe(1)
    expect(body['skipped']).toBe(4)
  })

  it('records provenance (runId, score, agentId) on stored memory items', async () => {
    await app.request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-prov',
        score: 0.77,
        agentId: 'agent-42',
        patterns: [{ pattern: 'p', context: 'c', confidence: 0.9 }],
      }),
    })
    const stored = [...memoryService.store.values()][0]
    expect(stored).toBeDefined()
    const prov = stored!['provenance'] as Record<string, unknown>
    expect(prov['runId']).toBe('run-prov')
    expect(prov['score']).toBe(0.77)
    expect(prov['agentId']).toBe('agent-42')
  })

  it('sets decay metadata (ttlMs, expiresAt) on stored memory items', async () => {
    await app.request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-decay',
        score: 0.8,
        patterns: [{ pattern: 'p', context: 'c', confidence: 0.9 }],
      }),
    })
    const stored = [...memoryService.store.values()][0]
    const decay = stored!['decay'] as Record<string, unknown>
    expect(decay['ttlMs']).toBeGreaterThan(0)
    expect(decay['expiresAt']).toBeGreaterThan(decay['createdAt'] as number)
  })

  it('honours a custom ingestDefaultTtlMs', async () => {
    const setup = makeApp({ ingestDefaultTtlMs: 1000 })
    await setup.app.request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-ttl',
        score: 0.8,
        patterns: [{ pattern: 'p', context: 'c', confidence: 0.9 }],
      }),
    })
    const stored = [...setup.memoryService.store.values()][0]
    const decay = stored!['decay'] as Record<string, unknown>
    expect(decay['ttlMs']).toBe(1000)
  })

  it('returns 500 when the memory service fails for every pattern', async () => {
    memoryService.throwOnPut = true
    const res = await app.request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-err',
        score: 0.9,
        patterns: [{ pattern: 'p', context: 'c', confidence: 0.9 }],
      }),
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['success']).toBe(false)
    expect(String(body['error'])).toMatch(/simulated-put-failure/)
  })

  it('returns the stored keys for downstream correlation', async () => {
    const res = await app.request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-keys',
        score: 0.9,
        patterns: [
          { pattern: 'a', context: 'x', confidence: 0.9 },
          { pattern: 'b', context: 'x', confidence: 0.8 },
        ],
      }),
    })
    const body = (await res.json()) as Record<string, unknown>
    expect(Array.isArray(body['keys'])).toBe(true)
    expect((body['keys'] as string[]).length).toBe(2)
    for (const k of body['keys'] as string[]) {
      expect(k).toMatch(/^lesson-run-keys-/)
    }
  })
})
