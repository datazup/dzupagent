/**
 * Analytics module for ForgeAgent memory data.
 *
 * Uses DuckDB-WASM to run SQL queries over Arrow Tables.
 * @duckdb/duckdb-wasm is an optional peer dependency.
 */

export { DuckDBEngine } from './duckdb-engine.js'
export type { AnalyticsResult, RowRecord } from './duckdb-engine.js'

export { MemoryAnalytics } from './memory-analytics.js'
export type {
  DecayTrendPoint,
  NamespaceStats,
  AgentPerformance,
  ExpiringMemory,
  UsagePatternBucket,
  DuplicateCandidate,
} from './memory-analytics.js'
