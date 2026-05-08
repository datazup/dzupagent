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
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
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

    it('correctly prices cache-read tokens at 10% of input rate', async () => {
      const middleware = new CostTrackingMiddleware({ maxBudgetCents: 10000 })

      // Claude cache-read: 30/1M (0.1× the 300/1M input rate)
      // 1_000_000 cache-read tokens at 30/1M = 30 cents
      // 0 uncached input, 0 output
      const events: AgentEvent[] = [
        makeCompletedEvent('claude', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 }),
      ]

      await collectAll(middleware.wrap(yieldEvents(events)))

      const usage = middleware.getUsage()
      expect(usage.totalCostCents).toBe(30)
      expect(usage.totalTokens.cacheRead).toBe(1_000_000)
      expect(usage.totalTokens.cacheWrite).toBe(0)
      expect(usage.perProvider['claude']!.cacheReadTokens).toBe(1_000_000)
    })

    it('correctly prices cache-write tokens at 125% of input rate', async () => {
      const middleware = new CostTrackingMiddleware({ maxBudgetCents: 10000 })

      // Claude cache-write: 375/1M (1.25× the 300/1M input rate)
      // 1_000_000 cache-write tokens at 375/1M = 375 cents
      // 0 uncached input, 0 output
      const events: AgentEvent[] = [
        makeCompletedEvent('claude', { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 1_000_000 }),
      ]

      await collectAll(middleware.wrap(yieldEvents(events)))

      const usage = middleware.getUsage()
      expect(usage.totalCostCents).toBe(375)
      expect(usage.totalTokens.cacheWrite).toBe(1_000_000)
      expect(usage.perProvider['claude']!.cacheWriteTokens).toBe(1_000_000)
    })

    it('combines uncached input + cache-read + cache-write + output costs', async () => {
      const middleware = new CostTrackingMiddleware({ maxBudgetCents: 100000 })

      // Claude rates: input 300/1M, output 1500/1M, cacheRead 30/1M, cacheWrite 375/1M
      // 100k uncached input  → 30 cents
      // 100k cache-read      → 3 cents
      // 100k cache-write     → 37.5 cents
      // 100k output          → 150 cents
      // Note: estimator subtracts cache totals from inputTokens, so we set
      // inputTokens = uncached + cacheRead + cacheWrite = 300_000.
      const events: AgentEvent[] = [
        makeCompletedEvent('claude', {
          inputTokens: 300_000,
          outputTokens: 100_000,
          cachedInputTokens: 100_000,
          cacheWriteTokens: 100_000,
        }),
      ]

      await collectAll(middleware.wrap(yieldEvents(events)))

      const usage = middleware.getUsage()
      expect(usage.totalCostCents).toBeCloseTo(30 + 3 + 37.5 + 150, 5)
      expect(usage.perProvider['claude']!.cacheReadTokens).toBe(100_000)
      expect(usage.perProvider['claude']!.cacheWriteTokens).toBe(100_000)
    })

    it('does not add cache cost when zero cache tokens present', async () => {
      const middleware = new CostTrackingMiddleware({ maxBudgetCents: 100000 })

      // Pure 100k input + 100k output, no cache tokens.
      const events: AgentEvent[] = [
        makeCompletedEvent('claude', {
          inputTokens: 100_000,
          outputTokens: 100_000,
        }),
      ]

      await collectAll(middleware.wrap(yieldEvents(events)))

      const usage = middleware.getUsage()
      // 30 input + 150 output = 180; nothing extra from cache.
      expect(usage.totalCostCents).toBeCloseTo(180, 5)
      expect(usage.totalTokens.cacheRead).toBe(0)
      expect(usage.totalTokens.cacheWrite).toBe(0)
    })

    it('estimates cost correctly for different providers', async () => {
      const middleware = new CostTrackingMiddleware({ maxBudgetCents: 100000 })

      const events: AgentEvent[] = [
        // Gemini: input 125/1M, output 500/1M
        makeCompletedEvent('gemini', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      ]

      await collectAll(middleware.wrap(yieldEvents(events)))

      const usage = middleware.getUsage()
      // 10 + 40 = 50 cents (Gemini Flash 2.0 rates: 10/1M input, 40/1M output)
      expect(usage.totalCostCents).toBe(50)
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
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        invocations: 2,
      })
      expect(usage.perProvider['gemini']).toEqual({
        costCents: 3,
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        invocations: 1,
      })
    })

    it('returns empty report when no events processed', () => {
      const middleware = new CostTrackingMiddleware({})
      const usage = middleware.getUsage()
      expect(usage.totalCostCents).toBe(0)
      expect(usage.totalTokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
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
