import { describe, it, expect, beforeEach } from 'vitest'
import type { BaseStore } from '@langchain/langgraph'
import {
  StrategySelector,
  type FixStrategy,
  type StrategySelectorConfig,
} from '../self-correction/strategy-selector.js'

// ---------------------------------------------------------------------------
// In-memory BaseStore mock
// ---------------------------------------------------------------------------

function createMemoryStore(): BaseStore {
  const data = new Map<string, Map<string, { key: string; value: Record<string, unknown> }>>()

  function nsKey(namespace: string[]): string {
    return namespace.join('/')
  }

  return {
    async get(namespace: string[], key: string) {
      const ns = data.get(nsKey(namespace))
      return ns?.get(key) ?? null
    },
    async put(namespace: string[], key: string, value: Record<string, unknown>) {
      const k = nsKey(namespace)
      if (!data.has(k)) data.set(k, new Map())
      data.get(k)!.set(key, { key, value })
    },
    async delete(namespace: string[], key: string) {
      const ns = data.get(nsKey(namespace))
      if (ns) ns.delete(key)
    },
    async search(namespace: string[], _options?: { limit?: number }) {
      const ns = data.get(nsKey(namespace))
      if (!ns) return []
      return Array.from(ns.values())
    },
    async batch(_ops: unknown[]) { return [] },
    async list(_prefix: string[]) { return [] },
    async start() { /* noop */ },
    async stop() { /* noop */ },
  } as unknown as BaseStore
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function recordMany(
  selector: StrategySelector,
  nodeId: string,
  errorType: string,
  strategy: FixStrategy,
  successes: number,
  failures: number,
): Promise<void> {
  for (let i = 0; i < successes; i++) {
    await selector.recordOutcome({ errorType, nodeId, strategy, success: true })
  }
  for (let i = 0; i < failures; i++) {
    await selector.recordOutcome({ errorType, nodeId, strategy, success: false })
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StrategySelector', () => {
  let store: BaseStore
  let selector: StrategySelector

  beforeEach(() => {
    store = createMemoryStore()
    selector = new StrategySelector({ store })
  })

  // ---- Default recommendation (no history) --------------------------------

  it('returns default recommendation with no history', async () => {
    const rec = await selector.recommend({
      errorType: 'import_error',
      nodeId: 'gen_frontend',
    })

    expect(rec.strategy).toBe('targeted')
    expect(rec.confidence).toBe(0.3)
    expect(rec.reasoning).toContain('Insufficient historical data')
    expect(rec.escalateModel).toBe(false)
    expect(rec.suggestedMaxAttempts).toBe(3)
    expect(rec.historicalRates.targeted.attempts).toBe(0)
    expect(rec.historicalRates.contextual.attempts).toBe(0)
    expect(rec.historicalRates.regenerative.attempts).toBe(0)
  })

  // ---- Skip targeted (low success rate) -----------------------------------

  it('skips targeted when its success rate is below skipThreshold', async () => {
    // targeted: 1/5 = 20% success (at the threshold, not below — use 0/5)
    await recordMany(selector, 'gen_frontend', 'import_error', 'targeted', 0, 5)
    // contextual: 4/5 = 80% success
    await recordMany(selector, 'gen_frontend', 'import_error', 'contextual', 4, 1)

    const rec = await selector.recommend({
      errorType: 'import_error',
      nodeId: 'gen_frontend',
    })

    expect(rec.strategy).toBe('contextual')
    expect(rec.reasoning).toContain('Skipping targeted')
    expect(rec.historicalRates.targeted.rate).toBeCloseTo(0)
    expect(rec.historicalRates.contextual.rate).toBeCloseTo(0.8)
  })

  // ---- Skip to regenerative (both targeted+contextual low) ----------------

  it('skips to regenerative when targeted and contextual both have low rates', async () => {
    // targeted: 0/5 = 0%
    await recordMany(selector, 'gen_backend', 'type_error', 'targeted', 0, 5)
    // contextual: 0/4 = 0%
    await recordMany(selector, 'gen_backend', 'type_error', 'contextual', 0, 4)
    // regenerative: 3/4 = 75%
    await recordMany(selector, 'gen_backend', 'type_error', 'regenerative', 3, 1)

    const rec = await selector.recommend({
      errorType: 'type_error',
      nodeId: 'gen_backend',
    })

    expect(rec.strategy).toBe('regenerative')
    expect(rec.reasoning).toContain('Skipping targeted')
    expect(rec.reasoning).toContain('Skipping contextual')
    expect(rec.escalateModel).toBe(true)
  })

  // ---- Recommend based on high success rate --------------------------------

  it('recommends targeted when it has a high success rate', async () => {
    // targeted: 4/5 = 80%
    await recordMany(selector, 'gen_frontend', 'syntax_error', 'targeted', 4, 1)

    const rec = await selector.recommend({
      errorType: 'syntax_error',
      nodeId: 'gen_frontend',
    })

    expect(rec.strategy).toBe('targeted')
    expect(rec.historicalRates.targeted.rate).toBeCloseTo(0.8)
    expect(rec.escalateModel).toBe(false)
  })

  // ---- Record outcome and retrieve rates ----------------------------------

  it('records outcomes and retrieves correct rates', async () => {
    await selector.recordOutcome({
      errorType: 'import_error',
      nodeId: 'gen_frontend',
      strategy: 'targeted',
      success: true,
    })
    await selector.recordOutcome({
      errorType: 'import_error',
      nodeId: 'gen_frontend',
      strategy: 'targeted',
      success: false,
    })
    await selector.recordOutcome({
      errorType: 'import_error',
      nodeId: 'gen_frontend',
      strategy: 'contextual',
      success: true,
    })

    const rates = await selector.getHistoricalRates('gen_frontend', 'import_error')

    expect(rates.targeted.attempts).toBe(2)
    expect(rates.targeted.successes).toBe(1)
    expect(rates.targeted.rate).toBeCloseTo(0.5)
    expect(rates.contextual.attempts).toBe(1)
    expect(rates.contextual.successes).toBe(1)
    expect(rates.contextual.rate).toBeCloseTo(1.0)
    expect(rates.regenerative.attempts).toBe(0)
    expect(rates.regenerative.rate).toBe(0)
  })

  // ---- Min data points threshold ------------------------------------------

  it('defaults to targeted when data points are below minDataPoints', async () => {
    // Only 2 records (default minDataPoints is 3)
    await selector.recordOutcome({
      errorType: 'ref_error',
      nodeId: 'gen_tests',
      strategy: 'targeted',
      success: false,
    })
    await selector.recordOutcome({
      errorType: 'ref_error',
      nodeId: 'gen_tests',
      strategy: 'targeted',
      success: false,
    })

    const rec = await selector.recommend({
      errorType: 'ref_error',
      nodeId: 'gen_tests',
    })

    expect(rec.strategy).toBe('targeted')
    expect(rec.confidence).toBe(0.3)
    expect(rec.reasoning).toContain('Insufficient historical data')
  })

  // ---- Custom thresholds --------------------------------------------------

  it('respects custom skipThreshold and recommendThreshold', async () => {
    const customSelector = new StrategySelector({
      store,
      skipThreshold: 0.5, // higher skip threshold
      recommendThreshold: 0.8,
      minDataPoints: 2,
    })

    // targeted: 2/4 = 50% — exactly at threshold (not below), so not skipped
    await recordMany(customSelector, 'node1', 'err1', 'targeted', 2, 2)

    let rec = await customSelector.recommend({ errorType: 'err1', nodeId: 'node1' })
    expect(rec.strategy).toBe('targeted')

    // targeted: 1/4 = 25% — below 50% threshold, should skip
    const customSelector2 = new StrategySelector({
      store: createMemoryStore(),
      skipThreshold: 0.5,
      recommendThreshold: 0.8,
      minDataPoints: 2,
    })
    await recordMany(customSelector2, 'node2', 'err2', 'targeted', 1, 3)
    await recordMany(customSelector2, 'node2', 'err2', 'contextual', 3, 1)

    rec = await customSelector2.recommend({ errorType: 'err2', nodeId: 'node2' })
    expect(rec.strategy).toBe('contextual')
  })

  // ---- Model escalation recommendation -----------------------------------

  it('recommends model escalation when strategy is regenerative', async () => {
    await recordMany(selector, 'gen_db', 'schema_error', 'targeted', 0, 5)
    await recordMany(selector, 'gen_db', 'schema_error', 'contextual', 0, 5)
    await recordMany(selector, 'gen_db', 'schema_error', 'regenerative', 4, 1)

    const rec = await selector.recommend({
      errorType: 'schema_error',
      nodeId: 'gen_db',
    })

    expect(rec.strategy).toBe('regenerative')
    expect(rec.escalateModel).toBe(true)
  })

  it('does not recommend model escalation for targeted or contextual', async () => {
    await recordMany(selector, 'gen_db', 'minor_error', 'targeted', 4, 1)

    const rec = await selector.recommend({
      errorType: 'minor_error',
      nodeId: 'gen_db',
    })

    expect(rec.strategy).toBe('targeted')
    expect(rec.escalateModel).toBe(false)
  })

  // ---- Suggested max attempts ---------------------------------------------

  it('suggests fewer attempts when overall success rate is high', async () => {
    // All strategies have high success rates
    await recordMany(selector, 'node_a', 'err_a', 'targeted', 5, 0)
    await recordMany(selector, 'node_a', 'err_a', 'contextual', 5, 0)

    const rec = await selector.recommend({ errorType: 'err_a', nodeId: 'node_a' })

    // 10/10 = 100% overall → should suggest 2
    expect(rec.suggestedMaxAttempts).toBe(2)
  })

  it('suggests more attempts when overall success rate is low', async () => {
    // All strategies have low success rates
    await recordMany(selector, 'node_b', 'err_b', 'targeted', 0, 5)
    await recordMany(selector, 'node_b', 'err_b', 'contextual', 0, 5)

    const rec = await selector.recommend({ errorType: 'err_b', nodeId: 'node_b' })

    // 0/10 = 0% overall → should suggest 5
    expect(rec.suggestedMaxAttempts).toBe(5)
  })

  // ---- Historical rates with no errorType ---------------------------------

  it('returns empty rates when getHistoricalRates is called without errorType', async () => {
    await selector.recordOutcome({
      errorType: 'import_error',
      nodeId: 'gen_frontend',
      strategy: 'targeted',
      success: true,
    })

    // Without errorType, cannot enumerate — returns zeros
    const rates = await selector.getHistoricalRates('gen_frontend')

    expect(rates.targeted.attempts).toBe(0)
    expect(rates.contextual.attempts).toBe(0)
    expect(rates.regenerative.attempts).toBe(0)
  })

  // ---- Custom namespace ---------------------------------------------------

  it('uses custom namespace for isolation', async () => {
    const selectorA = new StrategySelector({
      store,
      namespace: ['project-a', 'strategies'],
    })
    const selectorB = new StrategySelector({
      store,
      namespace: ['project-b', 'strategies'],
    })

    await recordMany(selectorA, 'node1', 'err1', 'targeted', 5, 0)
    await recordMany(selectorB, 'node1', 'err1', 'targeted', 0, 5)

    const ratesA = await selectorA.getHistoricalRates('node1', 'err1')
    const ratesB = await selectorB.getHistoricalRates('node1', 'err1')

    expect(ratesA.targeted.rate).toBeCloseTo(1.0)
    expect(ratesB.targeted.rate).toBeCloseTo(0.0)
  })

  // ---- Regenerative directly recommended via superiority -------------------

  it('recommends regenerative directly when it is significantly better than targeted', async () => {
    // targeted: 3/5 = 60% (not below skipThreshold, so wouldn't normally be skipped)
    await recordMany(selector, 'node_x', 'err_x', 'targeted', 3, 2)
    // regenerative: 5/5 = 100% and > recommendThreshold and significantly better
    await recordMany(selector, 'node_x', 'err_x', 'regenerative', 5, 0)

    const rec = await selector.recommend({ errorType: 'err_x', nodeId: 'node_x' })

    // regenerative (100%) is 40% better than targeted (60%), exceeds the +20% gap
    expect(rec.strategy).toBe('regenerative')
    expect(rec.escalateModel).toBe(true)
  })

  // ---- Confidence increases with more data --------------------------------

  it('has higher confidence with more data points', async () => {
    const selectorFew = new StrategySelector({ store: createMemoryStore() })
    const selectorMany = new StrategySelector({ store: createMemoryStore() })

    // Few data points
    await recordMany(selectorFew, 'n', 'e', 'targeted', 2, 1)

    // Many data points
    await recordMany(selectorMany, 'n', 'e', 'targeted', 10, 5)
    await recordMany(selectorMany, 'n', 'e', 'contextual', 3, 2)

    const recFew = await selectorFew.recommend({ errorType: 'e', nodeId: 'n' })
    const recMany = await selectorMany.recommend({ errorType: 'e', nodeId: 'n' })

    expect(recMany.confidence).toBeGreaterThan(recFew.confidence)
  })
})
