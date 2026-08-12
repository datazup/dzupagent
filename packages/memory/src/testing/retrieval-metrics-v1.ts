import type { MemoryResultV1 } from '../retrieval/v1-types.js'
import type {
  InternalMemoryMetricV1,
} from './conformance-core-v1.js'
import type { MemoryBenchmarkProfileV1 } from './benchmark-profile-v1.js'

export function rankingMetrics(
  result: MemoryResultV1,
  relevantIds: readonly string[],
  profile: MemoryBenchmarkProfileV1,
): readonly InternalMemoryMetricV1[] {
  const selected = result.records.map(record => record.memoryId)
  const relevant = new Set(relevantIds)
  const hits = selected.filter(memoryId => relevant.has(memoryId)).length
  const precision = selected.length === 0 ? (relevant.size === 0 ? 1 : 0) : hits / selected.length
  const recall = relevant.size === 0 ? 1 : hits / relevant.size
  const first = selected.findIndex(memoryId => relevant.has(memoryId))
  const reciprocalRank = first < 0 ? 0 : 1 / (first + 1)
  const dcg = selected.reduce((total, memoryId, index) =>
    total + (relevant.has(memoryId) ? 1 / Math.log2(index + 2) : 0), 0)
  const idealLength = Math.min(relevant.size, selected.length)
  const ideal = Array.from({ length: idealLength }, (_, index) =>
    1 / Math.log2(index + 2)).reduce((total, value) => total + value, 0)
  const ndcg = ideal === 0 ? (relevant.size === 0 ? 1 : 0) : dcg / ideal
  return Object.freeze([
    ratio('precision-at-k', precision, profile.thresholds.precisionAtK, 'at-least'),
    ratio('recall-at-k', recall, profile.thresholds.recallAtK, 'at-least'),
    ratio('mrr', reciprocalRank, profile.thresholds.mrr, 'at-least'),
    ratio('ndcg', ndcg, profile.thresholds.ndcg, 'at-least'),
  ])
}

export function ratio(
  name: string,
  value: number,
  threshold: number,
  comparison: InternalMemoryMetricV1['comparison'] = 'at-least',
): InternalMemoryMetricV1 {
  return { name, value, unit: 'ratio', threshold, comparison }
}

export function resourceMetrics(
  result: MemoryResultV1,
  latencyMs: number,
  profile: MemoryBenchmarkProfileV1,
): readonly InternalMemoryMetricV1[] {
  return Object.freeze([{
    name: 'deterministic-latency-ms',
    value: latencyMs,
    unit: 'milliseconds',
    threshold: profile.thresholds.maxLatencyMs,
    comparison: 'at-most',
  }, {
    name: 'selected-tokens',
    value: result.tokenEstimate,
    unit: 'tokens',
    threshold: profile.thresholds.maxTokens,
    comparison: 'at-most',
  }, {
    name: 'provider-cost-microusd',
    value: 0,
    unit: 'microusd',
    threshold: profile.thresholds.maxCostMicrousd,
    comparison: 'at-most',
  }])
}
