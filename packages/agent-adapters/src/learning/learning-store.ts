/**
 * Persistent storage backend interface for adapter learning data.
 *
 * Decouples learning data from the in-memory `AdapterLearningLoop` so that
 * execution records, provider profiles, and failure patterns survive process
 * restarts.
 */

import type { ExecutionRecord, ProviderProfile, FailurePattern } from './adapter-learning-loop.js'

// ---------------------------------------------------------------------------
// Snapshot (export / import)
// ---------------------------------------------------------------------------

/** Snapshot for export/import of all learning data. */
export interface LearningSnapshot {
  version: 1
  exportedAt: number
  records: Record<string, ExecutionRecord[]>
  profiles: Record<string, ProviderProfile>
  failurePatterns: Record<string, FailurePattern[]>
}

/**
 * Tenant-aware snapshot format. The outer key is tenantId, the inner key
 * is providerId. v1 snapshots can be migrated via {@link migrateLearningSnapshotV1toV2}.
 */
export interface LearningSnapshotV2 {
  version: 2
  exportedAt: number
  /** tenantId -> providerId -> records */
  records: Record<string, Record<string, ExecutionRecord[]>>
  /** tenantId -> providerId -> profile */
  profiles: Record<string, Record<string, ProviderProfile>>
  /** tenantId -> providerId -> failure patterns */
  failurePatterns: Record<string, Record<string, FailurePattern[]>>
}

const DEFAULT_TENANT_ID = 'default'

/**
 * Split a v1 scoped key of the form `tenantId:providerId` into its parts.
 * If no colon is present, the key is interpreted as a bare providerId
 * belonging to the legacy/default tenant.
 */
function splitScopedKey(key: string): { tenantId: string; providerId: string } {
  const separatorIndex = key.indexOf(':')
  if (separatorIndex === -1) {
    return { tenantId: DEFAULT_TENANT_ID, providerId: key }
  }
  return {
    tenantId: key.slice(0, separatorIndex),
    providerId: key.slice(separatorIndex + 1),
  }
}

/**
 * Migrate a v1 snapshot to v2. Since v1 keys are either bare `providerId`
 * (legacy global scope) or `tenantId:providerId`, bare keys are assigned
 * to `legacyTenantId`. Already-scoped keys retain their tenant.
 *
 * @param snapshot - The v1 snapshot to migrate.
 * @param legacyTenantId - The tenantId to assign to all bare/legacy keys.
 *   Required to make the implicit global scope explicit.
 */
export function migrateLearningSnapshotV1toV2(
  snapshot: LearningSnapshot,
  legacyTenantId: string,
): LearningSnapshotV2 {
  if (!legacyTenantId || legacyTenantId.length === 0) {
    throw new Error('migrateLearningSnapshotV1toV2: legacyTenantId is required and must be non-empty')
  }

  const records: Record<string, Record<string, ExecutionRecord[]>> = {}
  const profiles: Record<string, Record<string, ProviderProfile>> = {}
  const failurePatterns: Record<string, Record<string, FailurePattern[]>> = {}

  const resolveTenant = (rawTenantId: string): string =>
    rawTenantId === DEFAULT_TENANT_ID ? legacyTenantId : rawTenantId

  for (const [scopedKey, value] of Object.entries(snapshot.records)) {
    const { tenantId: rawTenantId, providerId } = splitScopedKey(scopedKey)
    const tenantId = resolveTenant(rawTenantId)
    const bucket = records[tenantId] ?? (records[tenantId] = {})
    bucket[providerId] = [...value]
  }

  for (const [scopedKey, value] of Object.entries(snapshot.profiles)) {
    const { tenantId: rawTenantId, providerId } = splitScopedKey(scopedKey)
    const tenantId = resolveTenant(rawTenantId)
    const bucket = profiles[tenantId] ?? (profiles[tenantId] = {})
    bucket[providerId] = { ...value, tenantId }
  }

  for (const [scopedKey, value] of Object.entries(snapshot.failurePatterns)) {
    const { tenantId: rawTenantId, providerId } = splitScopedKey(scopedKey)
    const tenantId = resolveTenant(rawTenantId)
    const bucket = failurePatterns[tenantId] ?? (failurePatterns[tenantId] = {})
    bucket[providerId] = value.map((pattern) => ({ ...pattern, tenantId }))
  }

  return {
    version: 2,
    exportedAt: snapshot.exportedAt,
    records,
    profiles,
    failurePatterns,
  }
}

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

/** Persistent storage backend for learning data. */
export interface LearningStore {
  /** Append an execution record for a provider. */
  saveRecord(providerId: string, record: ExecutionRecord, tenantId?: string): void

  /** Load the most recent `limit` records for a provider (oldest-first). */
  loadRecords(providerId: string, limit: number, tenantId?: string): ExecutionRecord[]

  /** Upsert a computed provider profile. */
  saveProfile(providerId: string, profile: ProviderProfile, tenantId?: string): void

  /** Retrieve the stored profile for a provider, if any. */
  getProfile(providerId: string, tenantId?: string): ProviderProfile | undefined

  /** Replace stored failure patterns for a provider. */
  saveFailurePatterns(providerId: string, patterns: FailurePattern[], tenantId?: string): void

  /** Retrieve stored failure patterns for a provider. */
  getFailurePatterns(providerId: string, tenantId?: string): FailurePattern[]

  /** Export all data as a portable snapshot. */
  exportAll(): LearningSnapshot

  /** Import a snapshot, replacing current data. */
  importAll(snapshot: LearningSnapshot): void

  /** Remove old records, keeping at most `maxRecordsPerProvider` per provider. */
  compact(maxRecordsPerProvider: number): { removedCount: number }

  /** Release resources (timers, file handles, etc.). */
  dispose(): void
}
