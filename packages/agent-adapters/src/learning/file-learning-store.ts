/**
 * File-based implementation of {@link LearningStore}.
 *
 * Persists all learning data as a single JSON file on disk.
 * Writes are debounced via a periodic flush timer so that frequent
 * `saveRecord` calls don't hammer the filesystem.
 *
 * Suitable for development and single-process deployments.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import type { ExecutionRecord, ProviderProfile, FailurePattern } from './adapter-learning-loop.js'
import type { LearningStore, LearningSnapshot } from './learning-store.js'

const EMPTY_SNAPSHOT: LearningSnapshot = Object.freeze({
  version: 1 as const,
  exportedAt: 0,
  records: {},
  profiles: {},
  failurePatterns: {},
})

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

export class FileLearningStore implements LearningStore {
  private data: LearningSnapshot
  private dirty = false
  private flushTimer?: ReturnType<typeof setInterval>

  constructor(
    private readonly filePath: string,
    private readonly flushIntervalMs: number = 5_000,
  ) {
    this.data = this.load()
    this.scheduleFlush()
  }

  // -----------------------------------------------------------------------
  // Records
  // -----------------------------------------------------------------------

  saveRecord(providerId: string, record: ExecutionRecord, tenantId?: string): void {
    const explicitTenant = tenantId !== undefined || record.tenantId != null
    const normalizedTenantId = normalizeTenantId(tenantId ?? record.tenantId)
    const key = scopedKey(providerId, normalizedTenantId)
    if (!this.data.records[key]) {
      this.data.records[key] = []
    }
    this.data.records[key].push(withTenant(record, normalizedTenantId, explicitTenant))
    this.dirty = true
  }

  loadRecords(providerId: string, limit: number, tenantId?: string): ExecutionRecord[] {
    const arr = this.data.records[scopedKey(providerId, normalizeTenantId(tenantId))] ?? []
    return arr.slice(-limit)
  }

  // -----------------------------------------------------------------------
  // Profiles
  // -----------------------------------------------------------------------

  saveProfile(providerId: string, profile: ProviderProfile, tenantId?: string): void {
    const explicitTenant = tenantId !== undefined || profile.tenantId != null
    const normalizedTenantId = normalizeTenantId(tenantId ?? profile.tenantId)
    this.data.profiles[scopedKey(providerId, normalizedTenantId)] = withTenant(
      profile,
      normalizedTenantId,
      explicitTenant,
    )
    this.dirty = true
  }

  getProfile(providerId: string, tenantId?: string): ProviderProfile | undefined {
    return this.data.profiles[scopedKey(providerId, normalizeTenantId(tenantId))]
  }

  // -----------------------------------------------------------------------
  // Failure patterns
  // -----------------------------------------------------------------------

  saveFailurePatterns(providerId: string, patterns: FailurePattern[], tenantId?: string): void {
    const explicitTenant = tenantId !== undefined || patterns.some((pattern) => pattern.tenantId != null)
    const normalizedTenantId = normalizeTenantId(tenantId ?? patterns[0]?.tenantId)
    this.data.failurePatterns[scopedKey(providerId, normalizedTenantId)] = patterns.map((pattern) =>
      withTenant(pattern, normalizedTenantId, explicitTenant),
    )
    this.dirty = true
  }

  getFailurePatterns(providerId: string, tenantId?: string): FailurePattern[] {
    return this.data.failurePatterns[scopedKey(providerId, normalizeTenantId(tenantId))] ?? []
  }

  // -----------------------------------------------------------------------
  // Export / Import
  // -----------------------------------------------------------------------

  exportAll(): LearningSnapshot {
    return {
      version: 1,
      exportedAt: Date.now(),
      records: { ...this.data.records },
      profiles: { ...this.data.profiles },
      failurePatterns: { ...this.data.failurePatterns },
    }
  }

  importAll(snapshot: LearningSnapshot): void {
    this.data = {
      version: 1,
      exportedAt: snapshot.exportedAt,
      records: { ...snapshot.records },
      profiles: { ...snapshot.profiles },
      failurePatterns: { ...snapshot.failurePatterns },
    }
    this.dirty = true
  }

  // -----------------------------------------------------------------------
  // Compaction
  // -----------------------------------------------------------------------

  compact(maxRecordsPerProvider: number): { removedCount: number } {
    let removedCount = 0
    for (const [id, arr] of Object.entries(this.data.records)) {
      if (arr && arr.length > maxRecordsPerProvider) {
        const excess = arr.length - maxRecordsPerProvider
        this.data.records[id] = arr.slice(excess)
        removedCount += excess
      }
    }
    if (removedCount > 0) this.dirty = true
    return { removedCount }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  dispose(): void {
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.dirty) this.flush()
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private load(): LearningSnapshot {
    if (existsSync(this.filePath)) {
      try {
        const raw = readFileSync(this.filePath, 'utf-8')
        const parsed: unknown = JSON.parse(raw)

        // Basic shape validation
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'version' in parsed &&
          (parsed as LearningSnapshot).version === 1
        ) {
          return parsed as LearningSnapshot
        }
      } catch {
        // Corrupted or unparseable file — start fresh
      }
    }
    return { ...EMPTY_SNAPSHOT, records: {}, profiles: {}, failurePatterns: {} }
  }

  private scheduleFlush(): void {
    this.flushTimer = setInterval(() => {
      if (this.dirty) this.flush()
    }, this.flushIntervalMs)
    // Allow the Node.js process to exit even if the timer is still active
    if (typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref()
    }
  }

  private flush(): void {
    this.data.exportedAt = Date.now()
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
    this.dirty = false
  }
}
