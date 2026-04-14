import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import { CostOptimizationEngine } from '../middleware/cost-optimization.js'
import type {
  ProviderPerformanceRecord,
  CostOptimizationConfig,
} from '../middleware/cost-optimization.js'
import type {
  AdapterProviderId,
  TaskDescriptor,
} from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectBusEvents(bus: DzupEventBus): DzupEvent[] {
  const events: DzupEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

function makeRecord(
  providerId: AdapterProviderId,
  tags: string[],
  quality: number,
  cost: number,
  duration = 100,
  timestamp = Date.now(),
): ProviderPerformanceRecord {
  return {
    providerId,
    taskTags: tags,
    qualityScore: quality,
    costCents: cost,
    durationMs: duration,
    timestamp,
  }
}

function makeTask(tags: string[], overrides?: Partial<TaskDescriptor>): TaskDescriptor {
  return {
    prompt: 'test',
    tags,
    ...overrides,
  }
}

function seedEngine(
  engine: CostOptimizationEngine,
  providerId: AdapterProviderId,
  tags: string[],
  count: number,
  quality: number,
  cost: number,
): void {
  const now = Date.now()
  for (let i = 0; i < count; i++) {
    engine.recordObservation(makeRecord(providerId, tags, quality, cost, 100, now + i))
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CostOptimizationEngine', () => {
  let engine: CostOptimizationEngine
  let bus: DzupEventBus

  beforeEach(() => {
    bus = createEventBus()
    engine = new CostOptimizationEngine({
      minSampleSize: 5,
      minQualityThreshold: 0.7,
      maxQualityDegradation: 0.1,
      decayFactor: 0.95,
      eventBus: bus,
    })
  })

  describe('recordObservation', () => {
    it('records and retrieves observations', () => {
      seedEngine(engine, 'claude', ['coding'], 3, 0.9, 10)

      const stats = engine.getStats('claude', ['coding'])
      expect(stats).toBeDefined()
      expect(stats!.sampleCount).toBe(3)
      expect(stats!.providerId).toBe('claude')
    })
  })

  describe('getStats', () => {
    it('returns aggregated data', () => {
      seedEngine(engine, 'claude', ['coding'], 5, 0.9, 10)

      const stats = engine.getStats('claude', ['coding'])
      expect(stats).toBeDefined()
      expect(stats!.sampleCount).toBe(5)
      expect(stats!.avgQuality).toBeCloseTo(0.9, 1)
      expect(stats!.avgCostCents).toBeCloseTo(10, 1)
      expect(stats!.efficiency).toBeGreaterThan(0)
    })

    it('returns undefined for unknown provider', () => {
      expect(engine.getStats('claude')).toBeUndefined()
    })

    it('returns stats without tag filter', () => {
      seedEngine(engine, 'claude', ['coding'], 5, 0.9, 10)
      // Without tags, it will look for empty tag key, which won't exactly match,
      // but Jaccard similarity with empty set should include records with sim > 0.3
      // Actually empty vs non-empty => jaccard = 0, so it returns undefined
      const stats = engine.getStats('claude')
      // Tags ['coding'] vs [] => intersection=0, union=1 => jaccard=0 < 0.3
      expect(stats).toBeUndefined()
    })
  })

  describe('exponential decay', () => {
    it('weights recent data more', () => {
      const now = Date.now()

      // Older observations with low quality
      for (let i = 0; i < 5; i++) {
        engine.recordObservation(makeRecord('claude', ['test'], 0.5, 10, 100, now + i))
      }
      // Newer observations with high quality
      for (let i = 0; i < 5; i++) {
        engine.recordObservation(makeRecord('claude', ['test'], 1.0, 10, 100, now + 100 + i))
      }

      const stats = engine.getStats('claude', ['test'])
      expect(stats).toBeDefined()
      // With decay, recent high-quality observations should pull average above 0.75
      expect(stats!.avgQuality).toBeGreaterThan(0.75)
    })
  })

  describe('recommend', () => {
    it('picks cheaper provider when quality is similar', () => {
      // Claude: high quality, high cost
      seedEngine(engine, 'claude', ['coding'], 10, 0.9, 20)
      // Crush: slightly lower quality, much cheaper
      seedEngine(engine, 'crush', ['coding'], 10, 0.85, 3)

      const decision = engine.recommend(makeTask(['coding']), ['claude', 'crush'])

      expect(decision).toBeDefined()
      expect(decision!.recommendedProvider).toBe('crush')
      expect(decision!.originalProvider).toBe('claude')
      expect(decision!.estimatedSavingsPercent).toBeGreaterThan(0)
    })

    it('returns undefined when insufficient samples', () => {
      seedEngine(engine, 'claude', ['coding'], 2, 0.9, 20)
      seedEngine(engine, 'crush', ['coding'], 2, 0.85, 3)

      const decision = engine.recommend(makeTask(['coding']), ['claude', 'crush'])
      expect(decision).toBeUndefined()
    })

    it('will not pick provider with quality below threshold', () => {
      seedEngine(engine, 'claude', ['coding'], 10, 0.9, 20)
      // Crush has quality below threshold (0.7)
      seedEngine(engine, 'crush', ['coding'], 10, 0.5, 3)

      const decision = engine.recommend(makeTask(['coding']), ['claude', 'crush'])
      expect(decision).toBeUndefined()
    })

    it('returns undefined when quality degradation exceeds max', () => {
      seedEngine(engine, 'claude', ['coding'], 10, 0.95, 20)
      // Quality drop of 0.2 exceeds maxQualityDegradation of 0.1
      seedEngine(engine, 'crush', ['coding'], 10, 0.75, 3)

      const decision = engine.recommend(makeTask(['coding']), ['claude', 'crush'])
      expect(decision).toBeUndefined()
    })

    it('returns undefined with only one provider', () => {
      seedEngine(engine, 'claude', ['coding'], 10, 0.9, 20)

      const decision = engine.recommend(makeTask(['coding']), ['claude'])
      expect(decision).toBeUndefined()
    })
  })

  describe('route', () => {
    it('integrates with TaskRoutingStrategy interface', () => {
      seedEngine(engine, 'claude', ['coding'], 10, 0.9, 20)
      seedEngine(engine, 'crush', ['coding'], 10, 0.85, 3)

      const decision = engine.route(makeTask(['coding']), ['claude', 'crush'])

      expect(decision.provider).toBe('crush')
      expect(decision.reason).toContain('savings')
      expect(decision.confidence).toBeGreaterThan(0)
      expect(decision.fallbackProviders).toContain('claude')
    })

    it('respects preferredProvider', () => {
      seedEngine(engine, 'claude', ['coding'], 10, 0.9, 20)
      seedEngine(engine, 'crush', ['coding'], 10, 0.85, 3)

      const decision = engine.route(
        makeTask(['coding'], { preferredProvider: 'claude' }),
        ['claude', 'crush'],
      )

      expect(decision.provider).toBe('claude')
      expect(decision.reason).toContain('Preferred')
      expect(decision.confidence).toBe(0.95)
    })

    it('falls back to priority when insufficient data', () => {
      const decision = engine.route(makeTask(['coding']), ['claude', 'codex', 'crush'])

      expect(decision.provider).toBe('claude') // highest priority
      expect(decision.reason).toContain('Insufficient')
      expect(decision.confidence).toBe(0.5)
      expect(decision.fallbackProviders).toEqual(['codex', 'crush'])
    })

    it('handles empty provider list', () => {
      const decision = engine.route(makeTask(['coding']), [])

      expect(decision.provider).toBe('auto')
      expect(decision.confidence).toBe(0)
    })
  })

  describe('reset', () => {
    it('clears all data', () => {
      seedEngine(engine, 'claude', ['coding'], 5, 0.9, 10)
      expect(engine.getStats('claude', ['coding'])).toBeDefined()

      engine.reset()

      expect(engine.getStats('claude', ['coding'])).toBeUndefined()
      expect(engine.getAllStats()).toEqual([])
    })
  })

  describe('Jaccard tag similarity', () => {
    it('uses similar tag sets when exact match has insufficient samples', () => {
      // Record observations for ['coding', 'typescript']
      seedEngine(engine, 'claude', ['coding', 'typescript'], 10, 0.9, 15)

      // Query with ['coding', 'javascript'] -- shares 'coding'
      // Jaccard = 1/3 = 0.33 > 0.3 threshold
      const stats = engine.getStats('claude', ['coding', 'javascript'])
      expect(stats).toBeDefined()
      expect(stats!.sampleCount).toBe(10)
    })

    it('does not use dissimilar tag sets', () => {
      seedEngine(engine, 'claude', ['coding', 'typescript'], 10, 0.9, 15)

      // Query with completely different tags
      // Jaccard = 0/4 = 0 < 0.3
      const stats = engine.getStats('claude', ['design', 'review'])
      expect(stats).toBeUndefined()
    })
  })

  describe('getAllStats', () => {
    it('returns stats for all providers', () => {
      seedEngine(engine, 'claude', ['coding'], 5, 0.9, 10)
      seedEngine(engine, 'codex', ['coding'], 5, 0.8, 8)

      const allStats = engine.getAllStats(['coding'])
      expect(allStats).toHaveLength(2)
      expect(allStats.map((s) => s.providerId).sort()).toEqual(['claude', 'codex'])
    })
  })

  describe('name property', () => {
    it('has the expected strategy name', () => {
      expect(engine.name).toBe('cost-optimized-adaptive')
    })
  })
})
