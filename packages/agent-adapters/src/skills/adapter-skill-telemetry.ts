/**
 * Telemetry tracking for adapter skill projections.
 *
 * Records per-projection usage with version, latency, and error data,
 * and computes aggregate stats for observability.
 */

import type { AdapterProviderId } from '../types.js'
import type { ProjectionUsageRecord } from './adapter-skill-types.js'

/** Extended usage record with version-aware telemetry fields. */
export interface ProjectionTelemetryRecord extends Omit<ProjectionUsageRecord, 'projectionVersion'> {
  /** Numeric version of the projection (overrides the string-based version from the base record). */
  projectionVersion: number
  latencyMs?: number
  errorMessage?: string
  rollbackFrom?: number
}

/** Aggregate usage statistics for a (bundleId, providerId) pair. */
export interface ProjectionUsageStats {
  totalUses: number
  successRate: number
  avgLatencyMs: number | undefined
  lastUsed: string | undefined
  currentVersion: number | undefined
}

/** Telemetry interface for adapter skill projections. */
export interface AdapterSkillTelemetry {
  record(entry: ProjectionTelemetryRecord): void
  getUsageStats(bundleId: string, providerId: AdapterProviderId): ProjectionUsageStats
  getHistory(bundleId: string, providerId: AdapterProviderId, limit?: number): ProjectionTelemetryRecord[]
}

/** Composite key for the telemetry map. */
function telemetryKey(bundleId: string, providerId: AdapterProviderId): string {
  return `${bundleId}::${providerId}`
}

/**
 * In-memory implementation of {@link AdapterSkillTelemetry}.
 *
 * Stores records in insertion order per (bundleId, providerId).
 */
export class InMemoryAdapterSkillTelemetry implements AdapterSkillTelemetry {
  private records = new Map<string, ProjectionTelemetryRecord[]>()

  record(entry: ProjectionTelemetryRecord): void {
    const key = telemetryKey(entry.bundleId, entry.providerId)
    let entries = this.records.get(key)
    if (!entries) {
      entries = []
      this.records.set(key, entries)
    }
    entries.push(entry)
  }

  getUsageStats(bundleId: string, providerId: AdapterProviderId): ProjectionUsageStats {
    const entries = this.records.get(telemetryKey(bundleId, providerId)) ?? []

    if (entries.length === 0) {
      return {
        totalUses: 0,
        successRate: 0,
        avgLatencyMs: undefined,
        lastUsed: undefined,
        currentVersion: undefined,
      }
    }

    const successes = entries.filter((e) => e.success).length
    const latencies = entries.filter((e) => e.latencyMs !== undefined).map((e) => e.latencyMs!)
    const avgLatencyMs =
      latencies.length > 0
        ? latencies.reduce((sum, l) => sum + l, 0) / latencies.length
        : undefined

    // Most recent entry determines lastUsed and currentVersion
    const last: ProjectionTelemetryRecord | undefined = entries[entries.length - 1]

    return {
      totalUses: entries.length,
      successRate: successes / entries.length,
      avgLatencyMs,
      lastUsed: last?.timestamp,
      currentVersion: last?.projectionVersion,
    }
  }

  getHistory(
    bundleId: string,
    providerId: AdapterProviderId,
    limit?: number,
  ): ProjectionTelemetryRecord[] {
    const entries = this.records.get(telemetryKey(bundleId, providerId)) ?? []
    if (limit === undefined) return [...entries]
    // Return the most recent `limit` entries
    return entries.slice(-limit)
  }
}
