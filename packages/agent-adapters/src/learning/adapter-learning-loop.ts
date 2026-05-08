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
import type {
  ExecutionRecord,
  FailurePattern,
  LearningConfig,
  ProviderProfile,
  RecoverySuggestion,
} from './learning-types.js'
import {
  DEFAULT_FAILURE_WINDOW_MS,
  DEFAULT_MAX_RECORDS,
  DEFAULT_MIN_SAMPLE_SIZE,
  DEFAULT_TENANT_ID,
  MIN_FAILURE_PATTERN_FREQUENCY,
  RingBuffer,
  SPECIALTY_MIN_SAMPLES,
  SPECIALTY_THRESHOLD,
  TREND_SPLIT_RATIO,
  TREND_THRESHOLD,
  WEAKNESS_THRESHOLD,
  buildRecoverySuggestion,
  normalizeTenantId,
  pickAlternativeFromProfiles,
  providerIdFromScopedKey,
  scopedProviderKey,
  tenantIdFromScopedKey,
} from './learning-internals.js'

// Re-export public API for backwards compatibility.
export type {
  ExecutionRecord,
  ProviderProfile,
  FailurePattern,
  RecoverySuggestion,
  LearningConfig,
  PerformanceReport,
  ProviderComparison,
} from './learning-types.js'
export { ExecutionAnalyzer } from './execution-analyzer.js'

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

  /** Warn if routing/profile lookup omits tenantId and records exist (cross-tenant contamination risk). */
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
    return this.computeProfile(providerId, buffer?.toArray() ?? [], normalizedTenantId)
  }

  /** Aggregate profile across all tenants — for ops dashboards only. Never use for routing decisions. */
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
      profiles.push(this.getProfile(providerIdFromScopedKey(key), normalizedTenantId))
    }
    return profiles
  }

  /**
   * Find the best provider for a task type based on historical data.
   * Filters by minSampleSize, then highest success rate; ties broken by speed, then cost.
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

      const forTask = buffer.toArray().filter((r) => r.taskType === taskType)
      if (forTask.length < this.minSampleSize) continue

      const successes = forTask.filter((r) => r.success).length
      candidates.push({
        providerId,
        successRate: successes / forTask.length,
        avgDuration: forTask.reduce((sum, r) => sum + r.durationMs, 0) / forTask.length,
        avgCost: forTask.reduce((sum, r) => sum + r.costCents, 0) / forTask.length,
      })
    }

    if (candidates.length === 0) return undefined

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

    const windowStart = Date.now() - this.failureWindowMs
    const recentFailures = buffer
      .toArray()
      .filter((r) => !r.success && r.timestamp >= windowStart && r.errorType)

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
      const suggestion = buildRecoverySuggestion(providerId, errorType, (preference) =>
        this.pickAlternativeProvider(providerId, preference, normalizedTenantId),
      )

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

    const hasError = buffer.toArray().some((r) => !r.success && r.errorType === errorType)
    if (!hasError) return undefined

    return buildRecoverySuggestion(providerId, errorType, (preference) =>
      this.pickAlternativeProvider(providerId, preference, normalizedTenantId),
    )
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
      trend: this.computeTrend(records),
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

  private pickAlternativeProvider(
    excludeId: AdapterProviderId,
    preference: 'reliability' | 'quality' = 'reliability',
    tenantId = DEFAULT_TENANT_ID,
  ): AdapterProviderId | undefined {
    return pickAlternativeFromProfiles(this.getAllProfiles(tenantId), excludeId, preference)
  }
}
