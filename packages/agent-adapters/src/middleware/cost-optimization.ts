/**
 * Cost optimization engine for agent adapters.
 *
 * Auto-routes tasks to cheaper providers when quality is equivalent,
 * using historical performance data with exponential decay and
 * tag-similarity matching.
 *
 * Implements TaskRoutingStrategy so it can plug directly into
 * ProviderAdapterRegistry as a drop-in router.
 */

import type { DzupEventBus } from '@dzupagent/core'
import type {
  AdapterProviderId,
  RoutingDecision,
  TaskDescriptor,
  TaskRoutingStrategy,
} from '../types.js'

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface CostOptimizationConfig {
  /** Minimum quality threshold (0-1). Won't route to cheaper provider if quality drops below this. Default 0.7 */
  minQualityThreshold?: number
  /** Maximum quality degradation allowed when switching to cheaper provider (0-1). Default 0.1 */
  maxQualityDegradation?: number
  /** Minimum sample size before making routing decisions. Default 5 */
  minSampleSize?: number
  /** Decay factor for older observations (0-1). 1 = no decay. Default 0.95 */
  decayFactor?: number
  /** Event bus for emitting optimization events */
  eventBus?: DzupEventBus
}

export interface ProviderPerformanceRecord {
  providerId: AdapterProviderId
  taskTags: string[]
  qualityScore: number    // 0-1
  costCents: number
  durationMs: number
  timestamp: number
}

export interface ProviderStats {
  providerId: AdapterProviderId
  sampleCount: number
  avgQuality: number
  avgCostCents: number
  avgDurationMs: number
  /** Cost-efficiency score: quality / cost. Higher is better. */
  efficiency: number
}

export interface OptimizationDecision {
  recommendedProvider: AdapterProviderId
  originalProvider: AdapterProviderId
  reason: string
  estimatedSavingsPercent: number
  qualityConfidence: number  // How confident we are quality won't degrade
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default priority ordering: claude > codex > gemini > qwen > crush */
const DEFAULT_PRIORITY: Record<AdapterProviderId, number> = {
  claude: 5,
  codex: 4,
  openrouter: 4,
  gemini: 3,
  'gemini-sdk': 3,
  goose: 3,
  qwen: 2,
  crush: 1,
}

/** Maximum observations stored per (provider, tagKey) combination */
const MAX_RING_BUFFER_SIZE = 200

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Canonical key for a set of tags (sorted, lowercased, joined) */
function tagKey(tags: readonly string[]): string {
  return [...tags].map((t) => t.toLowerCase()).sort().join(',')
}

/** Jaccard similarity between two tag sets (intersection / union). Returns 0-1. */
function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** Parse a tag key back into a Set of tags */
function parseTagKey(key: string): ReadonlySet<string> {
  if (key === '') return new Set()
  return new Set(key.split(','))
}

function buildFallbacks(
  primary: AdapterProviderId,
  available: AdapterProviderId[],
): AdapterProviderId[] {
  return available.filter((id) => id !== primary)
}

// ---------------------------------------------------------------------------
// Ring buffer for observations
// ---------------------------------------------------------------------------

class RingBuffer<T> {
  private readonly items: T[]
  private writeIndex = 0
  private count = 0
  private readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
    this.items = new Array<T>(capacity)
  }

  push(item: T): void {
    this.items[this.writeIndex] = item
    this.writeIndex = (this.writeIndex + 1) % this.capacity
    if (this.count < this.capacity) this.count++
  }

  /** Return all stored items from oldest to newest */
  toArray(): T[] {
    if (this.count < this.capacity) {
      return this.items.slice(0, this.count)
    }
    // Buffer is full — oldest starts at writeIndex
    return [
      ...this.items.slice(this.writeIndex),
      ...this.items.slice(0, this.writeIndex),
    ]
  }

  get size(): number {
    return this.count
  }

  clear(): void {
    this.writeIndex = 0
    this.count = 0
  }
}

// ---------------------------------------------------------------------------
// CostOptimizationEngine
// ---------------------------------------------------------------------------

/**
 * Intelligent cost optimization engine that auto-routes tasks to cheaper
 * providers when quality is equivalent, using historical performance data.
 *
 * Key behaviors:
 * - Stores observations in ring buffers per (providerId, tagSet)
 * - Applies exponential decay to older observations
 * - Uses Jaccard tag-set similarity when exact tag match isn't available
 * - Falls back to default priority ordering when sample size is insufficient
 * - Emits `quality:adjusted` events when routing to a cheaper provider
 */
export class CostOptimizationEngine implements TaskRoutingStrategy {
  readonly name = 'cost-optimized-adaptive'

  private readonly minQualityThreshold: number
  private readonly maxQualityDegradation: number
  private readonly minSampleSize: number
  private readonly decayFactor: number
  private readonly eventBus: DzupEventBus | undefined

  /**
   * Nested map: providerId → tagKey → ring buffer of observations.
   */
  private readonly observations = new Map<
    AdapterProviderId,
    Map<string, RingBuffer<ProviderPerformanceRecord>>
  >()

  constructor(config?: CostOptimizationConfig) {
    this.minQualityThreshold = config?.minQualityThreshold ?? 0.7
    this.maxQualityDegradation = config?.maxQualityDegradation ?? 0.1
    this.minSampleSize = config?.minSampleSize ?? 5
    this.decayFactor = config?.decayFactor ?? 0.95
    this.eventBus = config?.eventBus
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Record a performance observation after a task completes */
  recordObservation(record: ProviderPerformanceRecord): void {
    const key = tagKey(record.taskTags)
    let providerMap = this.observations.get(record.providerId)
    if (!providerMap) {
      providerMap = new Map()
      this.observations.set(record.providerId, providerMap)
    }

    let buffer = providerMap.get(key)
    if (!buffer) {
      buffer = new RingBuffer<ProviderPerformanceRecord>(MAX_RING_BUFFER_SIZE)
      providerMap.set(key, buffer)
    }

    buffer.push(record)
  }

  /** Get stats for a specific provider, optionally filtered by tags */
  getStats(providerId: AdapterProviderId, tags?: string[]): ProviderStats | undefined {
    const records = this.getRelevantRecords(providerId, tags ?? [])
    if (records.length === 0) return undefined

    return this.computeStats(providerId, records)
  }

  /** Get all provider stats, optionally filtered by tags */
  getAllStats(tags?: string[]): ProviderStats[] {
    const result: ProviderStats[] = []
    for (const providerId of this.observations.keys()) {
      const stats = this.getStats(providerId, tags)
      if (stats) result.push(stats)
    }
    return result
  }

  /** Get optimization recommendation for a task */
  recommend(
    task: TaskDescriptor,
    availableProviders: AdapterProviderId[],
  ): OptimizationDecision | undefined {
    if (availableProviders.length < 2) return undefined

    // Find best quality provider as baseline
    const statsByProvider = new Map<AdapterProviderId, ProviderStats>()
    for (const pid of availableProviders) {
      const stats = this.getStats(pid, task.tags)
      if (stats && stats.sampleCount >= this.minSampleSize) {
        statsByProvider.set(pid, stats)
      }
    }

    if (statsByProvider.size < 2) return undefined

    // Find the highest quality provider (the "original" choice)
    let bestQualityProvider: AdapterProviderId | undefined
    let bestQuality = -1
    for (const [pid, stats] of statsByProvider) {
      if (stats.avgQuality > bestQuality) {
        bestQuality = stats.avgQuality
        bestQualityProvider = pid
      }
    }

    if (!bestQualityProvider) return undefined

    const bestStats = statsByProvider.get(bestQualityProvider)!

    // Find cheapest provider whose quality is within degradation threshold
    let cheapestEligible: AdapterProviderId | undefined
    let cheapestCost = Infinity
    for (const [pid, stats] of statsByProvider) {
      if (pid === bestQualityProvider) continue

      const qualityDrop = bestQuality - stats.avgQuality
      if (
        qualityDrop <= this.maxQualityDegradation &&
        stats.avgQuality >= this.minQualityThreshold &&
        stats.avgCostCents < cheapestCost
      ) {
        cheapestCost = stats.avgCostCents
        cheapestEligible = pid
      }
    }

    if (!cheapestEligible || cheapestEligible === bestQualityProvider) return undefined

    const cheapStats = statsByProvider.get(cheapestEligible)!
    const savingsPercent =
      bestStats.avgCostCents > 0
        ? ((bestStats.avgCostCents - cheapStats.avgCostCents) / bestStats.avgCostCents) * 100
        : 0

    if (savingsPercent <= 0) return undefined

    // Confidence is based on sample sizes and quality margin
    const minSamples = Math.min(bestStats.sampleCount, cheapStats.sampleCount)
    const sampleConfidence = Math.min(minSamples / (this.minSampleSize * 4), 1)
    const qualityMargin = this.maxQualityDegradation - (bestQuality - cheapStats.avgQuality)
    const marginConfidence = Math.min(qualityMargin / this.maxQualityDegradation, 1)
    const qualityConfidence = sampleConfidence * 0.6 + marginConfidence * 0.4

    return {
      recommendedProvider: cheapestEligible,
      originalProvider: bestQualityProvider,
      reason:
        `Provider "${cheapestEligible}" offers ${savingsPercent.toFixed(1)}% cost savings ` +
        `with quality ${cheapStats.avgQuality.toFixed(3)} vs ${bestQuality.toFixed(3)} ` +
        `(within ${this.maxQualityDegradation} degradation threshold)`,
      estimatedSavingsPercent: Math.round(savingsPercent * 10) / 10,
      qualityConfidence,
    }
  }

  /** TaskRoutingStrategy.route implementation */
  route(task: TaskDescriptor, availableProviders: AdapterProviderId[]): RoutingDecision {
    if (availableProviders.length === 0) {
      return {
        provider: 'auto',
        reason: 'No adapters available for cost-optimized-adaptive routing',
        fallbackProviders: [],
        confidence: 0,
      }
    }

    // Respect explicit preference
    if (task.preferredProvider && availableProviders.includes(task.preferredProvider)) {
      return {
        provider: task.preferredProvider,
        reason: `Preferred provider "${task.preferredProvider}" overrides cost optimization`,
        fallbackProviders: buildFallbacks(task.preferredProvider, availableProviders),
        confidence: 0.95,
      }
    }

    // Check if we have enough samples
    const recommendation = this.recommend(task, availableProviders)

    if (recommendation) {
      // Emit quality:adjusted event
      try {
        this.eventBus?.emit({
          type: 'quality:adjusted',
          adjustment: `routing:${recommendation.originalProvider}→${recommendation.recommendedProvider}`,
          reason: recommendation.reason,
          previousValue: recommendation.originalProvider,
          newValue: recommendation.recommendedProvider,
          reversible: true,
        })
      } catch {
        // Event bus failure is non-fatal
      }

      // Build fallback list: start with original provider, then others sorted by priority
      const fallbacks = [
        recommendation.originalProvider,
        ...availableProviders.filter(
          (id) =>
            id !== recommendation.recommendedProvider &&
            id !== recommendation.originalProvider,
        ),
      ]

      return {
        provider: recommendation.recommendedProvider,
        reason: recommendation.reason,
        fallbackProviders: fallbacks,
        confidence: recommendation.qualityConfidence,
      }
    }

    // Not enough data — fall back to default priority ordering
    return this.defaultFallback(availableProviders)
  }

  /** Clear all historical data */
  reset(): void {
    this.observations.clear()
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Get relevant performance records for a provider and tag set.
   *
   * First tries exact tag match. If not enough samples, uses Jaccard
   * similarity to find the most similar tag sets and merges their data.
   */
  private getRelevantRecords(
    providerId: AdapterProviderId,
    tags: readonly string[],
  ): ProviderPerformanceRecord[] {
    const providerMap = this.observations.get(providerId)
    if (!providerMap) return []

    const requestedKey = tagKey(tags)

    // Try exact match first
    const exactBuffer = providerMap.get(requestedKey)
    if (exactBuffer && exactBuffer.size >= this.minSampleSize) {
      return exactBuffer.toArray()
    }

    // Gather all records from similar tag sets weighted by Jaccard similarity
    const requestedSet = parseTagKey(requestedKey)
    const candidates: Array<{ similarity: number; records: ProviderPerformanceRecord[] }> = []

    for (const [key, buffer] of providerMap) {
      const keySet = parseTagKey(key)
      const sim = jaccardSimilarity(requestedSet, keySet)
      if (sim > 0.3) {
        candidates.push({ similarity: sim, records: buffer.toArray() })
      }
    }

    // Sort by similarity descending, collect records
    candidates.sort((a, b) => b.similarity - a.similarity)

    const merged: ProviderPerformanceRecord[] = []
    for (const candidate of candidates) {
      merged.push(...candidate.records)
    }

    return merged
  }

  /**
   * Compute aggregate stats from a set of records, applying exponential
   * decay so that older observations have less influence.
   */
  private computeStats(
    providerId: AdapterProviderId,
    records: ProviderPerformanceRecord[],
  ): ProviderStats {
    // Sort by timestamp ascending so newest records get highest weight
    const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp)

    let weightedQuality = 0
    let weightedCost = 0
    let weightedDuration = 0
    let totalWeight = 0

    for (let i = 0; i < sorted.length; i++) {
      const rec = sorted[i]!
      // Newest record (last in array) gets weight 1, older records decay
      const age = sorted.length - 1 - i
      const weight = Math.pow(this.decayFactor, age)

      weightedQuality += rec.qualityScore * weight
      weightedCost += rec.costCents * weight
      weightedDuration += rec.durationMs * weight
      totalWeight += weight
    }

    const avgQuality = totalWeight > 0 ? weightedQuality / totalWeight : 0
    const avgCostCents = totalWeight > 0 ? weightedCost / totalWeight : 0
    const avgDurationMs = totalWeight > 0 ? weightedDuration / totalWeight : 0
    const efficiency = avgCostCents > 0 ? avgQuality / avgCostCents : avgQuality > 0 ? Infinity : 0

    return {
      providerId,
      sampleCount: records.length,
      avgQuality,
      avgCostCents,
      avgDurationMs,
      efficiency,
    }
  }

  /** Default priority-based fallback when insufficient data is available */
  private defaultFallback(availableProviders: AdapterProviderId[]): RoutingDecision {
    const sorted = [...availableProviders].sort(
      (a, b) => (DEFAULT_PRIORITY[b] ?? 0) - (DEFAULT_PRIORITY[a] ?? 0),
    )

    const primary = sorted[0]!
    return {
      provider: primary,
      reason: `Insufficient performance data — defaulting to priority-based routing ("${primary}")`,
      fallbackProviders: sorted.slice(1),
      confidence: 0.5,
    }
  }
}
