import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import { CostTrackingMiddleware } from '../middleware/cost-tracking.js'
import type { CostTrackingConfig } from '../middleware/cost-tracking.js'
import type { AgentEvent, AgentCompletedEvent, AgentStartedEvent, TokenUsage } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* yieldEvents(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const e of events) yield e
}

async function collectAll<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of gen) items.push(item)
  return items
}

function collectBusEvents(bus: DzupEventBus): DzupEvent[] {
  const events: DzupEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

function makeCompletedEvent(
  providerId: 'claude' | 'codex' | 'gemini' | 'qwen' | 'crush',
  usage?: TokenUsage,
): AgentCompletedEvent {
  return {
    type: 'adapter:completed',
    providerId,
    sessionId: 'sess-1',
    result: 'done',
    usage,
    durationMs: 100,
    timestamp: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CostTrackingMiddleware', () => {
  let bus: DzupEventBus
  let emitted: DzupEvent[]

  beforeEach(() => {
    bus = createEventBus()
    emitted = collectBusEvents(bus)
  })

  describe('cost accumulation', () => {
    it('accumulates cost from adapter:completed events with costCents', async () => {
      const middleware = new CostTrackingMiddleware({ maxBudgetCents: 1000 })

      const events: AgentEvent[] = [
        makeCompletedEvent('claude', { inputTokens: 100, outputTokens: 50, costCents: 5 }),
        makeCompletedEvent('claude', { inputTokens: 200, outputTokens: 100, costCents: 10 }),
      ]

      await collectAll(middleware.wrap(yieldEvents(events)))

      const usage = middleware.getUsage()
      expect(usage.totalCostCents).toBe(15)
      expect(usage.totalTokens.input).toBe(300)
      expect(usage.totalTokens.output).toBe(150)
      expect(usage.perProvider['claude']).toEqual({
        costCents: 15,
        inputTokens: 300,
        outputTokens: 150,
        invocations: 2,
      })
    })

    it('estimates cost when costCents is not provided', async () => {
      const middleware = new CostTrackingMiddleware({ maxBudgetCents: 10000 })

      // Claude rates: input 300/1M, output 1500/1M
      // 1_000_000 input tokens => 300 cents
      // 1_000_000 output tokens => 1500 cents
      const events: AgentEvent[] = [
        makeCompletedEvent('claude', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      ]

      await collectAll(middleware.wrap(yieldEvents(events)))

      const usage = middleware.getUsage()
      // 300 + 1500 = 1800 cents
      expect(usage.totalCostCents).toBe(1800)
    })

    it('estimates cost correctly for different providers', async () => {
      const middleware = new CostTrackingMiddleware({ maxBudgetCents: 100000 })

      const events: AgentEvent[] = [
        // Gemini: input 125/1M, output 500/1M
        makeCompletedEvent('gemini', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      ]

      await collectAll(middleware.wrap(yieldEvents(events)))

      const usage = middleware.getUsage()
      // 125 + 500 = 625 cents
      expect(usage.totalCostCents).toBe(625)
    })
  })

  describe('budget warnings', () => {
    it('emits budget:warning at default 80% threshold', async () => {
      const middleware = new CostTrackingMiddleware({
        maxBudgetCents: 100,
        eventBus: bus,
      })

      // Cost of 85 cents (85%)
      const events: AgentEvent[] = [
        makeCompletedEvent('claude', { inputTokens: 100, outputTokens: 50, costCents: 85 }),
      ]

      await collectAll(middleware.wrap(yieldEvents(events)))

      const warnings = emitted.filter((e) => e.type === 'budget:warning')
      expect(warnings).toHaveLength(1)
      expect((warnings[0] as Record<string, unknown>)['level']).toBe('warn')
    })

    it('emits budget:warning with critical level at 95% threshold', async () => {
      const middleware = new CostTrackingMiddleware({
        maxBudgetCents: 100,
        eventBus: bus,
      })

      // Cost of 96 cents (96%) -- jumps straight to critical
      const events: AgentEvent[] = [
        makeCompletedEvent('claude', { inputTokens: 100, outputTokens: 50, costCents: 96 }),
      ]

      await collectAll(middleware.wrap(yieldEvents(events)))

      const warnings = emitted.filter((e) => e.type === 'budget:warning')
      expect(warnings).toHaveLength(1)
      expect((warnings[0] as Record<string, unknown>)['level']).toBe('critical')
    })

    it('emits custom warning threshold', async () => {
      const middleware = new CostTrackingMiddleware({
        maxBudgetCents: 100,
        warningThresholdPercent: 50,
        eventBus: bus,
      })

      const events: AgentEvent[] = [
        makeCompletedEvent('claude', { inputTokens: 100, outputTokens: 50, costCents: 55 }),
      ]

      await collectAll(middleware.wrap(yieldEvents(events)))

      const warnings = emitted.filter((e) => e.type === 'budget:warning')
      expect(warnings).toHaveLength(1)
    })

    it('does not emit duplicate warnings', async () => {
      const middleware = new CostTrackingMiddleware({
        maxBudgetCents: 100,
        eventBus: bus,
      })

      const events: AgentEvent[] = [
        makeCompletedEvent('claude', { inputTokens: 100, outputTokens: 50, costCents: 82 }),
        makeCompletedEvent('claude', { inputTokens: 100, outputTokens: 50, costCents: 5 }),
      ]

      await collectAll(middleware.wrap(yieldEvents(events)))

      const warnings = emitted.filter((e) => e.type === 'budget:warning')
      expect(warnings).toHaveLength(1)
    })
  })

  describe('budget exceeded', () => {
    it('throws on global budget exceeded', async () => {
      const middleware = new CostTrackingMiddleware({
        maxBudgetCents: 10,
        eventBus: bus,
      })

      const events: AgentEvent[] = [
        makeCompletedEvent('claude', { inputTokens: 100, outputTokens: 50, costCents: 15 }),
      ]

      await expect(collectAll(middleware.wrap(yieldEvents(events)))).rejects.toThrow('Total budget exceeded')
    })

    it('emits budget:exceeded event before throwing', async () => {
      const middleware = new CostTrackingMiddleware({
        maxBudgetCents: 10,
        eventBus: bus,
      })

      const events: AgentEvent[] = [
        makeCompletedEvent('claude', { inputTokens: 100, outputTokens: 50, costCents: 15 }),
      ]

      try {
        await collectAll(middleware.wrap(yieldEvents(events)))
      } catch {
        // expected
      }

      const exceeded = emitted.filter((e) => e.type === 'budget:exceeded')
      expect(exceeded).toHaveLength(1)
    })

    it('throws on per-provider budget exceeded', async () => {
      const middleware = new CostTrackingMiddleware({
        maxBudgetCents: 1000,
        perProviderBudgetCents: { claude: 5 },
      })

      const events: AgentEvent[] = [
        makeCompletedEvent('claude', { inputTokens: 100, outputTokens: 50, costCents: 10 }),
      ]

      await expect(collectAll(middleware.wrap(yieldEvents(events)))).rejects.toThrow(
        'Provider "claude" budget exceeded',
      )
    })
  })

  describe('getUsage()', () => {
    it('returns correct per-provider breakdown', async () => {
      const middleware = new CostTrackingMiddleware({ maxBudgetCents: 10000 })

      const events: AgentEvent[] = [
        makeCompletedEvent('claude', { inputTokens: 100, outputTokens: 50, costCents: 5 }),
        makeCompletedEvent('gemini', { inputTokens: 200, outputTokens: 100, costCents: 3 }),
        makeCompletedEvent('claude', { inputTokens: 150, outputTokens: 75, costCents: 7 }),
      ]

      await collectAll(middleware.wrap(yieldEvents(events)))

      const usage = middleware.getUsage()
      expect(usage.totalCostCents).toBe(15)
      expect(usage.perProvider['claude']).toEqual({
        costCents: 12,
        inputTokens: 250,
        outputTokens: 125,
        invocations: 2,
      })
      expect(usage.perProvider['gemini']).toEqual({
        costCents: 3,
        inputTokens: 200,
        outputTokens: 100,
        invocations: 1,
      })
    })

    it('returns empty report when no events processed', () => {
      const middleware = new CostTrackingMiddleware({})
      const usage = middleware.getUsage()
      expect(usage.totalCostCents).toBe(0)
      expect(usage.totalTokens).toEqual({ input: 0, output: 0, cached: 0 })
      expect(usage.perProvider).toEqual({})
    })
  })

  describe('reset()', () => {
    it('clears accumulated costs and thresholds', async () => {
      const middleware = new CostTrackingMiddleware({
        maxBudgetCents: 100,
        eventBus: bus,
      })

      const events: AgentEvent[] = [
        makeCompletedEvent('claude', { inputTokens: 100, outputTokens: 50, costCents: 85 }),
      ]

      await collectAll(middleware.wrap(yieldEvents(events)))
      expect(middleware.getUsage().totalCostCents).toBe(85)

      middleware.reset()

      const usage = middleware.getUsage()
      expect(usage.totalCostCents).toBe(0)
      expect(usage.perProvider).toEqual({})

      // After reset, warnings can fire again
      emitted.length = 0
      const events2: AgentEvent[] = [
        makeCompletedEvent('claude', { inputTokens: 100, outputTokens: 50, costCents: 85 }),
      ]
      await collectAll(middleware.wrap(yieldEvents(events2)))

      const warnings = emitted.filter((e) => e.type === 'budget:warning')
      expect(warnings).toHaveLength(1)
    })
  })

  describe('passthrough behavior', () => {
    it('yields all events unchanged including those without usage', async () => {
      const middleware = new CostTrackingMiddleware({ maxBudgetCents: 1000 })

      const startedEvent: AgentStartedEvent = {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 'sess-1',
        timestamp: Date.now(),
      }
      const completedEvent = makeCompletedEvent('claude', {
        inputTokens: 100,
        outputTokens: 50,
        costCents: 1,
      })

      const yielded = await collectAll(
        middleware.wrap(yieldEvents([startedEvent, completedEvent])),
      )

      expect(yielded).toHaveLength(2)
      expect(yielded[0]).toBe(startedEvent)
      expect(yielded[1]).toBe(completedEvent)
    })

    it('handles adapter:completed without usage gracefully', async () => {
      const middleware = new CostTrackingMiddleware({ maxBudgetCents: 1000 })

      const completedNoUsage: AgentCompletedEvent = {
        type: 'adapter:completed',
        providerId: 'claude',
        sessionId: 'sess-1',
        result: 'done',
        durationMs: 100,
        timestamp: Date.now(),
        // no usage field
      }

      const yielded = await collectAll(middleware.wrap(yieldEvents([completedNoUsage])))
      expect(yielded).toHaveLength(1)

      // No cost should be recorded
      const usage = middleware.getUsage()
      expect(usage.totalCostCents).toBe(0)
    })
  })
})
