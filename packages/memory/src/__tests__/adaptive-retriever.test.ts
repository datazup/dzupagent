import { describe, it, expect, vi } from 'vitest'
import {
  AdaptiveRetriever,
  classifyIntent,
  DEFAULT_STRATEGIES,
  type RetrievalProviders,
  type QueryIntent,
  type RetrievalStrategy,
} from '../retrieval/adaptive-retriever.js'

// ─── Test data ───────────────────────────────────────────────────────────────

const RECORDS = [
  { key: 'rec-1', value: { text: 'The ModelRegistry handles provider fallback logic' } },
  { key: 'rec-2', value: { text: 'ForgeError was added in 2024-01 as the base error class' } },
  { key: 'rec-3', value: { text: 'How to configure the circuit breaker timeout' } },
  { key: 'rec-4', value: { text: 'The EventBus uses a typed pub/sub pattern' } },
  { key: 'rec-5', value: { text: 'Memory consolidation prevents duplicate entries' } },
]

function makeVectorProvider(results?: Array<{ key: string; score: number; value: Record<string, unknown> }>) {
  return {
    search: vi.fn().mockResolvedValue(
      results ?? [
        { key: 'rec-1', score: 0.95, value: RECORDS[0]!.value },
        { key: 'rec-3', score: 0.80, value: RECORDS[2]!.value },
      ],
    ),
  }
}

function makeFTSProvider(results?: Array<{ key: string; score: number; value: Record<string, unknown> }>) {
  return {
    search: vi.fn().mockReturnValue(
      results ?? [
        { key: 'rec-1', score: 0.7, value: RECORDS[0]!.value },
        { key: 'rec-4', score: 0.5, value: RECORDS[3]!.value },
      ],
    ),
  }
}

function makeGraphProvider(results?: Array<{ key: string; score: number; value: Record<string, unknown>; relationship: string }>) {
  return {
    search: vi.fn().mockReturnValue(
      results ?? [
        { key: 'rec-2', score: 0.9, value: RECORDS[1]!.value, relationship: 'shares entities: forgeerror' },
        { key: 'rec-1', score: 0.6, value: RECORDS[0]!.value, relationship: 'shares entities: modelregistry' },
      ],
    ),
  }
}

// ─── classifyIntent (standalone) ─────────────────────────────────────────────

describe('classifyIntent', () => {
  it('classifies temporal queries', () => {
    expect(classifyIntent('when was the circuit breaker added?')).toBe('temporal')
    expect(classifyIntent('what changed since last week?')).toBe('temporal')
    expect(classifyIntent('show recent updates')).toBe('temporal')
    expect(classifyIntent('events after 2024-03')).toBe('temporal')
  })

  it('classifies causal queries', () => {
    expect(classifyIntent('why did the build fail?')).toBe('causal')
    expect(classifyIntent('what caused the timeout?')).toBe('causal')
    expect(classifyIntent('root cause of the error')).toBe('causal')
  })

  it('classifies procedural queries', () => {
    expect(classifyIntent('how to configure the retry logic')).toBe('procedural')
    expect(classifyIntent('steps to deploy the service')).toBe('procedural')
    expect(classifyIntent('implement a new provider')).toBe('procedural')
  })

  it('classifies entity queries', () => {
    expect(classifyIntent('what is the `ModelRegistry`?')).toBe('entity')
    expect(classifyIntent('who owns the EventBus module?')).toBe('entity')
    expect(classifyIntent('tell me about ForgeError')).toBe('entity')
  })

  it('classifies factual queries', () => {
    expect(classifyIntent('which providers are supported?')).toBe('factual')
    expect(classifyIntent('is there a rate limiter?')).toBe('factual')
    expect(classifyIntent('what version of Node is required?')).toBe('factual')
  })

  it('returns general for unmatched queries', () => {
    expect(classifyIntent('hello')).toBe('general')
    expect(classifyIntent('ok')).toBe('general')
    expect(classifyIntent('')).toBe('general')
  })

  it('uses first matching strategy (temporal before factual)', () => {
    // "when" matches temporal before factual's "what/which"
    expect(classifyIntent('when was the latest version released?')).toBe('temporal')
  })

  it('accepts custom strategies', () => {
    const custom: RetrievalStrategy[] = [
      {
        intent: 'procedural',
        weights: { vector: 1, fts: 0, graph: 0 },
        patterns: [/\bfoo\b/i],
      },
    ]
    expect(classifyIntent('tell me about foo', custom)).toBe('procedural')
    expect(classifyIntent('bar baz', custom)).toBe('general')
  })
})

// ─── AdaptiveRetriever ───────────────────────────────────────────────────────

describe('AdaptiveRetriever', () => {
  describe('classifyIntent (instance method)', () => {
    it('delegates to pattern matching', () => {
      const retriever = new AdaptiveRetriever({ providers: {} })
      expect(retriever.classifyIntent('why did it break?')).toBe('causal')
    })
  })

  describe('getWeights', () => {
    it('returns strategy weights for known intents', () => {
      const retriever = new AdaptiveRetriever({ providers: {} })
      const weights = retriever.getWeights('causal')
      expect(weights).toEqual({ vector: 0.3, fts: 0.1, graph: 0.6 })
    })

    it('returns general weights for unknown intent', () => {
      const retriever = new AdaptiveRetriever({ providers: {} })
      const weights = retriever.getWeights('general')
      expect(weights).toEqual({ vector: 0.4, fts: 0.3, graph: 0.3 })
    })

    it('returns a copy, not the original', () => {
      const retriever = new AdaptiveRetriever({ providers: {} })
      const w1 = retriever.getWeights('causal')
      const w2 = retriever.getWeights('causal')
      w1.vector = 999
      expect(w2.vector).toBe(0.3)
    })
  })

  describe('search', () => {
    it('returns empty when no providers configured', async () => {
      const retriever = new AdaptiveRetriever({ providers: {} })
      const results = await retriever.search('test query', RECORDS)
      expect(results).toEqual([])
    })

    it('runs all three providers and fuses results', async () => {
      const vector = makeVectorProvider()
      const fts = makeFTSProvider()
      const graph = makeGraphProvider()

      const retriever = new AdaptiveRetriever({
        providers: { vector, fts, graph },
        namespace: ['test'],
      })

      const results = await retriever.search('why did the ModelRegistry fail?', RECORDS)

      expect(vector.search).toHaveBeenCalled()
      expect(fts.search).toHaveBeenCalled()
      expect(graph.search).toHaveBeenCalled()

      // Should have intent and weights metadata
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.intent).toBe('causal')
      expect(results[0]!.weights).toBeDefined()
      expect(results[0]!.weights.graph).toBeGreaterThan(results[0]!.weights.vector)
    })

    it('returns results with correct FusedResult shape', async () => {
      const retriever = new AdaptiveRetriever({
        providers: {
          vector: makeVectorProvider(),
          fts: makeFTSProvider(),
        },
      })

      const results = await retriever.search('what version is supported?', RECORDS)
      for (const r of results) {
        expect(r).toHaveProperty('key')
        expect(r).toHaveProperty('score')
        expect(r).toHaveProperty('value')
        expect(r).toHaveProperty('sources')
        expect(r).toHaveProperty('intent')
        expect(r).toHaveProperty('weights')
      }
    })

    it('skips fusion when only one provider available', async () => {
      const vector = makeVectorProvider([
        { key: 'rec-1', score: 0.95, value: RECORDS[0]!.value },
      ])

      const retriever = new AdaptiveRetriever({
        providers: { vector },
        namespace: ['test'],
      })

      const results = await retriever.search('hello world', RECORDS)
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('rec-1')
      expect(results[0]!.sources).toEqual(['vector'])
      expect(results[0]!.score).toBe(0.95)
    })

    it('redistributes weights when a provider is missing', async () => {
      // Only vector + fts, no graph
      const vector = makeVectorProvider()
      const fts = makeFTSProvider()

      const retriever = new AdaptiveRetriever({
        providers: { vector, fts },
      })

      // Causal query: graph=0.6, vector=0.3, fts=0.1
      // Without graph, redistribute: vector=0.3/0.4=0.75, fts=0.1/0.4=0.25
      const results = await retriever.search('why did it fail?', RECORDS)
      expect(results.length).toBeGreaterThan(0)
      const weights = results[0]!.weights
      expect(weights.graph).toBe(0)
      expect(weights.vector).toBeCloseTo(0.75, 2)
      expect(weights.fts).toBeCloseTo(0.25, 2)
    })

    it('handles provider failure gracefully (non-fatal)', async () => {
      const vector = {
        search: vi.fn().mockRejectedValue(new Error('Vector DB down')),
      }
      const fts = makeFTSProvider()

      const retriever = new AdaptiveRetriever({
        providers: { vector, fts },
      })

      // Should not throw, should return FTS results only
      const results = await retriever.search('some query', RECORDS)
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.sources).toEqual(['fts'])
    })

    it('returns empty when all providers fail', async () => {
      const vector = {
        search: vi.fn().mockRejectedValue(new Error('down')),
      }

      const retriever = new AdaptiveRetriever({
        providers: { vector },
      })

      const results = await retriever.search('query', RECORDS)
      expect(results).toEqual([])
    })

    it('respects limit parameter', async () => {
      const manyResults = Array.from({ length: 20 }, (_, i) => ({
        key: `rec-${i}`,
        score: 1 - i * 0.05,
        value: { text: `result ${i}` },
      }))

      const retriever = new AdaptiveRetriever({
        providers: { vector: makeVectorProvider(manyResults) },
      })

      const results = await retriever.search('query', RECORDS, 3)
      expect(results).toHaveLength(3)
    })

    it('uses defaultLimit from config', async () => {
      const manyResults = Array.from({ length: 20 }, (_, i) => ({
        key: `rec-${i}`,
        score: 1 - i * 0.05,
        value: { text: `result ${i}` },
      }))

      const retriever = new AdaptiveRetriever({
        providers: { vector: makeVectorProvider(manyResults) },
        defaultLimit: 5,
      })

      const results = await retriever.search('query', RECORDS)
      expect(results).toHaveLength(5)
    })

    it('applies higher graph weight for causal queries', async () => {
      // Graph returns rec-2 as top, vector returns rec-1 as top
      const vector = makeVectorProvider([
        { key: 'rec-1', score: 0.95, value: RECORDS[0]!.value },
      ])
      const graph = makeGraphProvider([
        { key: 'rec-2', score: 0.9, value: RECORDS[1]!.value, relationship: 'causal link' },
      ])

      const retriever = new AdaptiveRetriever({
        providers: { vector, graph },
        namespace: ['test'],
      })

      // Causal: graph gets 0.6, vector gets 0.3
      // After redistribution (no fts): graph ~0.67, vector ~0.33
      const results = await retriever.search('why did it fail?', RECORDS)
      expect(results).toHaveLength(2)

      // Graph result should rank higher due to higher weight
      const graphResult = results.find((r) => r.key === 'rec-2')
      const vectorResult = results.find((r) => r.key === 'rec-1')
      expect(graphResult).toBeDefined()
      expect(vectorResult).toBeDefined()
      expect(graphResult!.score).toBeGreaterThan(vectorResult!.score)
    })

    it('applies higher vector weight for factual queries', async () => {
      const vector = makeVectorProvider([
        { key: 'rec-1', score: 0.95, value: RECORDS[0]!.value },
      ])
      const graph = makeGraphProvider([
        { key: 'rec-2', score: 0.9, value: RECORDS[1]!.value, relationship: 'entity' },
      ])

      const retriever = new AdaptiveRetriever({
        providers: { vector, graph },
        namespace: ['test'],
      })

      // Factual: vector=0.6, graph=0.1 → redistributed: vector ~0.857, graph ~0.143
      const results = await retriever.search('which version is supported?', RECORDS)
      const vectorResult = results.find((r) => r.key === 'rec-1')
      const graphResult = results.find((r) => r.key === 'rec-2')
      expect(vectorResult).toBeDefined()
      expect(graphResult).toBeDefined()
      expect(vectorResult!.score).toBeGreaterThan(graphResult!.score)
    })

    it('uses custom strategies when provided', async () => {
      const customStrategies: RetrievalStrategy[] = [
        {
          intent: 'entity',
          weights: { vector: 0, fts: 0, graph: 1 },
          patterns: [/\bxyz\b/i],
        },
      ]

      const retriever = new AdaptiveRetriever({
        providers: {
          graph: makeGraphProvider(),
        },
        strategies: customStrategies,
      })

      const results = await retriever.search('tell me about xyz', RECORDS)
      expect(results[0]!.intent).toBe('entity')
    })

    it('passes namespace to vector provider', async () => {
      const vector = makeVectorProvider()
      const retriever = new AdaptiveRetriever({
        providers: { vector },
        namespace: ['project', 'memories'],
      })

      await retriever.search('test', RECORDS)
      expect(vector.search).toHaveBeenCalledWith(['project', 'memories'], 'test', 10)
    })
  })
})

// ─── DEFAULT_STRATEGIES export ───────────────────────────────────────────────

describe('DEFAULT_STRATEGIES', () => {
  it('exports an array of strategies', () => {
    expect(Array.isArray(DEFAULT_STRATEGIES)).toBe(true)
    expect(DEFAULT_STRATEGIES.length).toBe(5)
  })

  it('each strategy has required fields', () => {
    for (const s of DEFAULT_STRATEGIES) {
      expect(s.intent).toBeDefined()
      expect(s.weights).toBeDefined()
      expect(s.weights.vector).toBeGreaterThanOrEqual(0)
      expect(s.weights.fts).toBeGreaterThanOrEqual(0)
      expect(s.weights.graph).toBeGreaterThanOrEqual(0)
      expect(s.patterns.length).toBeGreaterThan(0)
    }
  })

  it('strategy weights sum to approximately 1', () => {
    for (const s of DEFAULT_STRATEGIES) {
      const sum = s.weights.vector + s.weights.fts + s.weights.graph
      expect(sum).toBeCloseTo(1.0, 5)
    }
  })
})
