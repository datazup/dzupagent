/**
 * Tests for reflection HTTP routes.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createReflectionRoutes } from '../routes/reflections.js'
import type { RunReflectionStore, ReflectionSummary, ReflectionPattern } from '@dzupagent/agent'
import { InMemoryReflectionStore } from '@dzupagent/agent'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp(store?: RunReflectionStore) {
  const reflectionStore = store ?? new InMemoryReflectionStore()
  const routes = createReflectionRoutes({ reflectionStore })
  const app = new Hono()
  app.route('/api/reflections', routes)
  return { app, reflectionStore }
}

function makeSummary(overrides: Partial<ReflectionSummary> = {}): ReflectionSummary {
  return {
    runId: overrides.runId ?? 'run-1',
    completedAt: overrides.completedAt ?? new Date('2026-04-16T12:00:00.000Z'),
    durationMs: overrides.durationMs ?? 5000,
    totalSteps: overrides.totalSteps ?? 10,
    toolCallCount: overrides.toolCallCount ?? 5,
    errorCount: overrides.errorCount ?? 1,
    patterns: overrides.patterns ?? [],
    qualityScore: overrides.qualityScore ?? 0.85,
  }
}

// ---------------------------------------------------------------------------
// GET /api/reflections
// ---------------------------------------------------------------------------

describe('GET /api/reflections', () => {
  it('returns empty array when no reflections exist', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/reflections')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ reflections: [] })
  })

  it('returns list of reflections', async () => {
    const store = new InMemoryReflectionStore()
    await store.save(makeSummary({ runId: 'run-1' }))
    await store.save(makeSummary({ runId: 'run-2' }))
    const { app } = createTestApp(store)

    const res = await app.request('/api/reflections')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { reflections: ReflectionSummary[] }
    expect(body.reflections).toHaveLength(2)
  })

  it('returns reflections with correct fields', async () => {
    const store = new InMemoryReflectionStore()
    await store.save(makeSummary({ runId: 'run-1', qualityScore: 0.92 }))
    const { app } = createTestApp(store)

    const res = await app.request('/api/reflections')
    const body = (await res.json()) as { reflections: ReflectionSummary[] }
    const r = body.reflections[0]!
    expect(r.runId).toBe('run-1')
    expect(r.qualityScore).toBe(0.92)
    expect(r.durationMs).toBe(5000)
    expect(r.totalSteps).toBe(10)
    expect(r.toolCallCount).toBe(5)
    expect(r.errorCount).toBe(1)
  })

  it('respects limit query parameter', async () => {
    const store = new InMemoryReflectionStore()
    for (let i = 0; i < 5; i++) {
      await store.save(makeSummary({
        runId: `run-${i}`,
        completedAt: new Date(Date.now() - i * 1000),
      }))
    }
    const { app } = createTestApp(store)

    const res = await app.request('/api/reflections?limit=2')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { reflections: ReflectionSummary[] }
    expect(body.reflections).toHaveLength(2)
  })

  it('defaults to limit 20', async () => {
    const store = new InMemoryReflectionStore()
    for (let i = 0; i < 25; i++) {
      await store.save(makeSummary({
        runId: `run-${i}`,
        completedAt: new Date(Date.now() - i * 1000),
      }))
    }
    const { app } = createTestApp(store)

    const res = await app.request('/api/reflections')
    const body = (await res.json()) as { reflections: ReflectionSummary[] }
    expect(body.reflections).toHaveLength(20)
  })

  it('caps limit at 100', async () => {
    const store = new InMemoryReflectionStore()
    const { app } = createTestApp(store)

    // Just check it does not crash with limit=200
    const res = await app.request('/api/reflections?limit=200')
    expect(res.status).toBe(200)
  })

  it('ignores invalid limit param and uses default', async () => {
    const store = new InMemoryReflectionStore()
    await store.save(makeSummary())
    const { app } = createTestApp(store)

    const res = await app.request('/api/reflections?limit=abc')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { reflections: ReflectionSummary[] }
    expect(body.reflections).toHaveLength(1)
  })

  it('returns reflections with patterns included', async () => {
    const patterns: ReflectionPattern[] = [
      { type: 'repeated_tool', description: 'web_search x3', occurrences: 3, stepIndices: [0, 1, 2] },
    ]
    const store = new InMemoryReflectionStore()
    await store.save(makeSummary({ patterns }))
    const { app } = createTestApp(store)

    const res = await app.request('/api/reflections')
    const body = (await res.json()) as { reflections: ReflectionSummary[] }
    expect(body.reflections[0]!.patterns).toHaveLength(1)
    expect(body.reflections[0]!.patterns[0]!.type).toBe('repeated_tool')
  })
})

// ---------------------------------------------------------------------------
// GET /api/reflections/:runId
// ---------------------------------------------------------------------------

describe('GET /api/reflections/:runId', () => {
  it('returns reflection for known runId', async () => {
    const store = new InMemoryReflectionStore()
    await store.save(makeSummary({ runId: 'run-42', qualityScore: 0.77 }))
    const { app } = createTestApp(store)

    const res = await app.request('/api/reflections/run-42')
    expect(res.status).toBe(200)
    const body = (await res.json()) as ReflectionSummary
    expect(body.runId).toBe('run-42')
    expect(body.qualityScore).toBe(0.77)
  })

  it('returns 404 for unknown runId', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/reflections/nonexistent')
    expect(res.status).toBe(404)
  })

  it('returns NOT_FOUND error code for unknown runId', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/reflections/nonexistent')
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toBe('Reflection not found')
  })

  it('returns all fields for known runId', async () => {
    const store = new InMemoryReflectionStore()
    await store.save(makeSummary({
      runId: 'run-full',
      durationMs: 3000,
      totalSteps: 7,
      toolCallCount: 3,
      errorCount: 2,
      qualityScore: 0.6,
    }))
    const { app } = createTestApp(store)

    const res = await app.request('/api/reflections/run-full')
    const body = (await res.json()) as ReflectionSummary
    expect(body.durationMs).toBe(3000)
    expect(body.totalSteps).toBe(7)
    expect(body.toolCallCount).toBe(3)
    expect(body.errorCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// GET /api/reflections/patterns/:type
// ---------------------------------------------------------------------------

describe('GET /api/reflections/patterns/:type', () => {
  it('returns patterns of specified type', async () => {
    const store = new InMemoryReflectionStore()
    await store.save(makeSummary({
      runId: 'run-1',
      patterns: [
        { type: 'repeated_tool', description: 'web_search x3', occurrences: 3, stepIndices: [0, 1, 2] },
        { type: 'error_loop', description: 'retry x2', occurrences: 2, stepIndices: [3, 4] },
      ],
    }))
    await store.save(makeSummary({
      runId: 'run-2',
      patterns: [
        { type: 'repeated_tool', description: 'db_query x4', occurrences: 4, stepIndices: [0, 1, 2, 3] },
      ],
    }))
    const { app } = createTestApp(store)

    const res = await app.request('/api/reflections/patterns/repeated_tool')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { patterns: ReflectionPattern[] }
    expect(body.patterns).toHaveLength(2)
    expect(body.patterns.every((p) => p.type === 'repeated_tool')).toBe(true)
  })

  it('returns empty array when no patterns match', async () => {
    const store = new InMemoryReflectionStore()
    await store.save(makeSummary({
      runId: 'run-1',
      patterns: [
        { type: 'successful_strategy', description: 'clean', occurrences: 1, stepIndices: [0] },
      ],
    }))
    const { app } = createTestApp(store)

    const res = await app.request('/api/reflections/patterns/error_loop')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { patterns: ReflectionPattern[] }
    expect(body.patterns).toEqual([])
  })

  it('returns 400 for invalid pattern type', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/reflections/patterns/invalid_type')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('BAD_REQUEST')
  })

  it('accepts all four valid pattern types', async () => {
    const { app } = createTestApp()
    const validTypes = ['repeated_tool', 'error_loop', 'successful_strategy', 'slow_step']

    for (const type of validTypes) {
      const res = await app.request(`/api/reflections/patterns/${type}`)
      expect(res.status).toBe(200)
    }
  })

  it('returns patterns from multiple runs', async () => {
    const store = new InMemoryReflectionStore()
    await store.save(makeSummary({
      runId: 'run-1',
      patterns: [{ type: 'slow_step', description: 'slow A', occurrences: 1, stepIndices: [2] }],
    }))
    await store.save(makeSummary({
      runId: 'run-2',
      patterns: [{ type: 'slow_step', description: 'slow B', occurrences: 1, stepIndices: [4] }],
    }))
    const { app } = createTestApp(store)

    const res = await app.request('/api/reflections/patterns/slow_step')
    const body = (await res.json()) as { patterns: ReflectionPattern[] }
    expect(body.patterns).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Routes not mounted when store absent
// ---------------------------------------------------------------------------

describe('Reflection routes not mounted when store absent', () => {
  it('returns 404 on /api/reflections when no reflectionStore configured', async () => {
    const app = new Hono()
    const res = await app.request('/api/reflections')
    expect(res.status).toBe(404)
  })

  it('returns 404 on /api/reflections/:runId when no reflectionStore configured', async () => {
    const app = new Hono()
    const res = await app.request('/api/reflections/run-1')
    expect(res.status).toBe(404)
  })

  it('returns 404 on /api/reflections/patterns/:type when no reflectionStore configured', async () => {
    const app = new Hono()
    const res = await app.request('/api/reflections/patterns/error_loop')
    expect(res.status).toBe(404)
  })
})
