/**
 * Closed-loop wiring tests — Session I.
 *
 * Verifies that `createForgeApp` correctly:
 * 1. Calls `start()` on `promptFeedbackLoop` / `learningEventProcessor` on boot.
 * 2. Registers `stop()` on the graceful shutdown drain hook when provided.
 * 3. Is a graceful no-op when neither is provided.
 * 4. Allows both subscribers to independently observe `run:scored` events
 *    on the shared event bus (so "scored run → optimizer → version store"
 *    and "scored run → patterns → memory store" flows both fire).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
  type DzupEvent,
  type DzupEventBus,
} from '@dzupagent/core'
import type { MemoryServiceLike } from '@dzupagent/memory-ipc'

import { createForgeApp, type ForgeServerConfig } from '../app.js'
import { GracefulShutdown } from '../lifecycle/graceful-shutdown.js'
import { LearningEventProcessor } from '../services/learning-event-processor.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createBaseConfig(overrides: Partial<ForgeServerConfig> = {}): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    ...overrides,
  }
}

class MockMemoryService implements MemoryServiceLike {
  readonly store = new Map<string, Record<string, unknown>>()
  putCalls = 0

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
    this.store.set(`${namespace}|${JSON.stringify(scope)}|${key}`, value)
  }
  async delete(): Promise<boolean> {
    return true
  }
}

type ScoredEvent = Extract<DzupEvent, { type: 'run:scored' }>

function scoredEvent(overrides: Partial<ScoredEvent> = {}): ScoredEvent {
  return {
    type: 'run:scored',
    runId: overrides.runId ?? 'run-wiring-1',
    score: overrides.score ?? 0.35,
    passed: overrides.passed ?? false,
    scorerBreakdown:
      overrides.scorerBreakdown ?? [
        { scorerName: 'kw', score: 0.2, pass: false, reasoning: 'missing keywords' },
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

function makeShutdown(eventBus: DzupEventBus): GracefulShutdown {
  return new GracefulShutdown({
    drainTimeoutMs: 1_000,
    runStore: new InMemoryRunStore(),
    eventBus,
  })
}

function getDrainHook(shutdown: GracefulShutdown): (() => Promise<void>) | undefined {
  return (shutdown as unknown as { config: { onDrain?: () => Promise<void> } }).config.onDrain
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('createForgeApp — closed-loop wiring', () => {
  let eventBus: DzupEventBus

  beforeEach(() => {
    eventBus = createEventBus()
  })

  it('calls start() on promptFeedbackLoop when provided', () => {
    const loop = { start: vi.fn(), stop: vi.fn() }

    createForgeApp(createBaseConfig({ eventBus, promptFeedbackLoop: loop }))

    expect(loop.start).toHaveBeenCalledTimes(1)
    expect(loop.stop).not.toHaveBeenCalled()
  })

  it('calls start() on learningEventProcessor when provided', () => {
    const proc = { start: vi.fn(), stop: vi.fn() }

    createForgeApp(createBaseConfig({ eventBus, learningEventProcessor: proc }))

    expect(proc.start).toHaveBeenCalledTimes(1)
    expect(proc.stop).not.toHaveBeenCalled()
  })

  it('registers stop() on shutdown drain hook for promptFeedbackLoop', async () => {
    const loop = { start: vi.fn(), stop: vi.fn() }
    const shutdown = makeShutdown(eventBus)

    createForgeApp(createBaseConfig({ eventBus, shutdown, promptFeedbackLoop: loop }))

    const drainHook = getDrainHook(shutdown)
    expect(drainHook).toBeTypeOf('function')

    await drainHook?.()
    expect(loop.stop).toHaveBeenCalledTimes(1)
  })

  it('registers stop() on shutdown drain hook for learningEventProcessor', async () => {
    const proc = { start: vi.fn(), stop: vi.fn() }
    const shutdown = makeShutdown(eventBus)

    createForgeApp(createBaseConfig({ eventBus, shutdown, learningEventProcessor: proc }))

    const drainHook = getDrainHook(shutdown)
    expect(drainHook).toBeTypeOf('function')

    await drainHook?.()
    expect(proc.stop).toHaveBeenCalledTimes(1)
  })

  it('is a graceful no-op when neither is provided', () => {
    // Should not throw or log any errors when both are omitted.
    expect(() => createForgeApp(createBaseConfig({ eventBus }))).not.toThrow()
  })

  it('scored run → patterns → memory stored (learning processor wired to shared bus)', async () => {
    const memoryService = new MockMemoryService()
    const processor = new LearningEventProcessor({ eventBus, memoryService })

    createForgeApp(createBaseConfig({ eventBus, learningEventProcessor: processor }))

    eventBus.emit(scoredEvent({ runId: 'run-learn', score: 0.9, passed: true, scorerBreakdown: [
      { scorerName: 'kw', score: 0.9, pass: true, reasoning: 'matches' },
    ] }))
    await flush()

    expect(memoryService.putCalls).toBeGreaterThan(0)
  })

  it('scored run → optimizer invoked (prompt feedback loop wired to shared bus)', async () => {
    // Use a structural mock whose start() subscribes to the shared event bus,
    // mirroring what the real PromptFeedbackLoop does. On each `run:scored`
    // event it calls the optimizer stand-in.
    const onScored = vi.fn()
    const loop = {
      start: vi.fn(() => {
        eventBus.on('run:scored', onScored)
      }),
      stop: vi.fn(),
    }

    createForgeApp(createBaseConfig({ eventBus, promptFeedbackLoop: loop }))
    expect(loop.start).toHaveBeenCalled()

    eventBus.emit(scoredEvent({ runId: 'run-optim' }))
    await flush()

    expect(onScored).toHaveBeenCalledTimes(1)
    expect(onScored).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'run:scored', runId: 'run-optim' }),
    )
  })

  it('both subscribers receive the same run:scored event on the shared bus', async () => {
    const loopHandler = vi.fn()
    const procHandler = vi.fn()

    const loop = {
      start: vi.fn(() => {
        eventBus.on('run:scored', loopHandler)
      }),
      stop: vi.fn(),
    }
    const proc = {
      start: vi.fn(() => {
        eventBus.on('run:scored', procHandler)
      }),
      stop: vi.fn(),
    }

    createForgeApp(
      createBaseConfig({
        eventBus,
        promptFeedbackLoop: loop,
        learningEventProcessor: proc,
      }),
    )

    const evt = scoredEvent({ runId: 'run-shared' })
    eventBus.emit(evt)
    await flush()

    expect(loopHandler).toHaveBeenCalledTimes(1)
    expect(procHandler).toHaveBeenCalledTimes(1)
    expect(loopHandler).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-shared' }))
    expect(procHandler).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-shared' }))
  })

  it('drain hook stops both subscribers without dropping existing hooks', async () => {
    const loop = { start: vi.fn(), stop: vi.fn() }
    const proc = { start: vi.fn(), stop: vi.fn() }
    const calls: string[] = []
    const shutdown = new GracefulShutdown({
      drainTimeoutMs: 1_000,
      runStore: new InMemoryRunStore(),
      eventBus,
      onDrain: async () => {
        calls.push('original')
      },
    })

    createForgeApp(
      createBaseConfig({
        eventBus,
        shutdown,
        promptFeedbackLoop: loop,
        learningEventProcessor: proc,
      }),
    )

    await getDrainHook(shutdown)?.()

    // Both stop()s must have fired, and the original onDrain must still run.
    expect(loop.stop).toHaveBeenCalledTimes(1)
    expect(proc.stop).toHaveBeenCalledTimes(1)
    expect(calls).toContain('original')
  })

  it('does not register drain hook when shutdown is omitted even if loops are provided', () => {
    const loop = { start: vi.fn(), stop: vi.fn() }
    const proc = { start: vi.fn(), stop: vi.fn() }

    // No shutdown provided → start() still called, stop() never invoked automatically.
    createForgeApp(
      createBaseConfig({
        eventBus,
        promptFeedbackLoop: loop,
        learningEventProcessor: proc,
      }),
    )

    expect(loop.start).toHaveBeenCalledTimes(1)
    expect(proc.start).toHaveBeenCalledTimes(1)
    expect(loop.stop).not.toHaveBeenCalled()
    expect(proc.stop).not.toHaveBeenCalled()
  })
})
