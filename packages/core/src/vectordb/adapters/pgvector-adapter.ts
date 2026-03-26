/**
 * PgVector adapter — implements VectorStore using PostgreSQL + pgvector extension.
 *
 * Uses raw parameterized SQL via a pluggable query function. No ORM dependency.
 * Table names are config-controlled (not user input) so they are interpolated directly.
 * All values go through parameterized queries ($1, $2, ...) to prevent SQL injection.
 */

import type {
  VectorStore,
  CollectionConfig,
  VectorEntry,
  VectorQuery,
  VectorSearchResult,
  VectorDeleteFilter,
  VectorStoreHealth,
  MetadataFilter,
} from '../types.js'

/** Row shape returned by the query function */
interface QueryRow {
  rows: Record<string, unknown>[]
}

/** Configuration for the PgVector adapter */
export interface PgVectorAdapterConfig {
  /** PostgreSQL connection string (used for display/health; actual connection managed externally) */
  connectionString: string
  /** Prefix for table names (default: 'forge_vectors_') */
  tablePrefix?: string
  /** Custom query function — inject for testing or to use your own pg client */
  queryFn: (sql: string, params: unknown[]) => Promise<QueryRow>
}

/** Sanitize a collection name to prevent SQL injection in identifiers */
function safeName(name: string): string {
  // Allow only alphanumeric + underscore
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid collection name: "${name}". Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`)
  }
  return name
}

/** Map a MetadataFilter op to a SQL operator string */
function opToSql(op: string): string {
  const map: Record<string, string> = {
    eq: '=',
    neq: '!=',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
  }
  const result = map[op]
  if (!result) {
    throw new Error(`Unsupported filter operator: ${op}`)
  }
  return result
}

/**
 * Translate a MetadataFilter tree into a SQL WHERE clause with parameterized values.
 * Returns [sqlFragment, params] where params are appended after `startIdx`.
 */
function translateFilter(
  filter: MetadataFilter,
  startIdx: number,
): { sql: string; params: unknown[]; nextIdx: number } {
  if ('and' in filter) {
    const parts: string[] = []
    const allParams: unknown[] = []
    let idx = startIdx
    for (const sub of filter.and) {
      const result = translateFilter(sub, idx)
      parts.push(result.sql)
      allParams.push(...result.params)
      idx = result.nextIdx
    }
    return { sql: `(${parts.join(' AND ')})`, params: allParams, nextIdx: idx }
  }

  if ('or' in filter) {
    const parts: string[] = []
    const allParams: unknown[] = []
    let idx = startIdx
    for (const sub of filter.or) {
      const result = translateFilter(sub, idx)
      parts.push(result.sql)
      allParams.push(...result.params)
      idx = result.nextIdx
    }
    return { sql: `(${parts.join(' OR ')})`, params: allParams, nextIdx: idx }
  }

  const { field, op, value } = filter

  if (op === 'in' || op === 'not_in') {
    const paramRef = `$${startIdx}`
    const negation = op === 'not_in' ? 'NOT ' : ''
    return {
      sql: `${negation}metadata->>'${safeName(field)}' = ANY(${paramRef})`,
      params: [value],
      nextIdx: startIdx + 1,
    }
  }

  if (op === 'contains') {
    const paramRef = `$${startIdx}`
    return {
      sql: `metadata->>'${safeName(field)}' ILIKE ${paramRef}`,
      params: [`%${value}%`],
      nextIdx: startIdx + 1,
    }
  }

  // Numeric comparisons need a cast
  const isNumeric = op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte'
  const paramRef = `$${startIdx}`
  const sqlOp = opToSql(op)

  if (isNumeric) {
    return {
      sql: `(metadata->>'${safeName(field)}')::numeric ${sqlOp} ${paramRef}`,
      params: [value],
      nextIdx: startIdx + 1,
    }
  }

  // eq / neq — string comparison
  return {
    sql: `metadata->>'${safeName(field)}' ${sqlOp} ${paramRef}`,
    params: [value],
    nextIdx: startIdx + 1,
  }
}

export class PgVectorAdapter implements VectorStore {
  readonly provider = 'pgvector' as const

  private readonly prefix: string
  private readonly query: (sql: string, params: unknown[]) => Promise<QueryRow>
  private readonly connString: string

  constructor(config: PgVectorAdapterConfig) {
    this.prefix = config.tablePrefix ?? 'forge_vectors_'
    this.query = config.queryFn
    this.connString = config.connectionString
  }

  private tableName(collection: string): string {
    return `${this.prefix}${safeName(collection)}`
  }

  async createCollection(name: string, config: CollectionConfig): Promise<void> {
    const table = this.tableName(name)
    const dim = config.dimensions

    await this.query('CREATE EXTENSION IF NOT EXISTS vector', [])
    await this.query(
      `CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        vector vector(${dim}),
        metadata JSONB DEFAULT '{}',
        text TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      [],
    )
    await this.query(
      `CREATE INDEX IF NOT EXISTS idx_${safeName(name)}_vector ON ${table} USING ivfflat (vector vector_cosine_ops)`,
      [],
    )
  }

  async deleteCollection(name: string): Promise<void> {
    const table = this.tableName(name)
    await this.query(`DROP TABLE IF EXISTS ${table}`, [])
  }

  async listCollections(): Promise<string[]> {
    const result = await this.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name LIKE $1`,
      [`${this.prefix}%`],
    )
    return result.rows.map((row) => {
      const tableName = row['table_name'] as string
      return tableName.slice(this.prefix.length)
    })
  }

  async collectionExists(name: string): Promise<boolean> {
    const table = this.tableName(name)
    const result = await this.query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = $1) as exists`,
      [table],
    )
    const firstRow = result.rows[0]
    return firstRow ? (firstRow['exists'] as boolean) : false
  }

  async upsert(collection: string, entries: VectorEntry[]): Promise<void> {
    const table = this.tableName(collection)

    for (const entry of entries) {
      const vectorStr = `[${entry.vector.join(',')}]`
      await this.query(
        `INSERT INTO ${table} (id, vector, metadata, text)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET vector = $2, metadata = $3, text = $4`,
        [entry.id, vectorStr, JSON.stringify(entry.metadata), entry.text ?? null],
      )
    }
  }

  async search(collection: string, query: VectorQuery): Promise<VectorSearchResult[]> {
    const table = this.tableName(collection)
    const vectorStr = `[${query.vector.join(',')}]`

    let paramIdx = 2 // $1 is vector
    let whereClause = ''
    const params: unknown[] = [vectorStr]

    if (query.filter) {
      const filterResult = translateFilter(query.filter, paramIdx)
      whereClause = `WHERE ${filterResult.sql}`
      params.push(...filterResult.params)
      paramIdx = filterResult.nextIdx
    }

    if (query.minScore !== undefined) {
      const conjunction = whereClause ? 'AND' : 'WHERE'
      whereClause = `${whereClause} ${conjunction} 1 - (vector <=> $1) >= $${paramIdx}`
      params.push(query.minScore)
      paramIdx = paramIdx + 1
    }

    const limitParam = `$${paramIdx}`
    params.push(query.limit)

    const selectFields = [
      'id',
      'metadata',
      'text',
      '1 - (vector <=> $1) as score',
    ]
    if (query.includeVectors) {
      selectFields.push('vector')
    }

    const sql = `SELECT ${selectFields.join(', ')} FROM ${table} ${whereClause} ORDER BY vector <=> $1 LIMIT ${limitParam}`
    const result = await this.query(sql, params)

    return result.rows.map((row) => {
      const rowText = row['text'] as string | undefined
      const entry: VectorSearchResult = {
        id: row['id'] as string,
        score: row['score'] as number,
        metadata: (row['metadata'] as Record<string, unknown>) ?? {},
        ...(rowText != null ? { text: rowText } : {}),
      }
      if (query.includeVectors && row['vector']) {
        entry.vector = row['vector'] as number[]
      }
      return entry
    })
  }

  async delete(collection: string, filter: VectorDeleteFilter): Promise<void> {
    const table = this.tableName(collection)

    if ('ids' in filter) {
      await this.query(`DELETE FROM ${table} WHERE id = ANY($1)`, [filter.ids])
    } else {
      const filterResult = translateFilter(filter.filter, 1)
      await this.query(
        `DELETE FROM ${table} WHERE ${filterResult.sql}`,
        filterResult.params,
      )
    }
  }

  async count(collection: string): Promise<number> {
    const table = this.tableName(collection)
    const result = await this.query(`SELECT COUNT(*) as count FROM ${table}`, [])
    const firstRow = result.rows[0]
    return firstRow ? Number(firstRow['count']) : 0
  }

  async healthCheck(): Promise<VectorStoreHealth> {
    const start = Date.now()
    try {
      await this.query('SELECT 1', [])
      return {
        healthy: true,
        latencyMs: Date.now() - start,
        provider: this.provider,
        details: { connectionString: this.connString },
      }
    } catch {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        provider: this.provider,
      }
    }
  }

  async close(): Promise<void> {
    // Connection lifecycle is managed by the caller via queryFn
  }
}
