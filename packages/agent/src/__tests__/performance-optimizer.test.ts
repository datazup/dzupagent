import { describe, it, expect, beforeEach } from 'vitest'
import type { BaseStore } from '@langchain/langgraph'
import {
  AgentPerformanceOptimizer,
  type ModelTier,
} from '../self-correction/performance-optimizer.js'

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Record N executions for a node with given params. */
function recordMany(
  optimizer: AgentPerformanceOptimizer,
  count: number,
  overrides: Partial<{
    nodeId: string
    qualityScore: number
    costCents: number
    durationMs: number
    hadError: boolean
    modelTier: ModelTier
    reflectionDepth: number
  }> = {},
): void {
  for (let i = 0; i < count; i++) {
    optimizer.recordExecution({
      nodeId: overrides.nodeId ?? 'node_a',
      qualityScore: overrides.qualityScore ?? 0.8,
      costCents: overrides.costCents ?? 50,
      durationMs: overrides.durationMs ?? 2000,
      hadError: overrides.hadError ?? false,
      modelTier: overrides.modelTier ?? 'balanced',
      reflectionDepth: overrides.reflectionDepth ?? 1,
    })
  }
}

/**
 * Minimal in-memory BaseStore for persistence tests.
 * Implements only get/put which is all the optimizer uses.
 */
function createMockStore() {
  const data = new Map<string, Map<string, { value: Record<string, unknown> }>>()

  return {
    data,
    async get(namespace: string[], key: string) {
      const nsKey = namespace.join(':')
      return data.get(nsKey)?.get(key) ?? null
    },
    async put(namespace: string[], key: string, value: Record<string, unknown>) {
      const nsKey = namespace.join(':')
      if (!data.has(nsKey)) data.set(nsKey, new Map())
      data.get(nsKey)!.set(key, { value })
    },
    async delete(namespace: string[], key: string) {
      const nsKey = namespace.join(':')
      data.get(nsKey)?.delete(key)
    },
    async search() {
      return []
    },
    async batch() {
      return []
    },
    async start() {
      /* noop */
    },
    async stop() {
      /* noop */
    },
  } as unknown as BaseStore
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('AgentPerformanceOptimizer', () => {
  let optimizer: AgentPerformanceOptimizer

  beforeEach(() => {
    optimizer = new AgentPerformanceOptimizer()
  })

  /* ---------- Default config -------------------------------------- */

  describe('default config', () => {
    it('returns default decision with no history', () => {
      const decision = optimizer.getRecommendation('unknown')
      expect(decision.nodeId).toBe('unknown')
      expect(decision.modelTier).toBe('balanced')
      expect(decision.reflectionDepth).toBe(1)
      expect(decision.tokenBudgetMultiplier).toBe(1.0)
      expect(decision.qualityThreshold).toBe(0.5)
      expect(decision.confidence).toBe(0)
      expect(decision.reasoning).toContain('No execution history')
    })
  })

  /* ---------- Model downgrade ------------------------------------ */

  describe('model downgrade recommendation', () => {
    it('recommends downgrade when quality is high and cost exceeds threshold', () => {
      // High quality (>0.85), high cost (>100c), currently powerful
      recordMany(optimizer, 20, {
        qualityScore: 0.95,
        costCents: 150,
        modelTier: 'powerful',
      })

      const decision = optimizer.getRecommendation('node_a')
      expect(decision.modelTier).toBe('balanced')
      expect(decision.reasoning).toContain('downgrade')
    })

    it('does not downgrade from fast (already cheapest)', () => {
      recordMany(optimizer, 20, {
        qualityScore: 0.95,
        costCents: 150,
        modelTier: 'fast',
      })

      const decision = optimizer.getRecommendation('node_a')
      // fast cannot be downgraded
      expect(decision.modelTier).toBe('fast')
    })
  })

  /* ---------- Model upgrade -------------------------------------- */

  describe('model upgrade recommendation', () => {
    it('recommends upgrade when quality is below threshold', () => {
      recordMany(optimizer, 20, {
        qualityScore: 0.4,
        costCents: 10,
        modelTier: 'fast',
      })

      const decision = optimizer.getRecommendation('node_a')
      expect(decision.modelTier).toBe('balanced')
      expect(decision.reasoning).toContain('upgrade')
    })

    it('upgrades balanced to powerful on low quality', () => {
      recordMany(optimizer, 20, {
        qualityScore: 0.5,
        costCents: 50,
        modelTier: 'balanced',
      })

      const decision = optimizer.getRecommendation('node_a')
      expect(decision.modelTier).toBe('powerful')
    })

    it('does not upgrade from powerful (already highest)', () => {
      recordMany(optimizer, 20, {
        qualityScore: 0.5,
        costCents: 50,
        modelTier: 'powerful',
      })

      const decision = optimizer.getRecommendation('node_a')
      expect(decision.modelTier).toBe('powerful')
    })
  })

  /* ---------- No change ------------------------------------------ */

  describe('no change recommendation', () => {
    it('keeps current settings when performance is normal', () => {
      // reflectionDepth=0 so low error rate does not trigger decrease,
      // error rate ~15% so neither increase nor decrease triggers,
      // quality 0.75 is between thresholds, cost is moderate
      recordMany(optimizer, 17, {
        qualityScore: 0.75,
        costCents: 50,
        modelTier: 'balanced',
        reflectionDepth: 0,
        hadError: false,
      })
      recordMany(optimizer, 3, {
        qualityScore: 0.75,
        costCents: 50,
        modelTier: 'balanced',
        reflectionDepth: 0,
        hadError: true,
      })

      const decision = optimizer.getRecommendation('node_a')
      expect(decision.modelTier).toBe('balanced')
      expect(decision.reasoning).toContain('no changes recommended')
    })
  })

  /* ---------- Reflection increase -------------------------------- */

  describe('reflection increase on high error rate', () => {
    it('increases reflection depth when error rate exceeds threshold', () => {
      // 8 out of 20 are errors = 40% > 30% threshold
      recordMany(optimizer, 12, {
        qualityScore: 0.75,
        costCents: 50,
        hadError: false,
        reflectionDepth: 1,
      })
      recordMany(optimizer, 8, {
        qualityScore: 0.75,
        costCents: 50,
        hadError: true,
        reflectionDepth: 1,
      })

      const decision = optimizer.getRecommendation('node_a')
      expect(decision.reflectionDepth).toBe(2)
      expect(decision.reasoning).toContain('increase reflection')
    })

    it('caps reflection depth at 5', () => {
      // All errors, currently at depth 5
      recordMany(optimizer, 20, {
        qualityScore: 0.75,
        costCents: 50,
        hadError: true,
        reflectionDepth: 5,
      })

      const decision = optimizer.getRecommendation('node_a')
      expect(decision.reflectionDepth).toBe(5)
    })
  })

  /* ---------- Reflection decrease -------------------------------- */

  describe('reflection decrease on low error rate', () => {
    it('decreases reflection depth when error rate is below 10%', () => {
      // 1 out of 20 errors = 5% < 10%
      recordMany(optimizer, 19, {
        qualityScore: 0.75,
        costCents: 50,
        hadError: false,
        reflectionDepth: 3,
      })
      recordMany(optimizer, 1, {
        qualityScore: 0.75,
        costCents: 50,
        hadError: true,
        reflectionDepth: 3,
      })

      const decision = optimizer.getRecommendation('node_a')
      expect(decision.reflectionDepth).toBe(2)
      expect(decision.reasoning).toContain('decrease reflection')
    })

    it('does not decrease below 0', () => {
      recordMany(optimizer, 20, {
        qualityScore: 0.75,
        costCents: 50,
        hadError: false,
        reflectionDepth: 0,
      })

      const decision = optimizer.getRecommendation('node_a')
      expect(decision.reflectionDepth).toBe(0)
    })
  })

  /* ---------- Token budget adjustment ----------------------------- */

  describe('token budget adjustment', () => {
    it('returns 1.0 multiplier for normal usage', () => {
      recordMany(optimizer, 20, {
        qualityScore: 0.75,
        costCents: 50,
      })

      const decision = optimizer.getRecommendation('node_a')
      expect(decision.tokenBudgetMultiplier).toBe(1.0)
    })

    it('returns < 1.0 when recent costs are much lower than average', () => {
      // First 15 records with high cost, then 5 with very low cost
      recordMany(optimizer, 15, {
        qualityScore: 0.75,
        costCents: 100,
      })
      recordMany(optimizer, 5, {
        qualityScore: 0.75,
        costCents: 5,
      })

      const decision = optimizer.getRecommendation('node_a')
      expect(decision.tokenBudgetMultiplier).toBeLessThan(1.0)
    })
  })

  /* ---------- Quality threshold ---------------------------------- */

  describe('quality threshold calculation', () => {
    it('sets threshold to 95% of average quality', () => {
      recordMany(optimizer, 20, {
        qualityScore: 0.8,
        costCents: 50,
      })

      const decision = optimizer.getRecommendation('node_a')
      expect(decision.qualityThreshold).toBeCloseTo(0.8 * 0.95, 5)
    })

    it('uses 0.5 default when avg quality is 0', () => {
      recordMany(optimizer, 20, {
        qualityScore: 0,
        costCents: 50,
      })

      const decision = optimizer.getRecommendation('node_a')
      expect(decision.qualityThreshold).toBe(0.5)
    })
  })

  /* ---------- Confidence ----------------------------------------- */

  describe('confidence increases with more data', () => {
    it('has low confidence with few data points', () => {
      recordMany(optimizer, 5)
      const decision = optimizer.getRecommendation('node_a')
      expect(decision.confidence).toBe(5 / 20)
    })

    it('has full confidence at historyWindow size', () => {
      recordMany(optimizer, 20)
      const decision = optimizer.getRecommendation('node_a')
      expect(decision.confidence).toBe(1.0)
    })

    it('caps confidence at 1.0 even with more data', () => {
      recordMany(optimizer, 30) // window is 20, so older ones get trimmed
      const decision = optimizer.getRecommendation('node_a')
      expect(decision.confidence).toBe(1.0)
    })
  })

  /* ---------- History tracking ----------------------------------- */

  describe('history tracking', () => {
    it('returns empty history for unknown node', () => {
      const history = optimizer.getHistory('unknown')
      expect(history.nodeId).toBe('unknown')
      expect(history.qualityScores).toEqual([])
      expect(history.costs).toEqual([])
      expect(history.durations).toEqual([])
      expect(history.errorCount).toBe(0)
      expect(history.totalRuns).toBe(0)
    })

    it('tracks recorded executions', () => {
      optimizer.recordExecution({
        nodeId: 'n1',
        qualityScore: 0.9,
        costCents: 42,
        durationMs: 1500,
        hadError: false,
        modelTier: 'balanced',
        reflectionDepth: 1,
      })
      optimizer.recordExecution({
        nodeId: 'n1',
        qualityScore: 0.7,
        costCents: 55,
        durationMs: 2500,
        hadError: true,
        modelTier: 'balanced',
        reflectionDepth: 1,
      })

      const history = optimizer.getHistory('n1')
      expect(history.totalRuns).toBe(2)
      expect(history.qualityScores).toEqual([0.9, 0.7])
      expect(history.costs).toEqual([42, 55])
      expect(history.durations).toEqual([1500, 2500])
      expect(history.errorCount).toBe(1)
    })

    it('respects sliding window', () => {
      const small = new AgentPerformanceOptimizer({ historyWindow: 3 })
      recordMany(small, 5, { nodeId: 'x' })
      const history = small.getHistory('x')
      expect(history.totalRuns).toBe(3)
    })
  })

  /* ---------- getAllRecommendations ------------------------------ */

  describe('getAllRecommendations', () => {
    it('returns recommendations for all tracked nodes', () => {
      recordMany(optimizer, 5, { nodeId: 'a' })
      recordMany(optimizer, 5, { nodeId: 'b' })
      recordMany(optimizer, 5, { nodeId: 'c' })

      const all = optimizer.getAllRecommendations()
      expect(all.size).toBe(3)
      expect(all.has('a')).toBe(true)
      expect(all.has('b')).toBe(true)
      expect(all.has('c')).toBe(true)
    })

    it('returns empty map when no data', () => {
      const all = optimizer.getAllRecommendations()
      expect(all.size).toBe(0)
    })
  })

  /* ---------- Reset ---------------------------------------------- */

  describe('reset', () => {
    it('clears all data', () => {
      recordMany(optimizer, 10, { nodeId: 'a' })
      recordMany(optimizer, 10, { nodeId: 'b' })

      optimizer.reset()

      expect(optimizer.getHistory('a').totalRuns).toBe(0)
      expect(optimizer.getHistory('b').totalRuns).toBe(0)
      expect(optimizer.getAllRecommendations().size).toBe(0)
    })
  })

  /* ---------- Persist and load roundtrip ------------------------- */

  describe('persist and load', () => {
    it('roundtrips state through BaseStore', async () => {
      const store = createMockStore()
      const opt1 = new AgentPerformanceOptimizer({ store })

      // Record some executions
      opt1.recordExecution({
        nodeId: 'gen_backend',
        qualityScore: 0.88,
        costCents: 75,
        durationMs: 3000,
        hadError: false,
        modelTier: 'powerful',
        reflectionDepth: 2,
      })
      opt1.recordExecution({
        nodeId: 'gen_backend',
        qualityScore: 0.91,
        costCents: 80,
        durationMs: 3200,
        hadError: false,
        modelTier: 'powerful',
        reflectionDepth: 2,
      })

      await opt1.persist()

      // Load into fresh instance
      const opt2 = new AgentPerformanceOptimizer({ store })
      await opt2.load()

      const history = opt2.getHistory('gen_backend')
      expect(history.totalRuns).toBe(2)
      expect(history.qualityScores).toEqual([0.88, 0.91])
      expect(history.costs).toEqual([75, 80])
    })

    it('persist is a no-op without store', async () => {
      recordMany(optimizer, 5)
      // Should not throw
      await optimizer.persist()
    })

    it('load is a no-op without store', async () => {
      // Should not throw
      await optimizer.load()
    })

    it('load handles missing data gracefully', async () => {
      const store = createMockStore()
      const opt = new AgentPerformanceOptimizer({ store })
      // No persist was done, store is empty
      await opt.load()
      expect(opt.getAllRecommendations().size).toBe(0)
    })
  })
})
