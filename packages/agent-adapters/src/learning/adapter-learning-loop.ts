/**
 * Adapter learning loop — captures execution outcomes and feeds back
 * into routing decisions over time.
 *
 * Records execution results per provider, builds statistical profiles,
 * detects failure patterns, and recommends recovery actions. The data
 * can be exported/imported for persistence across process restarts.
 */

import { defaultLogger } from '@dzupagent/core/utils'
import type { DzupEventBus } from '@dzupagent/core/events'
import type { AdapterProviderId } from '../types.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExecutionRecord {
  tenantId?: string | null
  providerId: AdapterProviderId
  taskType: string
  tags: string[]
  success: boolean
  durationMs: number
  inputTokens: number
  outputTokens: number
  costCents: number
  errorType?: string
  qualityScore?: number
  timestamp: number
}

export interface ProviderProfile {
  tenantId?: string | null
  providerId: AdapterProviderId
  totalExecutions: number
  successRate: number
  avgDurationMs: number
  avgCostCents: number
  avgQualityScore: number
  /** Task types this provider excels at (success rate > 0.8 with > 5 samples) */
  specialties: string[]
  /** Task types this provider struggles with (success rate < 0.5 with > 5 samples) */
  weaknesses: string[]
  /** Recent trend: improving, stable, degrading */
  trend: 'improving' | 'stable' | 'degrading'
}

export interface FailurePattern {
  patternId: string
  tenantId?: string | null
  providerId: AdapterProviderId
  errorType: string
  frequency: number
  firstSeen: Date
  lastSeen: Date
  suggestedAction: RecoverySuggestion
}

export type RecoverySuggestion =
  | { action: 'switch-provider'; targetProvider: AdapterProviderId; reason: string }
  | { action: 'increase-budget'; multiplier: number; reason: string }
  | { action: 'simplify-task'; reason: string }
  | { action: 'retry'; backoffMs: number; reason: string }

export interface LearningConfig {
  /** Max records to keep per provider. Default 500 */
  maxRecordsPerProvider?: number
  /** Window for failure pattern detection in ms. Default 3600_000 (1 hour) */
  failureWindowMs?: number
  /** Min records before provider profile is considered reliable. Default 10 */
  minSampleSize?: number
  /** Event bus */
  eventBus?: DzupEventBus
}

export interface PerformanceReport {
  generatedAt: Date
  totalExecutions: number
  overallSuccessRate: number
  avgCostPerExecution: number
  providers: ProviderProfile[]
  activeFailurePatterns: FailurePattern[]
  recommendations: string[]
}

export interface ProviderComparison {
  providerA: { providerId: AdapterProviderId; successRate: number; avgDuration: number; avgCost: number }
  providerB: { providerId: AdapterProviderId; successRate: number; avgDuration: number; avgCost: number }
  winner: AdapterProviderId | 'tie'
  reason: string
}

// ---------------------------------------------------------------------------
// Ring buffer (capped circular storage)
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
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RECORDS = 500
const DEFAULT_FAILURE_WINDOW_MS = 3_600_000 // 1 hour
const DEFAULT_MIN_SAMPLE_SIZE = 10
const MIN_FAILURE_PATTERN_FREQUENCY = 3
const SPECIALTY_THRESHOLD = 0.8
const WEAKNESS_THRESHOLD = 0.5
const SPECIALTY_MIN_SAMPLES = 5
const TREND_SPLIT_RATIO = 0.8
const TREND_THRESHOLD = 0.05
const DEFAULT_TENANT_ID = 'default'

function normalizeTenantId(tenantId: string | null | undefined): string {
  return tenantId && tenantId.length > 0 ? tenantId : DEFAULT_TENANT_ID
}

function scopedProviderKey(providerId: AdapterProviderId, tenantId: string): string {
  return tenantId === DEFAULT_TENANT_ID ? providerId : `${tenantId}:${providerId}`
}

function providerIdFromScopedKey(key: string): AdapterProviderId {
  const separatorIndex = key.indexOf(':')
  return (separatorIndex === -1 ? key : key.slice(separatorIndex + 1)) as AdapterProviderId
}

function tenantIdFromScopedKey(key: string): string {
  const separatorIndex = key.indexOf(':')
  return separatorIndex === -1 ? DEFAULT_TENANT_ID : key.slice(0, separatorIndex)
}

// ---------------------------------------------------------------------------
// AdapterLearningLoop
// ---------------------------------------------------------------------------

export class AdapterLearningLoop {
  private readonly maxRecordsPerProvider: number
  private readonly failureWindowMs: number
  private readonly minSampleSize: number
  private readonly eventBus: DzupEventBus | undefined

  /** scoped provider key -> ring buffer of execution records */
  private readonly records = new Map<string, RingBuffer<ExecutionRecord>>()

  constructor(config?: LearningConfig) {
    this.maxRecordsPerProvider = config?.maxRecordsPerProvider ?? DEFAULT_MAX_RECORDS
    this.failureWindowMs = config?.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS
    this.minSampleSize = config?.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE
    this.eventBus = config?.eventBus
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Emit a deprecation warning when a routing/profile lookup is made
   * without an explicit tenantId, but only when there is data in the
   * records map (otherwise the call is harmless on an empty store).
   *
   * Routing on the global `default` scope can pool data across tenants
   * and contaminate decisions; callers SHOULD pass an explicit tenantId.
   */
  private warnMissingTenantIdForRouting(tenantId: string | undefined): void {
    if (tenantId !== undefined) return
    if (this.records.size === 0) return
    defaultLogger.warn(
      '[AdapterLearningLoop] tenantId not provided — defaulting to global scope; routing decisions may be contaminated by cross-tenant data',
    )
  }

  /** Record an execution outcome */
  record(record: ExecutionRecord): void {
    const tenantId = normalizeTenantId(record.tenantId)
    const key = scopedProviderKey(record.providerId, tenantId)
    let buffer = this.records.get(key)
    if (!buffer) {
      buffer = new RingBuffer<ExecutionRecord>(this.maxRecordsPerProvider)
      this.records.set(key, buffer)
    }

    buffer.push({ ...record, tenantId })

    try {
      this.eventBus?.emit({
        type: 'quality:adjusted',
        adjustment: `learning:record:${record.providerId}`,
        reason: `Recorded ${record.success ? 'success' : 'failure'} for ${record.taskType}`,
        previousValue: buffer.size - 1,
        newValue: buffer.size,
        reversible: false,
      })
    } catch {
      // Event bus failure is non-fatal
    }
  }

  /** Get profile for a specific provider */
  getProfile(providerId: AdapterProviderId, tenantId?: string): ProviderProfile {
    this.warnMissingTenantIdForRouting(tenantId)
    const normalizedTenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID)
    const buffer = this.records.get(scopedProviderKey(providerId, normalizedTenantId))
    const all = buffer?.toArray() ?? []

    return this.computeProfile(providerId, all, normalizedTenantId)
  }

  /**
   * Aggregate profile across all tenants — for ops dashboards only.
   * Never use for routing decisions.
   */
  getGlobalProfile(providerId: AdapterProviderId): ProviderProfile {
    const allRecords: ExecutionRecord[] = []
    for (const [key, buffer] of this.records.entries()) {
      if (providerIdFromScopedKey(key) === providerId) {
        allRecords.push(...buffer.toArray())
      }
    }
    return this.computeProfile(providerId, allRecords, DEFAULT_TENANT_ID)
  }

  /** Get profiles for all providers with data */
  getAllProfiles(tenantId?: string): ProviderProfile[] {
    this.warnMissingTenantIdForRouting(tenantId)
    const normalizedTenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID)
    const profiles: ProviderProfile[] = []
    for (const key of this.records.keys()) {
      if (tenantIdFromScopedKey(key) !== normalizedTenantId) continue
      // Pass through the resolved tenantId to avoid duplicate warnings from getProfile
      profiles.push(this.getProfile(providerIdFromScopedKey(key), normalizedTenantId))
    }
    return profiles
  }

  /**
   * Find the best provider for a task type based on historical data.
   *
   * Filters providers by minSampleSize, then picks highest success rate
   * for the task type. Ties broken by speed, then cost.
   */
  getBestProvider(
    taskType: string,
    available: AdapterProviderId[],
    tenantId?: string,
  ): AdapterProviderId | undefined {
    this.warnMissingTenantIdForRouting(tenantId)
    interface Candidate {
      providerId: AdapterProviderId
      successRate: number
      avgDuration: number
      avgCost: number
    }

    const candidates: Candidate[] = []
    const normalizedTenantId = normalizeTenantId(tenantId)

    for (const providerId of available) {
      const buffer = this.records.get(scopedProviderKey(providerId, normalizedTenantId))
      if (!buffer) continue

      const all = buffer.toArray()
      const forTask = all.filter((r) => r.taskType === taskType)
      if (forTask.length < this.minSampleSize) continue

      const successes = forTask.filter((r) => r.success).length
      const successRate = successes / forTask.length
      const avgDuration = forTask.reduce((sum, r) => sum + r.durationMs, 0) / forTask.length
      const avgCost = forTask.reduce((sum, r) => sum + r.costCents, 0) / forTask.length

      candidates.push({ providerId, successRate, avgDuration, avgCost })
    }

    if (candidates.length === 0) return undefined

    // Sort: highest success rate, then lowest duration, then lowest cost
    candidates.sort((a, b) => {
      if (b.successRate !== a.successRate) return b.successRate - a.successRate
      if (a.avgDuration !== b.avgDuration) return a.avgDuration - b.avgDuration
      return a.avgCost - b.avgCost
    })

    return candidates[0]!.providerId
  }

  /** Detect failure patterns for a provider within the failure window */
  detectFailurePatterns(
    providerId: AdapterProviderId,
    tenantId?: string,
  ): FailurePattern[] {
    this.warnMissingTenantIdForRouting(tenantId)
    const normalizedTenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID)
    const buffer = this.records.get(scopedProviderKey(providerId, normalizedTenantId))
    if (!buffer) return []

    const now = Date.now()
    const windowStart = now - this.failureWindowMs
    const all = buffer.toArray()
    const recentFailures = all.filter(
      (r) => !r.success && r.timestamp >= windowStart && r.errorType,
    )

    // Group by error type
    const grouped = new Map<string, ExecutionRecord[]>()
    for (const rec of recentFailures) {
      const errorType = rec.errorType!
      let group = grouped.get(errorType)
      if (!group) {
        group = []
        grouped.set(errorType, group)
      }
      group.push(rec)
    }

    const patterns: FailurePattern[] = []
    for (const [errorType, records] of grouped) {
      if (records.length < MIN_FAILURE_PATTERN_FREQUENCY) continue

      const sorted = records.sort((a, b) => a.timestamp - b.timestamp)
      const suggestion = this.buildRecoverySuggestion(providerId, errorType, normalizedTenantId)

      patterns.push({
        patternId: `${normalizedTenantId}:${providerId}:${errorType}:${sorted[0]!.timestamp}`,
        tenantId: normalizedTenantId,
        providerId,
        errorType,
        frequency: records.length,
        firstSeen: new Date(sorted[0]!.timestamp),
        lastSeen: new Date(sorted[sorted.length - 1]!.timestamp),
        suggestedAction: suggestion,
      })
    }

    return patterns
  }

  /** Get recovery suggestion for a specific failure */
  suggestRecovery(
    providerId: AdapterProviderId,
    errorType: string,
    tenantId = DEFAULT_TENANT_ID,
  ): RecoverySuggestion | undefined {
    const normalizedTenantId = normalizeTenantId(tenantId)
    const buffer = this.records.get(scopedProviderKey(providerId, normalizedTenantId))
    if (!buffer) return undefined

    const all = buffer.toArray()
    const hasError = all.some((r) => !r.success && r.errorType === errorType)
    if (!hasError) return undefined

    return this.buildRecoverySuggestion(providerId, errorType, normalizedTenantId)
  }

  /** Export all data as JSON (for persistence) */
  exportData(tenantId = DEFAULT_TENANT_ID): Record<string, ExecutionRecord[]> {
    const normalizedTenantId = normalizeTenantId(tenantId)
    const result: Record<string, ExecutionRecord[]> = {}
    for (const [key, buffer] of this.records) {
      if (tenantIdFromScopedKey(key) !== normalizedTenantId) continue
      result[providerIdFromScopedKey(key)] = buffer.toArray()
    }
    return result
  }

  /** Import data (from persistence) */
  importData(data: Record<string, ExecutionRecord[]>, tenantId = DEFAULT_TENANT_ID): void {
    const normalizedTenantId = normalizeTenantId(tenantId)
    for (const [providerId, records] of Object.entries(data)) {
      const id = providerId as AdapterProviderId
      const scopedKey = scopedProviderKey(id, normalizedTenantId)
      let buffer = this.records.get(scopedKey)
      if (!buffer) {
        buffer = new RingBuffer<ExecutionRecord>(this.maxRecordsPerProvider)
        this.records.set(scopedKey, buffer)
      }
      for (const record of records) {
        buffer.push({ ...record, tenantId: normalizeTenantId(record.tenantId ?? normalizedTenantId) })
      }
    }
  }

  /** Clear all records */
  reset(): void {
    this.records.clear()
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private computeProfile(
    providerId: AdapterProviderId,
    records: ExecutionRecord[],
    tenantId: string,
  ): ProviderProfile {
    const total = records.length
    if (total === 0) {
      return {
        tenantId,
        providerId,
        totalExecutions: 0,
        successRate: 0,
        avgDurationMs: 0,
        avgCostCents: 0,
        avgQualityScore: 0,
        specialties: [],
        weaknesses: [],
        trend: 'stable',
      }
    }

    const successes = records.filter((r) => r.success).length
    const successRate = successes / total
    const avgDurationMs = records.reduce((s, r) => s + r.durationMs, 0) / total
    const avgCostCents = records.reduce((s, r) => s + r.costCents, 0) / total

    const withQuality = records.filter((r) => r.qualityScore !== undefined)
    const avgQualityScore = withQuality.length > 0
      ? withQuality.reduce((s, r) => s + r.qualityScore!, 0) / withQuality.length
      : 0

    // Compute per-task-type success rates for specialties/weaknesses
    const taskGroups = new Map<string, { success: number; total: number }>()
    for (const rec of records) {
      let group = taskGroups.get(rec.taskType)
      if (!group) {
        group = { success: 0, total: 0 }
        taskGroups.set(rec.taskType, group)
      }
      group.total++
      if (rec.success) group.success++
    }

    const specialties: string[] = []
    const weaknesses: string[] = []
    for (const [taskType, group] of taskGroups) {
      if (group.total < SPECIALTY_MIN_SAMPLES) continue
      const rate = group.success / group.total
      if (rate > SPECIALTY_THRESHOLD) specialties.push(taskType)
      if (rate < WEAKNESS_THRESHOLD) weaknesses.push(taskType)
    }

    // Trend: compare last 20% vs first 80%
    const trend = this.computeTrend(records)

    return {
      tenantId,
      providerId,
      totalExecutions: total,
      successRate,
      avgDurationMs,
      avgCostCents,
      avgQualityScore,
      specialties,
      weaknesses,
      trend,
    }
  }

  private computeTrend(records: ExecutionRecord[]): 'improving' | 'stable' | 'degrading' {
    if (records.length < this.minSampleSize) return 'stable'

    const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp)
    const splitIndex = Math.floor(sorted.length * TREND_SPLIT_RATIO)
    const early = sorted.slice(0, splitIndex)
    const recent = sorted.slice(splitIndex)

    if (early.length === 0 || recent.length === 0) return 'stable'

    const earlyRate = early.filter((r) => r.success).length / early.length
    const recentRate = recent.filter((r) => r.success).length / recent.length
    const diff = recentRate - earlyRate

    if (diff > TREND_THRESHOLD) return 'improving'
    if (diff < -TREND_THRESHOLD) return 'degrading'
    return 'stable'
  }

  private buildRecoverySuggestion(
    providerId: AdapterProviderId,
    errorType: string,
    tenantId: string,
  ): RecoverySuggestion {
    switch (errorType) {
      case 'rate_limit':
        {
          const targetProvider = this.pickAlternativeProvider(providerId, 'reliability', tenantId)
          if (targetProvider) {
            return {
              action: 'switch-provider',
              targetProvider,
              reason: `Provider "${providerId}" is rate-limited; switching to ${targetProvider}`,
            }
          }

          return {
            action: 'retry',
            backoffMs: 1000,
            reason: `Provider "${providerId}" is rate-limited; no observed alternative providers available, retrying with backoff`,
          }
        }
      case 'timeout':
        return {
          action: 'increase-budget',
          multiplier: 2,
          reason: `Provider "${providerId}" timed out; doubling budget to allow more time`,
        }
      case 'context_too_long':
        return {
          action: 'switch-provider',
          targetProvider: 'gemini',
          reason: 'Context exceeds provider limits; switching to Gemini for larger context window',
        }
      case 'quality_low':
        {
          const targetProvider = this.pickAlternativeProvider(providerId, 'quality', tenantId)
          if (targetProvider) {
            return {
              action: 'switch-provider',
              targetProvider,
              reason: `Quality below threshold for "${providerId}"; switching to ${targetProvider}`,
            }
          }

          return {
            action: 'retry',
            backoffMs: 1000,
            reason: `Quality below threshold for "${providerId}"; no observed alternative providers available, retrying with backoff`,
          }
        }
      default:
        return {
          action: 'retry',
          backoffMs: 1000,
          reason: `Unknown error type "${errorType}"; retrying with backoff`,
        }
    }
  }

  /**
   * Pick an alternative provider from observed data.
   * Prefers providers that are already tracked with stronger execution signals.
   */
  private pickAlternativeProvider(
    excludeId: AdapterProviderId,
    preference: 'reliability' | 'quality' = 'reliability',
    tenantId = DEFAULT_TENANT_ID,
  ): AdapterProviderId | undefined {
    const candidates = this.getAllProfiles(tenantId)
      .filter((profile) => profile.providerId !== excludeId && profile.totalExecutions > 0)
      .sort((a, b) => {
        if (preference === 'quality' && a.avgQualityScore !== b.avgQualityScore) {
          return b.avgQualityScore - a.avgQualityScore
        }

        if (preference === 'reliability' && a.successRate !== b.successRate) {
          return b.successRate - a.successRate
        }

        if (a.successRate !== b.successRate) {
          return b.successRate - a.successRate
        }

        if (a.avgQualityScore !== b.avgQualityScore) {
          return b.avgQualityScore - a.avgQualityScore
        }

        if (a.avgDurationMs !== b.avgDurationMs) {
          return a.avgDurationMs - b.avgDurationMs
        }

        if (a.avgCostCents !== b.avgCostCents) {
          return a.avgCostCents - b.avgCostCents
        }

        return a.providerId.localeCompare(b.providerId)
      })

    return candidates[0]?.providerId
  }
}

// ---------------------------------------------------------------------------
// ExecutionAnalyzer
// ---------------------------------------------------------------------------

export class ExecutionAnalyzer {
  constructor(private readonly learningLoop: AdapterLearningLoop) {}

  /** Generate performance report across all providers */
  generateReport(): PerformanceReport {
    const profiles = this.learningLoop.getAllProfiles()
    const totalExecutions = profiles.reduce((s, p) => s + p.totalExecutions, 0)

    const overallSuccessRate = totalExecutions > 0
      ? profiles.reduce((s, p) => s + p.successRate * p.totalExecutions, 0) / totalExecutions
      : 0

    const avgCostPerExecution = totalExecutions > 0
      ? profiles.reduce((s, p) => s + p.avgCostCents * p.totalExecutions, 0) / totalExecutions
      : 0

    // Collect all active failure patterns
    const allPatterns: FailurePattern[] = []
    for (const profile of profiles) {
      const patterns = this.learningLoop.detectFailurePatterns(profile.providerId)
      allPatterns.push(...patterns)
    }

    const recommendations = this.buildRecommendations(profiles, allPatterns)

    return {
      generatedAt: new Date(),
      totalExecutions,
      overallSuccessRate,
      avgCostPerExecution,
      providers: profiles,
      activeFailurePatterns: allPatterns,
      recommendations,
    }
  }

  /** Compare two providers for a specific task type */
  compareProviders(
    providerA: AdapterProviderId,
    providerB: AdapterProviderId,
    taskType?: string,
  ): ProviderComparison {
    const profileA = this.learningLoop.getProfile(providerA)
    const profileB = this.learningLoop.getProfile(providerB)

    // If a task type is specified, compute task-specific stats from exported data
    let statsA = { successRate: profileA.successRate, avgDuration: profileA.avgDurationMs, avgCost: profileA.avgCostCents }
    let statsB = { successRate: profileB.successRate, avgDuration: profileB.avgDurationMs, avgCost: profileB.avgCostCents }

    if (taskType) {
      const data = this.learningLoop.exportData()
      statsA = this.computeTaskStats(data[providerA] ?? [], taskType)
      statsB = this.computeTaskStats(data[providerB] ?? [], taskType)
    }

    // Determine winner: success rate > speed > cost
    let winner: AdapterProviderId | 'tie' = 'tie'
    let reason = 'Both providers perform equally'

    if (statsA.successRate !== statsB.successRate) {
      const diff = Math.abs(statsA.successRate - statsB.successRate)
      if (diff > 0.01) {
        winner = statsA.successRate > statsB.successRate ? providerA : providerB
        reason = `Higher success rate (${(Math.max(statsA.successRate, statsB.successRate) * 100).toFixed(1)}% vs ${(Math.min(statsA.successRate, statsB.successRate) * 100).toFixed(1)}%)`
      }
    }

    if (winner === 'tie' && statsA.avgDuration !== statsB.avgDuration) {
      winner = statsA.avgDuration < statsB.avgDuration ? providerA : providerB
      reason = `Faster average duration (${Math.min(statsA.avgDuration, statsB.avgDuration).toFixed(0)}ms vs ${Math.max(statsA.avgDuration, statsB.avgDuration).toFixed(0)}ms)`
    }

    if (winner === 'tie' && statsA.avgCost !== statsB.avgCost) {
      winner = statsA.avgCost < statsB.avgCost ? providerA : providerB
      reason = `Lower average cost`
    }

    return {
      providerA: { providerId: providerA, ...statsA },
      providerB: { providerId: providerB, ...statsB },
      winner,
      reason,
    }
  }

  /** Identify optimal provider allocation (which provider for which task type) */
  getOptimalAllocation(): Map<string, AdapterProviderId> {
    const allocation = new Map<string, AdapterProviderId>()
    const data = this.learningLoop.exportData()

    // Collect all unique task types across all providers
    const taskTypes = new Set<string>()
    for (const records of Object.values(data)) {
      for (const rec of records) {
        taskTypes.add(rec.taskType)
      }
    }

    const providerIds = Object.keys(data) as AdapterProviderId[]

    for (const taskType of taskTypes) {
      const best = this.learningLoop.getBestProvider(taskType, providerIds)
      if (best) {
        allocation.set(taskType, best)
      }
    }

    return allocation
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private computeTaskStats(
    records: ExecutionRecord[],
    taskType: string,
  ): { successRate: number; avgDuration: number; avgCost: number } {
    const forTask = records.filter((r) => r.taskType === taskType)
    if (forTask.length === 0) {
      return { successRate: 0, avgDuration: 0, avgCost: 0 }
    }

    const successes = forTask.filter((r) => r.success).length
    return {
      successRate: successes / forTask.length,
      avgDuration: forTask.reduce((s, r) => s + r.durationMs, 0) / forTask.length,
      avgCost: forTask.reduce((s, r) => s + r.costCents, 0) / forTask.length,
    }
  }

  private buildRecommendations(profiles: ProviderProfile[], patterns: FailurePattern[]): string[] {
    const recommendations: string[] = []

    // Flag degrading providers
    for (const profile of profiles) {
      if (profile.trend === 'degrading') {
        recommendations.push(
          `Provider "${profile.providerId}" shows degrading performance — consider reducing its routing weight`,
        )
      }
    }

    // Flag providers with low success rate
    for (const profile of profiles) {
      if (profile.totalExecutions >= 10 && profile.successRate < 0.5) {
        recommendations.push(
          `Provider "${profile.providerId}" has a ${(profile.successRate * 100).toFixed(1)}% success rate — consider removing it from the rotation`,
        )
      }
    }

    // Flag active failure patterns
    for (const pattern of patterns) {
      if (pattern.frequency >= 5) {
        recommendations.push(
          `Frequent "${pattern.errorType}" errors on "${pattern.providerId}" (${pattern.frequency}x in window) — ${pattern.suggestedAction.reason}`,
        )
      }
    }

    // Suggest specialization
    for (const profile of profiles) {
      if (profile.specialties.length > 0) {
        recommendations.push(
          `Provider "${profile.providerId}" excels at: ${profile.specialties.join(', ')} — consider prioritizing it for these task types`,
        )
      }
    }

    return recommendations
  }
}
