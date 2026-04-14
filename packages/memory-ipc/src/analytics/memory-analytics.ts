/**
 * Pre-built analytical queries for DzupAgent memory data.
 *
 * Wraps DuckDBEngine with domain-specific queries. All methods accept
 * an Arrow Table (from FrameBuilder.toTable()) and return typed results.
 */

import type { Table } from 'apache-arrow'
import { DuckDBEngine } from './duckdb-engine.js'
import type { AnalyticsResult, RowRecord } from './duckdb-engine.js'

// ---------------------------------------------------------------------------
// Result types
//
// Using `type` instead of `interface` so they satisfy the Record<string, unknown>
// constraint in AnalyticsResult generics (TypeScript interfaces lack implicit
// index signatures).
// ---------------------------------------------------------------------------

/** Decay trend data point */
export type DecayTrendPoint = RowRecord & {
  namespace: string
  bucket: string
  avg_strength: number
  min_strength: number
  max_strength: number
  count: number
}

/** Namespace usage statistics */
export type NamespaceStats = RowRecord & {
  namespace: string
  total_memories: number
  active_memories: number
  avg_strength: number
  avg_importance: number
  oldest_created: number
  newest_created: number
}

/** Agent performance metrics */
export type AgentPerformance = RowRecord & {
  agent_id: string
  total_memories: number
  avg_importance: number
  categories: string[]
  active_ratio: number
}

/** Expiring memory record */
export type ExpiringMemory = RowRecord & {
  id: string
  namespace: string
  decay_strength: number
  expires_in_ms: number
}

/** Usage pattern histogram bucket */
export type UsagePatternBucket = RowRecord & {
  bucket_start: number
  access_count: number
  unique_memories: number
}

/** Duplicate candidate pair */
export type DuplicateCandidate = RowRecord & {
  id_a: string
  id_b: string
  text_a: string
  text_b: string
  namespace: string
}

// ---------------------------------------------------------------------------
// MemoryAnalytics
// ---------------------------------------------------------------------------

/**
 * Pre-built analytical queries for DzupAgent memory data.
 *
 * Wraps DuckDBEngine with domain-specific queries. All methods accept
 * an Arrow Table (from FrameBuilder.toTable()) and return typed results.
 *
 * @example
 * ```ts
 * const analytics = await MemoryAnalytics.create()
 * const stats = await analytics.namespaceStats(memoryTable)
 * console.log(stats.rows)
 * await analytics.close()
 * ```
 */
export class MemoryAnalytics {
  private engine: DuckDBEngine

  private constructor(engine: DuckDBEngine) {
    this.engine = engine
  }

  /**
   * Create analytics instance. Lazily initializes DuckDB-WASM on first query.
   */
  static async create(): Promise<MemoryAnalytics> {
    const engine = await DuckDBEngine.create()
    return new MemoryAnalytics(engine)
  }

  /**
   * Create analytics instance from an existing DuckDBEngine.
   * Useful when you want to share a DuckDB instance across analytics classes.
   */
  static fromEngine(engine: DuckDBEngine): MemoryAnalytics {
    return new MemoryAnalytics(engine)
  }

  /**
   * Decay strength trends grouped by namespace and time bucket.
   *
   * @param table - Arrow Table conforming to MEMORY_FRAME_SCHEMA
   * @param bucketSize - Time bucket granularity: 'hour', 'day', or 'week'
   */
  async decayTrends(
    table: Table,
    bucketSize: 'hour' | 'day' | 'week',
  ): Promise<AnalyticsResult<DecayTrendPoint>> {
    const intervalMs = bucketSize === 'hour'
      ? 3_600_000
      : bucketSize === 'day'
        ? 86_400_000
        : 604_800_000

    const sql = `
      SELECT
        namespace,
        CAST(FLOOR(system_created_at / ${intervalMs}) * ${intervalMs} AS VARCHAR) AS bucket,
        AVG(COALESCE(decay_strength, 1.0)) AS avg_strength,
        MIN(COALESCE(decay_strength, 1.0)) AS min_strength,
        MAX(COALESCE(decay_strength, 1.0)) AS max_strength,
        COUNT(*) AS count
      FROM memory
      WHERE decay_strength IS NOT NULL
      GROUP BY namespace, bucket
      ORDER BY namespace, bucket
    `

    return this.engine.query<DecayTrendPoint>(table, sql)
  }

  /**
   * Per-namespace usage statistics.
   *
   * @param table - Arrow Table conforming to MEMORY_FRAME_SCHEMA
   */
  async namespaceStats(table: Table): Promise<AnalyticsResult<NamespaceStats>> {
    const sql = `
      SELECT
        namespace,
        COUNT(*) AS total_memories,
        SUM(CASE WHEN is_active THEN 1 ELSE 0 END) AS active_memories,
        AVG(COALESCE(decay_strength, 1.0)) AS avg_strength,
        AVG(COALESCE(importance, 0.5)) AS avg_importance,
        MIN(system_created_at) AS oldest_created,
        MAX(system_created_at) AS newest_created
      FROM memory
      GROUP BY namespace
      ORDER BY total_memories DESC
    `

    return this.engine.query<NamespaceStats>(table, sql)
  }

  /**
   * Memories expiring within the given time window.
   * "Expiring" is defined as decay_strength below a threshold projected
   * using the half-life formula.
   *
   * @param table - Arrow Table conforming to MEMORY_FRAME_SCHEMA
   * @param horizonMs - Time window in milliseconds from now
   */
  async expiringMemories(
    table: Table,
    horizonMs: number,
  ): Promise<AnalyticsResult<ExpiringMemory>> {
    const now = Date.now()
    const horizon = now + horizonMs

    // Project future decay strength using exponential decay formula:
    // projected = current_strength * exp(-(horizon - last_accessed) / half_life)
    // We filter for projected strength < 0.1 (effectively expired)
    const sql = `
      SELECT
        id,
        namespace,
        COALESCE(decay_strength, 1.0) AS decay_strength,
        CAST(${horizon} - COALESCE(decay_last_accessed_at, system_created_at) AS DOUBLE) AS expires_in_ms
      FROM memory
      WHERE decay_strength IS NOT NULL
        AND decay_half_life_ms IS NOT NULL
        AND decay_strength > 0.0
        AND decay_strength * EXP(
          -(${horizon} - COALESCE(decay_last_accessed_at, system_created_at))
          / COALESCE(decay_half_life_ms, 86400000)
        ) < 0.1
      ORDER BY decay_strength ASC
    `

    return this.engine.query<ExpiringMemory>(table, sql)
  }

  /**
   * Cross-agent performance comparison metrics.
   * Accepts a single table (all agents in one frame) or multiple frames
   * via queryMulti.
   *
   * @param frames - Map of agent_id to Arrow Table, or a single combined table
   */
  async agentPerformance(
    frames: Map<string, Table> | Table,
  ): Promise<AnalyticsResult<AgentPerformance>> {
    if (frames instanceof Map) {
      // Multi-table: combine into one query using UNION ALL
      if (frames.size === 0) {
        // Return empty result via single empty query
        const emptyTable = [...frames.values()][0]
        if (!emptyTable) {
          throw new Error('agentPerformance requires at least one table')
        }
        return this.engine.query<AgentPerformance>(
          emptyTable,
          'SELECT NULL AS agent_id, 0 AS total_memories, 0 AS avg_importance, NULL AS categories, 0 AS active_ratio WHERE 1=0',
        )
      }

      // Register all frames and build UNION ALL
      const aliases: string[] = []
      const unionParts: string[] = []
      let idx = 0

      for (const [agentId, _table] of frames) {
        const alias = `agent_${idx}`
        aliases.push(alias)
        unionParts.push(`SELECT '${agentId.replace(/'/g, "''")}' AS agent_source, * FROM "${alias}"`)
        idx++
      }

      const combinedSql = `
        WITH combined AS (${unionParts.join(' UNION ALL ')})
        SELECT
          COALESCE(agent_id, agent_source) AS agent_id,
          COUNT(*) AS total_memories,
          AVG(COALESCE(importance, 0.5)) AS avg_importance,
          LIST(DISTINCT category) FILTER (WHERE category IS NOT NULL) AS categories,
          SUM(CASE WHEN is_active THEN 1.0 ELSE 0.0 END) / COUNT(*) AS active_ratio
        FROM combined
        GROUP BY COALESCE(agent_id, agent_source)
        ORDER BY total_memories DESC
      `

      return this.engine.queryMulti<AgentPerformance>(frames, combinedSql)
    }

    // Single table
    const sql = `
      SELECT
        COALESCE(agent_id, 'unknown') AS agent_id,
        COUNT(*) AS total_memories,
        AVG(COALESCE(importance, 0.5)) AS avg_importance,
        LIST(DISTINCT category) FILTER (WHERE category IS NOT NULL) AS categories,
        SUM(CASE WHEN is_active THEN 1.0 ELSE 0.0 END) / COUNT(*) AS active_ratio
      FROM memory
      GROUP BY COALESCE(agent_id, 'unknown')
      ORDER BY total_memories DESC
    `

    return this.engine.query<AgentPerformance>(frames, sql)
  }

  /**
   * Access pattern histogram bucketed by time.
   *
   * @param table - Arrow Table conforming to MEMORY_FRAME_SCHEMA
   * @param bucketMs - Time bucket size in milliseconds
   */
  async usagePatterns(
    table: Table,
    bucketMs: number,
  ): Promise<AnalyticsResult<UsagePatternBucket>> {
    const sql = `
      SELECT
        FLOOR(COALESCE(decay_last_accessed_at, system_created_at) / ${bucketMs}) * ${bucketMs} AS bucket_start,
        COALESCE(SUM(decay_access_count), 0) AS access_count,
        COUNT(DISTINCT id) AS unique_memories
      FROM memory
      GROUP BY bucket_start
      ORDER BY bucket_start
    `

    return this.engine.query<UsagePatternBucket>(table, sql)
  }

  /**
   * Find potential duplicate memories by matching text prefixes within the same namespace.
   * This is a heuristic approach -- for full semantic dedup, use embedding similarity.
   *
   * @param table - Arrow Table conforming to MEMORY_FRAME_SCHEMA
   * @param prefixLength - Number of characters to compare for prefix matching (default: 100)
   */
  async duplicateCandidates(
    table: Table,
    prefixLength = 100,
  ): Promise<AnalyticsResult<DuplicateCandidate>> {
    const sql = `
      SELECT
        a.id AS id_a,
        b.id AS id_b,
        a.text AS text_a,
        b.text AS text_b,
        a.namespace AS namespace
      FROM memory a
      INNER JOIN memory b
        ON a.namespace = b.namespace
        AND a.id < b.id
        AND a.text IS NOT NULL
        AND b.text IS NOT NULL
        AND LEFT(a.text, ${prefixLength}) = LEFT(b.text, ${prefixLength})
      ORDER BY a.namespace, a.id
    `

    return this.engine.query<DuplicateCandidate>(table, sql)
  }

  /**
   * Run a custom SQL query against a memory table.
   *
   * @param table - Arrow Table to query
   * @param sql - SQL query string (reference the table as 'memory')
   */
  async custom<T extends RowRecord>(
    table: Table,
    sql: string,
  ): Promise<AnalyticsResult<T>> {
    return this.engine.query<T>(table, sql)
  }

  /** Release resources */
  async close(): Promise<void> {
    await this.engine.close()
  }
}
