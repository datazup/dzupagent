/**
 * In-memory implementation of {@link LearningStore}.
 *
 * Uses plain arrays with a configurable per-provider capacity.
 * No persistence across restarts — useful for tests or short-lived processes.
 */

import type { ExecutionRecord, ProviderProfile, FailurePattern } from './adapter-learning-loop.js'
import type { LearningStore, LearningSnapshot } from './learning-store.js'

const DEFAULT_TENANT_ID = 'default'

function normalizeTenantId(tenantId: string | null | undefined): string {
  return tenantId && tenantId.length > 0 ? tenantId : DEFAULT_TENANT_ID
}

function scopedKey(providerId: string, tenantId: string): string {
  return tenantId === DEFAULT_TENANT_ID ? providerId : `${tenantId}:${providerId}`
}

function withTenant<T extends { tenantId?: string | null }>(
  value: T,
  tenantId: string,
  wasExplicit: boolean,
): T {
  return wasExplicit || tenantId !== DEFAULT_TENANT_ID ? { ...value, tenantId } : value
}

export class InMemoryLearningStore implements LearningStore {
  private readonly records = new Map<string, ExecutionRecord[]>()
  private readonly profiles = new Map<string, ProviderProfile>()
  private readonly patterns = new Map<string, FailurePattern[]>()
  private readonly capacityPerProvider: number

  constructor(capacityPerProvider: number = 500) {
    this.capacityPerProvider = capacityPerProvider
  }

  // -----------------------------------------------------------------------
  // Records
  // -----------------------------------------------------------------------

  saveRecord(providerId: string, record: ExecutionRecord, tenantId?: string): void {
    const explicitTenant = tenantId !== undefined || record.tenantId != null
    const normalizedTenantId = normalizeTenantId(tenantId ?? record.tenantId)
    const key = scopedKey(providerId, normalizedTenantId)
    const arr = this.records.get(key) ?? []
    arr.push(withTenant(record, normalizedTenantId, explicitTenant))
    while (arr.length > this.capacityPerProvider) arr.shift()
    this.records.set(key, arr)
  }

  loadRecords(providerId: string, limit: number, tenantId?: string): ExecutionRecord[] {
    const arr = this.records.get(scopedKey(providerId, normalizeTenantId(tenantId))) ?? []
    return arr.slice(-limit)
  }

  // -----------------------------------------------------------------------
  // Profiles
  // -----------------------------------------------------------------------

  saveProfile(providerId: string, profile: ProviderProfile, tenantId?: string): void {
    const explicitTenant = tenantId !== undefined || profile.tenantId != null
    const normalizedTenantId = normalizeTenantId(tenantId ?? profile.tenantId)
    this.profiles.set(scopedKey(providerId, normalizedTenantId), withTenant(
      profile,
      normalizedTenantId,
      explicitTenant,
    ))
  }

  getProfile(providerId: string, tenantId?: string): ProviderProfile | undefined {
    return this.profiles.get(scopedKey(providerId, normalizeTenantId(tenantId)))
  }

  // -----------------------------------------------------------------------
  // Failure patterns
  // -----------------------------------------------------------------------

  saveFailurePatterns(providerId: string, patterns: FailurePattern[], tenantId?: string): void {
    const explicitTenant = tenantId !== undefined || patterns.some((pattern) => pattern.tenantId != null)
    const normalizedTenantId = normalizeTenantId(tenantId ?? patterns[0]?.tenantId)
    this.patterns.set(scopedKey(providerId, normalizedTenantId), patterns.map((pattern) =>
      withTenant(pattern, normalizedTenantId, explicitTenant),
    ))
  }

  getFailurePatterns(providerId: string, tenantId?: string): FailurePattern[] {
    return this.patterns.get(scopedKey(providerId, normalizeTenantId(tenantId))) ?? []
  }

  // -----------------------------------------------------------------------
  // Export / Import
  // -----------------------------------------------------------------------

  exportAll(): LearningSnapshot {
    const records: Record<string, ExecutionRecord[]> = {}
    for (const [id, arr] of this.records) {
      records[id] = [...arr]
    }

    const profiles: Record<string, ProviderProfile> = {}
    for (const [id, profile] of this.profiles) {
      profiles[id] = profile
    }

    const failurePatterns: Record<string, FailurePattern[]> = {}
    for (const [id, pats] of this.patterns) {
      failurePatterns[id] = [...pats]
    }

    return {
      version: 1,
      exportedAt: Date.now(),
      records,
      profiles,
      failurePatterns,
    }
  }

  importAll(snapshot: LearningSnapshot): void {
    this.records.clear()
    this.profiles.clear()
    this.patterns.clear()

    for (const [id, arr] of Object.entries(snapshot.records)) {
      this.records.set(id, [...arr])
    }

    for (const [id, profile] of Object.entries(snapshot.profiles)) {
      this.profiles.set(id, profile)
    }

    for (const [id, pats] of Object.entries(snapshot.failurePatterns)) {
      this.patterns.set(id, [...pats])
    }
  }

  // -----------------------------------------------------------------------
  // Compaction
  // -----------------------------------------------------------------------

  compact(maxRecordsPerProvider: number): { removedCount: number } {
    let removedCount = 0
    for (const [id, arr] of this.records) {
      if (arr.length > maxRecordsPerProvider) {
        const excess = arr.length - maxRecordsPerProvider
        arr.splice(0, excess)
        removedCount += excess
        this.records.set(id, arr)
      }
    }
    return { removedCount }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  dispose(): void {
    // No-op for in-memory store.
  }
}
