/**
 * Internal helpers used by {@link AdapterLearningLoop}.
 * Not part of the public API — split out to keep the loop module focused.
 */

import type { AdapterProviderId } from '../types.js'
import type { ProviderProfile, RecoverySuggestion } from './learning-types.js'

// ---------------------------------------------------------------------------
// Ring buffer (capped circular storage)
// ---------------------------------------------------------------------------

export class RingBuffer<T> {
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

export const DEFAULT_MAX_RECORDS = 500
export const DEFAULT_FAILURE_WINDOW_MS = 3_600_000 // 1 hour
export const DEFAULT_MIN_SAMPLE_SIZE = 10
export const MIN_FAILURE_PATTERN_FREQUENCY = 3
export const SPECIALTY_THRESHOLD = 0.8
export const WEAKNESS_THRESHOLD = 0.5
export const SPECIALTY_MIN_SAMPLES = 5
export const TREND_SPLIT_RATIO = 0.8
export const TREND_THRESHOLD = 0.05
export const DEFAULT_TENANT_ID = 'default'

// ---------------------------------------------------------------------------
// Tenant-scoped key helpers
// ---------------------------------------------------------------------------

export function normalizeTenantId(tenantId: string | null | undefined): string {
  return tenantId && tenantId.length > 0 ? tenantId : DEFAULT_TENANT_ID
}

export function scopedProviderKey(providerId: AdapterProviderId, tenantId: string): string {
  return tenantId === DEFAULT_TENANT_ID ? providerId : `${tenantId}:${providerId}`
}

export function providerIdFromScopedKey(key: string): AdapterProviderId {
  const separatorIndex = key.indexOf(':')
  return (separatorIndex === -1 ? key : key.slice(separatorIndex + 1)) as AdapterProviderId
}

export function tenantIdFromScopedKey(key: string): string {
  const separatorIndex = key.indexOf(':')
  return separatorIndex === -1 ? DEFAULT_TENANT_ID : key.slice(0, separatorIndex)
}

// ---------------------------------------------------------------------------
// Recovery suggestion builder
// ---------------------------------------------------------------------------

export function buildRecoverySuggestion(
  providerId: AdapterProviderId,
  errorType: string,
  pickAlternative: (preference: 'reliability' | 'quality') => AdapterProviderId | undefined,
): RecoverySuggestion {
  switch (errorType) {
    case 'rate_limit': {
      const targetProvider = pickAlternative('reliability')
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
    case 'quality_low': {
      const targetProvider = pickAlternative('quality')
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

// ---------------------------------------------------------------------------
// Alternative provider picker
// ---------------------------------------------------------------------------

/**
 * Pick an alternative provider from observed profiles.
 * Prefers providers already tracked with stronger execution signals.
 */
export function pickAlternativeFromProfiles(
  profiles: ProviderProfile[],
  excludeId: AdapterProviderId,
  preference: 'reliability' | 'quality' = 'reliability',
): AdapterProviderId | undefined {
  const candidates = profiles
    .filter((profile) => profile.providerId !== excludeId && profile.totalExecutions > 0)
    .sort((a, b) => {
      if (preference === 'quality' && a.avgQualityScore !== b.avgQualityScore) {
        return b.avgQualityScore - a.avgQualityScore
      }
      if (preference === 'reliability' && a.successRate !== b.successRate) {
        return b.successRate - a.successRate
      }
      if (a.successRate !== b.successRate) return b.successRate - a.successRate
      if (a.avgQualityScore !== b.avgQualityScore) return b.avgQualityScore - a.avgQualityScore
      if (a.avgDurationMs !== b.avgDurationMs) return a.avgDurationMs - b.avgDurationMs
      if (a.avgCostCents !== b.avgCostCents) return a.avgCostCents - b.avgCostCents
      return a.providerId.localeCompare(b.providerId)
    })

  return candidates[0]?.providerId
}
