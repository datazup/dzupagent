import { describe, it, expect, beforeEach } from 'vitest'
import { VectorMetricsCollector } from '../vector-metrics.js'
import type { VectorMetrics } from '../vector-metrics.js'

describe('VectorMetricsCollector', () => {
  let collector: VectorMetricsCollector

  beforeEach(() => {
    collector = new VectorMetricsCollector()
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

  describe('record()', () => {
    it('stores a metric', () => {
      collector.record(makeMetric())
      const report = collector.getReport()
      expect(report.totalSearches).toBe(1)
    })

    it('stores multiple metrics', () => {
      collector.record(makeMetric())
      collector.record(makeMetric({ provider: 'pinecone', collection: 'docs' }))
      const report = collector.getReport()
      expect(report.totalSearches).toBe(2)
    })
  })

  describe('getReport()', () => {
    it('returns zeroes when no metrics recorded', () => {
      const report = collector.getReport()
      expect(report.totalSearches).toBe(0)
      expect(report.avgSearchLatencyMs).toBe(0)
      expect(report.totalEmbeddings).toBe(0)
      expect(report.avgEmbedLatencyMs).toBe(0)
      expect(report.byProvider).toEqual({})
      expect(report.byCollection).toEqual({})
    })

    it('aggregates averages correctly', () => {
      collector.record(makeMetric({ searchLatencyMs: 10, embeddingLatencyMs: 30 }))
      collector.record(makeMetric({ searchLatencyMs: 20, embeddingLatencyMs: 50 }))

      const report = collector.getReport()
      expect(report.avgSearchLatencyMs).toBe(15)
      expect(report.avgEmbedLatencyMs).toBe(40)
    })

    it('counts totals correctly', () => {
      collector.record(makeMetric())
      collector.record(makeMetric())
      collector.record(makeMetric())

      const report = collector.getReport()
      expect(report.totalSearches).toBe(3)
      expect(report.totalEmbeddings).toBe(3)
    })

    it('groups by provider', () => {
      collector.record(makeMetric({ provider: 'qdrant' }))
      collector.record(makeMetric({ provider: 'qdrant' }))
      collector.record(makeMetric({ provider: 'pinecone' }))

      const report = collector.getReport()
      expect(report.byProvider).toEqual({ qdrant: 2, pinecone: 1 })
    })

    it('groups by collection', () => {
      collector.record(makeMetric({ collection: 'features' }))
      collector.record(makeMetric({ collection: 'docs' }))
      collector.record(makeMetric({ collection: 'features' }))

      const report = collector.getReport()
      expect(report.byCollection).toEqual({ features: 2, docs: 1 })
    })
  })

  describe('reset()', () => {
    it('clears all recorded data', () => {
      collector.record(makeMetric())
      collector.record(makeMetric())
      expect(collector.getReport().totalSearches).toBe(2)

      collector.reset()
      const report = collector.getReport()
      expect(report.totalSearches).toBe(0)
      expect(report.avgSearchLatencyMs).toBe(0)
      expect(report.byProvider).toEqual({})
      expect(report.byCollection).toEqual({})
    })
  })
})
