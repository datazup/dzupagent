/**
 * Tests for LearningEventProcessor — subscribes to `run:scored` events, extracts
 * patterns heuristically, and persists them via MemoryServiceLike.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createEventBus, type DzupEvent, type DzupEventBus } from '@dzupagent/core'
import type { MemoryServiceLike } from '@dzupagent/memory-ipc'

import { LearningEventProcessor } from '../learning-event-processor.js'

// ---------------------------------------------------------------------------
// Mock MemoryServiceLike
// ---------------------------------------------------------------------------

class MockMemoryService implements MemoryServiceLike {
  readonly store = new Map<string, Record<string, unknown>>()
  putCalls = 0
  throwOnPut = false

  async get(): Promise<Record<string, unknown>[]> {
    return []
  }
  async search(): Promise<Record<string, unknown>[]> {
    return []
  }
  async put(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    this.putCalls++
    if (this.throwOnPut) {
      throw new Error('put-failed')
    }
    this.store.set(`${namespace}|${JSON.stringify(scope)}|${key}`, value)
  }
  async delete(): Promise<boolean> {
    return true
  }
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

type ScoredEvent = Extract<DzupEvent, { type: 'run:scored' }>

function scoredEvent(overrides: Partial<ScoredEvent> = {}): ScoredEvent {
  return {
    type: 'run:scored',
    runId: overrides.runId ?? 'run-1',
    ...(overrides.agentId !== undefined ? { agentId: overrides.agentId } : {}),
    score: overrides.score ?? 0.85,
    passed: overrides.passed ?? true,
    scorerBreakdown:
      overrides.scorerBreakdown ?? [
        { scorerName: 'exact', score: 0.9, pass: true, reasoning: 'matches' },
      ],
    metrics:
      overrides.metrics ?? {
        totalEvents: 5,
        toolCalls: 1,
        toolErrors: 0,
        errors: 0,
      },
    scoredAt: overrides.scoredAt ?? Date.now(),
  } as ScoredEvent
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('LearningEventProcessor', () => {
  let eventBus: DzupEventBus
  let memoryService: MockMemoryService

  beforeEach(() => {
    eventBus = createEventBus()
    memoryService = new MockMemoryService()
  })

  // --- constructor ---

  it('throws when eventBus is missing', () => {
    expect(
      () =>
        new LearningEventProcessor({
          eventBus: undefined as unknown as DzupEventBus,
          memoryService,
        }),
    ).toThrow(/eventBus is required/)
  })

  it('throws when memoryService is missing', () => {
    expect(
      () =>
        new LearningEventProcessor({
          eventBus,
          memoryService: undefined as unknown as MemoryServiceLike,
        }),
    ).toThrow(/memoryService is required/)
  })

  // --- lifecycle ---

  it('subscribes to run:scored on start()', async () => {
    const proc = new LearningEventProcessor({ eventBus, memoryService })
    expect(proc.isRunning()).toBe(false)
    proc.start()
    expect(proc.isRunning()).toBe(true)

    eventBus.emit(scoredEvent())
    await flush()
    expect(memoryService.putCalls).toBeGreaterThan(0)
  })

  it('unsubscribes on stop()', async () => {
    const proc = new LearningEventProcessor({ eventBus, memoryService })
    proc.start()
    proc.stop()
    expect(proc.isRunning()).toBe(false)

    eventBus.emit(scoredEvent())
    await flush()
    expect(memoryService.putCalls).toBe(0)
  })

  it('start() and stop() are idempotent', async () => {
    const proc = new LearningEventProcessor({ eventBus, memoryService })
    proc.start()
    proc.start()
    proc.stop()
    proc.stop()
    expect(proc.isRunning()).toBe(false)
    eventBus.emit(scoredEvent())
    await flush()
    expect(memoryService.putCalls).toBe(0)
  })

  // --- pattern extraction ---

  it('extracts a passing-scorer pattern with confidence = scorer score', async () => {
    const proc = new LearningEventProcessor({ eventBus, memoryService })
    const result = await proc.handle(
      scoredEvent({
        scorerBreakdown: [
          { scorerName: 'kw', score: 0.9, pass: true, reasoning: 'all keywords present' },
        ],
      }),
    )
    expect(result.stored).toBeGreaterThanOrEqual(1)
    const stored = [...memoryService.store.values()][0]!
    expect(stored['context']).toBe('scorer:kw')
    expect(stored['confidence']).toBeCloseTo(0.9, 5)
  })

  it('extracts a failure-mode pattern for a failing scorer', async () => {
    const proc = new LearningEventProcessor({ eventBus, memoryService })
    await proc.handle(
      scoredEvent({
        score: 0.2,
        passed: false,
        scorerBreakdown: [
          { scorerName: 'kw', score: 0.1, pass: false, reasoning: 'missing keywords' },
        ],
      }),
    )
    const stored = [...memoryService.store.values()]
    const failure = stored.find((s) => String(s['context']).startsWith('failure:'))
    expect(failure).toBeDefined()
    // confidence = 1 - 0.1 = 0.9
    expect(failure!['confidence']).toBeCloseTo(0.9, 5)
  })

  it('adds a clean-completion pattern when passed && zero errors', async () => {
    const proc = new LearningEventProcessor({ eventBus, memoryService })
    await proc.handle(
      scoredEvent({
        score: 0.95,
        passed: true,
        metrics: { totalEvents: 3, toolCalls: 1, toolErrors: 0, errors: 0 },
      }),
    )
    const contexts = [...memoryService.store.values()].map((s) => s['context'])
    expect(contexts).toContain('completion:clean')
  })

  it('adds a heavy-tools pattern when toolCalls > 3', async () => {
    const proc = new LearningEventProcessor({ eventBus, memoryService })
    await proc.handle(
      scoredEvent({
        metrics: { totalEvents: 10, toolCalls: 7, toolErrors: 0, errors: 0 },
      }),
    )
    const contexts = [...memoryService.store.values()].map((s) => s['context'])
    expect(contexts).toContain('usage:heavy_tools')
  })

  it('skips patterns below the confidence threshold', async () => {
    const proc = new LearningEventProcessor({
      eventBus,
      memoryService,
      confidenceThreshold: 0.9,
    })
    const result = await proc.handle(
      scoredEvent({
        scorerBreakdown: [
          { scorerName: 'weak', score: 0.5, pass: true, reasoning: 'meh' },
        ],
        metrics: { totalEvents: 1, toolCalls: 0, toolErrors: 0, errors: 0 },
      }),
    )
    expect(result.stored).toBe(0)
    expect(result.skipped).toBeGreaterThan(0)
  })

  // --- provenance + decay ---

  it('records provenance fields (runId, score, agentId) on stored items', async () => {
    const proc = new LearningEventProcessor({ eventBus, memoryService })
    await proc.handle(scoredEvent({ runId: 'r-prov', agentId: 'a-7', score: 0.8 }))
    const stored = [...memoryService.store.values()][0]!
    const prov = stored['provenance'] as Record<string, unknown>
    expect(prov['runId']).toBe('r-prov')
    expect(prov['agentId']).toBe('a-7')
    expect(prov['score']).toBe(0.8)
  })

  it('records decay metadata with the configured ttlMs', async () => {
    const proc = new LearningEventProcessor({
      eventBus,
      memoryService,
      ttlMs: 60_000,
    })
    await proc.handle(scoredEvent())
    const stored = [...memoryService.store.values()][0]!
    const decay = stored['decay'] as Record<string, unknown>
    expect(decay['ttlMs']).toBe(60_000)
  })

  // --- error handling + edge cases ---

  it('produces no patterns when the event has no extractable context', async () => {
    const proc = new LearningEventProcessor({ eventBus, memoryService })
    const result = await proc.handle(
      scoredEvent({
        score: 0.3,
        passed: false,
        scorerBreakdown: [], // empty
        metrics: { totalEvents: 0, toolCalls: 0, toolErrors: 0, errors: 0 },
      }),
    )
    expect(result.extracted).toBe(0)
    expect(result.stored).toBe(0)
  })

  it('surfaces memory service errors via onError without throwing', async () => {
    const errors: Array<{ runId: string; msg: string }> = []
    memoryService.throwOnPut = true
    const proc = new LearningEventProcessor({
      eventBus,
      memoryService,
      onError: (runId, msg) => errors.push({ runId, msg }),
    })
    const result = await proc.handle(
      scoredEvent({ runId: 'r-err', score: 0.9 }),
    )
    expect(result.stored).toBe(0)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]!.runId).toBe('r-err')
    expect(errors[0]!.msg).toMatch(/put-failed/)
  })

  it('uses the configured tenantId for scope', async () => {
    const proc = new LearningEventProcessor({
      eventBus,
      memoryService,
      tenantId: 'tenant-42',
    })
    await proc.handle(scoredEvent())
    const firstKey = [...memoryService.store.keys()][0]!
    expect(firstKey).toContain('"tenantId":"tenant-42"')
  })
})
