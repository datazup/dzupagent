/**
 * Analytics handler — helper to create and cache MemoryAnalytics instances,
 * convert Arrow Table results to JSON, and handle DuckDB unavailability.
 *
 * @module
 */

import type { Table } from 'apache-arrow'
import type { AnalyticsResult, RowRecord } from '@dzupagent/memory-ipc'

// ---------------------------------------------------------------------------
// Lazy singleton for MemoryAnalytics
// ---------------------------------------------------------------------------

/** Minimal interface for MemoryAnalytics to avoid hard import at module level. */
interface MemoryAnalyticsLike {
  decayTrends(table: Table, bucketSize: 'hour' | 'day' | 'week'): Promise<AnalyticsResult<RowRecord>>
  namespaceStats(table: Table): Promise<AnalyticsResult<RowRecord>>
  expiringMemories(table: Table, horizonMs: number): Promise<AnalyticsResult<RowRecord>>
  agentPerformance(frames: Map<string, Table> | Table): Promise<AnalyticsResult<RowRecord>>
  usagePatterns(table: Table, bucketMs: number): Promise<AnalyticsResult<RowRecord>>
  duplicateCandidates(table: Table, prefixLength?: number): Promise<AnalyticsResult<RowRecord>>
  close(): Promise<void>
}

let cachedAnalytics: MemoryAnalyticsLike | null = null
let initError: Error | null = null
let initPromise: Promise<MemoryAnalyticsLike> | null = null

/**
 * Get or lazily create a MemoryAnalytics singleton.
 * Throws a descriptive error if DuckDB-WASM is not installed.
 */
export async function getAnalytics(): Promise<MemoryAnalyticsLike> {
  if (cachedAnalytics) return cachedAnalytics
  if (initError) throw initError

  if (!initPromise) {
    initPromise = (async () => {
      try {
        // Dynamic import to keep DuckDB optional
        const { MemoryAnalytics } = await import('@dzupagent/memory-ipc')
        const instance = await MemoryAnalytics.create()
        cachedAnalytics = instance
        return instance
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err))
        initError = error
        initPromise = null
        throw error
      }
    })()
  }

  return initPromise
}

/**
 * Check whether DuckDB analytics are available without throwing.
 */
export function isDuckDBError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === 'DuckDBUnavailableError' ||
      err.message.includes('@duckdb/duckdb-wasm is not installed')
  }
  return false
}

// ---------------------------------------------------------------------------
// Arrow Table to JSON conversion
// ---------------------------------------------------------------------------

/**
 * Convert an AnalyticsResult to a plain JSON-serializable object.
 * Strips the Arrow Table (not serializable) and returns rows + metadata.
 */
export function analyticsResultToJson<T extends RowRecord>(
  result: AnalyticsResult<T>,
): AnalyticsJsonResult<T> {
  return {
    rows: result.rows,
    rowCount: result.rowCount,
    executionMs: Math.round(result.executionMs * 100) / 100,
  }
}

/** JSON-safe analytics result (no Arrow Table). */
export interface AnalyticsJsonResult<T extends RowRecord = RowRecord> {
  rows: T[]
  rowCount: number
  executionMs: number
}

/**
 * Reset the cached analytics instance (useful for testing).
 * @internal
 */
export function _resetAnalyticsCache(): void {
  cachedAnalytics = null
  initError = null
  initPromise = null
}
