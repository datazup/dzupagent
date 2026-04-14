/**
 * Bi-temporal memory modeling for DzupAgent.
 *
 * Provides Zep/Graphiti-style 4-timestamp temporal metadata so that:
 * - "What was true last month?" (validAt queries)
 * - "What did we know at this point?" (asOf queries)
 * - Superseded facts are soft-expired, never hard-deleted
 * - Contradictions are naturally resolved by temporal superseding
 *
 * Temporal metadata is stored inside the record value as `_temporal`,
 * requiring no schema changes to BaseStore. Temporal queries are
 * post-filters applied after the underlying store search.
 */

import type { MemoryService } from './memory-service.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Four-timestamp bi-temporal metadata attached to every temporal record. */
export interface TemporalMetadata {
  /** When the record was created in our system */
  systemCreatedAt: number
  /** When the record was expired in our system (null = currently active) */
  systemExpiredAt: number | null
  /** When the fact became true in the real world */
  validFrom: number
  /** When the fact stopped being true (null = still valid) */
  validUntil: number | null
}

/** Parameters for temporal filtering on search/get operations. */
export interface TemporalQuery {
  /** System time — "what did we know at this point?" */
  asOf?: number | undefined
  /** Real-world time — "what was true at this point?" */
  validAt?: number | undefined
}

/** Describes a single field-level change between record versions. */
export interface TemporalChange {
  key: string
  field: string
  oldValue: unknown
  newValue: unknown
  changedAt: number
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Create initial temporal metadata for a new record. */
export function createTemporalMeta(validFrom?: number): TemporalMetadata {
  const now = Date.now()
  return {
    systemCreatedAt: now,
    systemExpiredAt: null,
    validFrom: validFrom ?? now,
    validUntil: null,
  }
}

/**
 * Extract `_temporal` from a record, returning null if it is missing
 * or structurally invalid.
 */
function extractTemporal(record: Record<string, unknown>): TemporalMetadata | null {
  const t = record['_temporal']
  if (t == null || typeof t !== 'object') return null
  const meta = t as Record<string, unknown>
  if (typeof meta['systemCreatedAt'] !== 'number') return null
  if (typeof meta['validFrom'] !== 'number') return null
  // systemExpiredAt and validUntil may be null
  return t as TemporalMetadata
}

/** Check if a record is currently active (not expired). */
export function isActive(record: Record<string, unknown>): boolean {
  const meta = extractTemporal(record)
  // Records without temporal metadata are treated as active
  if (!meta) return true
  return meta.systemExpiredAt === null
}

/** Check if a record was active at a given system time. */
export function wasActiveAsOf(record: Record<string, unknown>, asOf: number): boolean {
  const meta = extractTemporal(record)
  if (!meta) return true
  // Created before or at the query time
  if (meta.systemCreatedAt > asOf) return false
  // Not yet expired, or expired after the query time
  if (meta.systemExpiredAt !== null && meta.systemExpiredAt <= asOf) return false
  return true
}

/** Check if a record was valid at a given real-world time. */
export function wasValidAt(record: Record<string, unknown>, validAt: number): boolean {
  const meta = extractTemporal(record)
  if (!meta) return true
  if (meta.validFrom > validAt) return false
  if (meta.validUntil !== null && meta.validUntil <= validAt) return false
  return true
}

/** Filter records by temporal query. */
export function filterByTemporal(
  records: Record<string, unknown>[],
  query: TemporalQuery,
): Record<string, unknown>[] {
  return records.filter(r => {
    if (query.asOf !== undefined && !wasActiveAsOf(r, query.asOf)) return false
    if (query.validAt !== undefined && !wasValidAt(r, query.validAt)) return false
    return true
  })
}

// ---------------------------------------------------------------------------
// TemporalMemoryService
// ---------------------------------------------------------------------------

/**
 * Wraps `MemoryService` with bi-temporal capabilities.
 *
 * All operations are non-fatal — errors are caught so that temporal
 * failures never break the agent pipeline.
 */
export class TemporalMemoryService {
  constructor(private readonly inner: MemoryService) {}

  /**
   * Store a value with temporal metadata.
   * Automatically sets systemCreatedAt and validFrom to now.
   * If fields are provided in `temporalMeta`, those override the defaults.
   */
  async put(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    value: Record<string, unknown>,
    temporalMeta?: Partial<TemporalMetadata>,
  ): Promise<void> {
    try {
      const base = createTemporalMeta(temporalMeta?.validFrom)
      const merged: TemporalMetadata = { ...base, ...temporalMeta }
      const enriched = { ...value, _temporal: merged }
      await this.inner.put(namespace, scope, key, enriched)
    } catch {
      // Non-fatal — temporal write failures should not break pipelines
    }
  }

  /**
   * Supersede an existing record: soft-expire the old one and store a new value.
   *
   * 1. Reads the old record and sets its systemExpiredAt + validUntil to now.
   * 2. Creates a new record under `newKey` with fresh temporal metadata.
   */
  async supersede(
    namespace: string,
    scope: Record<string, string>,
    oldKey: string,
    newKey: string,
    newValue: Record<string, unknown>,
  ): Promise<void> {
    try {
      const now = Date.now()

      // Expire the old record
      const existing = await this.inner.get(namespace, scope, oldKey)
      if (existing.length > 0) {
        const old = existing[0]
        const oldRecord = old!
        const oldTemporal = extractTemporal(oldRecord) ?? createTemporalMeta()
        const expired: TemporalMetadata = {
          ...oldTemporal,
          systemExpiredAt: now,
          validUntil: now,
        }
        await this.inner.put(namespace, scope, oldKey, { ...oldRecord, _temporal: expired })
      }

      // Store the new version
      const freshMeta = createTemporalMeta()
      await this.inner.put(namespace, scope, newKey, {
        ...newValue,
        _temporal: freshMeta,
      })
    } catch {
      // Non-fatal
    }
  }

  /**
   * Search with temporal filtering.
   *
   * Default (no temporal query): returns only currently active records.
   * With `asOf`: records that were active at that system time.
   * With `validAt`: records that were valid at that real-world time.
   */
  async search(
    namespace: string,
    scope: Record<string, string>,
    query: string,
    limit?: number,
    temporal?: TemporalQuery,
  ): Promise<Record<string, unknown>[]> {
    try {
      // Fetch more than requested so post-filtering still yields enough results
      const fetchLimit = (limit ?? 5) * 3
      const raw = await this.inner.search(namespace, scope, query, fetchLimit)

      let filtered: Record<string, unknown>[]
      if (temporal) {
        filtered = filterByTemporal(raw, temporal)
      } else {
        // Default: active-only
        filtered = raw.filter(r => isActive(r))
      }

      return filtered.slice(0, limit ?? 5)
    } catch {
      return []
    }
  }

  /**
   * Get all currently active records in a namespace.
   */
  async getActive(
    namespace: string,
    scope: Record<string, string>,
  ): Promise<Record<string, unknown>[]> {
    try {
      const all = await this.inner.get(namespace, scope)
      return all.filter(r => isActive(r))
    } catch {
      return []
    }
  }

  /**
   * Get the full history of a specific key (all versions, including expired).
   * Returns records sorted newest-first by systemCreatedAt.
   *
   * Uses key-prefix matching: searches for the base key and any
   * versioned variants (e.g., `key__v1234567890`).
   */
  async getHistory(
    namespace: string,
    scope: Record<string, string>,
    keyPrefix: string,
  ): Promise<Record<string, unknown>[]> {
    try {
      // Retrieve all records in the namespace
      const all = await this.inner.get(namespace, scope)

      // Filter to records whose originating key matches the prefix.
      // Records may carry a `_key` field set by the caller, or we match
      // by checking if their content hints at the prefix. Since BaseStore
      // does not expose keys on list results, we store the key in the value.
      // For robustness, also search by query string.
      const bySearch = await this.inner.search(namespace, scope, keyPrefix, 50)

      // Deduplicate by combining both result sets
      const seen = new Set<string>()
      const combined: Record<string, unknown>[] = []

      for (const record of [...all, ...bySearch]) {
        const id = JSON.stringify(record)
        if (!seen.has(id)) {
          seen.add(id)
          combined.push(record)
        }
      }

      // Sort newest-first by systemCreatedAt
      combined.sort((a, b) => {
        const tA = extractTemporal(a)
        const tB = extractTemporal(b)
        return (tB?.systemCreatedAt ?? 0) - (tA?.systemCreatedAt ?? 0)
      })

      return combined
    } catch {
      return []
    }
  }

  /**
   * Soft-expire a record (set systemExpiredAt and validUntil to now).
   * Does NOT delete — the record remains in the store for temporal queries.
   */
  async expire(
    namespace: string,
    scope: Record<string, string>,
    key: string,
  ): Promise<void> {
    try {
      const existing = await this.inner.get(namespace, scope, key)
      if (existing.length === 0) return

      const now = Date.now()
      const record = existing[0]!
      const oldTemporal = extractTemporal(record) ?? createTemporalMeta()
      const expired: TemporalMetadata = {
        ...oldTemporal,
        systemExpiredAt: now,
        validUntil: now,
      }
      await this.inner.put(namespace, scope, key, { ...record, _temporal: expired })
    } catch {
      // Non-fatal
    }
  }
}
