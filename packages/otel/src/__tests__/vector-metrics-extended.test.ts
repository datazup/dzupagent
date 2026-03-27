import { describe, it, expect, beforeEach } from 'vitest'
import { VectorMetricsCollector } from '../vector-metrics.js'
import type { VectorMetrics } from '../vector-metrics.js'

describe('VectorMetricsCollector extended', () => {
  let sut: VectorMetricsCollector

  beforeEach(() => {
    sut = new VectorMetricsCollector()
  })

  function makeMetric(overrides: Partial<VectorMetrics> = {}): VectorMetrics {
    return {
      searchLatencyMs: 10,
      searchResultCount: 5,
      embeddingLatencyMs: 20,
      upsertCount: 0,
      provider: 'qdrant',
      collection: 'features',
      ...overrides,
    }
  }

  describe('query latency tracking', () => {
    it('calculates average search latency across varying latencies', () => {
      sut.record(makeMetric({ searchLatencyMs: 5 }))
      sut.record(makeMetric({ searchLatencyMs: 15 }))
      sut.record(makeMetric({ searchLatencyMs: 25 }))
      sut.record(makeMetric({ searchLatencyMs: 35 }))

      const report = sut.getReport()
      expect(report.avgSearchLatencyMs).toBe(20) // (5+15+25+35)/4
    })

    it('handles zero latency searches', () => {
      sut.record(makeMetric({ searchLatencyMs: 0 }))
      sut.record(makeMetric({ searchLatencyMs: 0 }))

      const report = sut.getReport()
      expect(report.avgSearchLatencyMs).toBe(0)
    })

    it('handles very high latency values', () => {
      sut.record(makeMetric({ searchLatencyMs: 100000 }))
      sut.record(makeMetric({ searchLatencyMs: 200000 }))

      const report = sut.getReport()
      expect(report.avgSearchLatencyMs).toBe(150000)
    })
  })

  describe('embedding latency tracking', () => {
    it('calculates average embedding latency', () => {
      sut.record(makeMetric({ embeddingLatencyMs: 30 }))
      sut.record(makeMetric({ embeddingLatencyMs: 50 }))
      sut.record(makeMetric({ embeddingLatencyMs: 70 }))

      const report = sut.getReport()
      expect(report.avgEmbedLatencyMs).toBe(50)
    })

    it('handles zero embedding latency', () => {
      sut.record(makeMetric({ embeddingLatencyMs: 0 }))

      const report = sut.getReport()
      expect(report.avgEmbedLatencyMs).toBe(0)
    })
  })

  describe('hit rate calculation by provider', () => {
    it('counts operations per provider', () => {
      sut.record(makeMetric({ provider: 'qdrant' }))
      sut.record(makeMetric({ provider: 'qdrant' }))
      sut.record(makeMetric({ provider: 'qdrant' }))
      sut.record(makeMetric({ provider: 'pinecone' }))
      sut.record(makeMetric({ provider: 'pgvector' }))

      const report = sut.getReport()
      expect(report.byProvider).toEqual({
        qdrant: 3,
        pinecone: 1,
        pgvector: 1,
      })
    })

    it('counts operations per collection', () => {
      sut.record(makeMetric({ collection: 'features' }))
      sut.record(makeMetric({ collection: 'features' }))
      sut.record(makeMetric({ collection: 'docs' }))
      sut.record(makeMetric({ collection: 'lessons' }))
      sut.record(makeMetric({ collection: 'lessons' }))
      sut.record(makeMetric({ collection: 'lessons' }))

      const report = sut.getReport()
      expect(report.byCollection).toEqual({
        features: 2,
        docs: 1,
        lessons: 3,
      })
    })
  })

  describe('index size monitoring via upsert counts', () => {
    it('records upsert counts in metrics', () => {
      sut.record(makeMetric({ upsertCount: 10 }))
      sut.record(makeMetric({ upsertCount: 20 }))
      sut.record(makeMetric({ upsertCount: 0 }))

      const report = sut.getReport()
      expect(report.totalSearches).toBe(3)
    })
  })

  describe('optional fields', () => {
    it('handles metrics with embeddingTokenCount', () => {
      sut.record(makeMetric({ embeddingTokenCount: 512 }))

      const report = sut.getReport()
      expect(report.totalSearches).toBe(1)
    })

    it('handles metrics with embeddingCostCents', () => {
      sut.record(makeMetric({ embeddingCostCents: 0.5 }))

      const report = sut.getReport()
      expect(report.totalSearches).toBe(1)
    })

    it('handles metrics with all optional fields', () => {
      sut.record(makeMetric({
        embeddingTokenCount: 512,
        embeddingCostCents: 0.5,
      }))

      const report = sut.getReport()
      expect(report.totalSearches).toBe(1)
      expect(report.totalEmbeddings).toBe(1)
    })
  })

  describe('mixed provider and collection combinations', () => {
    it('tracks unique provider-collection combinations independently', () => {
      sut.record(makeMetric({ provider: 'qdrant', collection: 'features' }))
      sut.record(makeMetric({ provider: 'qdrant', collection: 'docs' }))
      sut.record(makeMetric({ provider: 'pinecone', collection: 'features' }))

      const report = sut.getReport()
      expect(report.byProvider).toEqual({ qdrant: 2, pinecone: 1 })
      expect(report.byCollection).toEqual({ features: 2, docs: 1 })
    })
  })

  describe('reset behavior', () => {
    it('reset allows fresh aggregation', () => {
      sut.record(makeMetric({ searchLatencyMs: 100 }))
      sut.record(makeMetric({ searchLatencyMs: 200 }))
      expect(sut.getReport().avgSearchLatencyMs).toBe(150)

      sut.reset()

      sut.record(makeMetric({ searchLatencyMs: 50 }))
      const report = sut.getReport()
      expect(report.avgSearchLatencyMs).toBe(50)
      expect(report.totalSearches).toBe(1)
    })

    it('reset clears provider and collection buckets', () => {
      sut.record(makeMetric({ provider: 'qdrant', collection: 'features' }))
      sut.reset()

      const report = sut.getReport()
      expect(report.byProvider).toEqual({})
      expect(report.byCollection).toEqual({})
    })
  })

  describe('large number of metrics', () => {
    it('handles 1000 recorded metrics correctly', () => {
      for (let i = 0; i < 1000; i++) {
        sut.record(makeMetric({
          searchLatencyMs: i,
          embeddingLatencyMs: i * 2,
          provider: i % 2 === 0 ? 'qdrant' : 'pinecone',
          collection: `col-${i % 5}`,
        }))
      }

      const report = sut.getReport()
      expect(report.totalSearches).toBe(1000)
      expect(report.byProvider['qdrant']).toBe(500)
      expect(report.byProvider['pinecone']).toBe(500)

      // Average of 0..999 = 499.5
      expect(report.avgSearchLatencyMs).toBeCloseTo(499.5)
      expect(report.avgEmbedLatencyMs).toBeCloseTo(999)

      // 5 collections
      expect(Object.keys(report.byCollection)).toHaveLength(5)
      expect(report.byCollection['col-0']).toBe(200)
    })
  })

  describe('single metric precision', () => {
    it('average equals the single value for one metric', () => {
      sut.record(makeMetric({ searchLatencyMs: 42, embeddingLatencyMs: 99 }))

      const report = sut.getReport()
      expect(report.avgSearchLatencyMs).toBe(42)
      expect(report.avgEmbedLatencyMs).toBe(99)
    })
  })
})
