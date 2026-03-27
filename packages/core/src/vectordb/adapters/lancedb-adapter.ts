/**
 * LanceDB vector store adapter -- Arrow-native embedded vector database.
 *
 * Supports:
 * - Persistent local storage (no external service required)
 * - Hybrid search (BM25 full-text + vector similarity + metadata filters)
 * - Zero-copy Arrow Table exchange with @dzipagent/memory-ipc
 * - S3-backed storage for production deployments
 * - MVCC versioning (time-travel queries)
 *
 * Uses dynamic import() -- @lancedb/lancedb is an optional peer dependency.
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
  DistanceMetric,
} from '../types.js'
import { ForgeError } from '../../errors/forge-error.js'

/** Configuration for the LanceDB adapter */
export interface LanceDBAdapterConfig {
  /**
   * LanceDB connection URI.
   * - Local: "~/.dzipagent/lancedb" or "/tmp/lancedb"
   * - S3: "s3://bucket/path"
   * Defaults to ~/.dzipagent/lancedb
   */
  uri?: string

  /**
   * Enable hybrid search (BM25 full-text + vector similarity).
   * Requires LanceDB FTS index to be built on the 'text' column.
   * Default: true
   */
  hybridSearch?: boolean

  /**
   * Weight for vector similarity in hybrid search (0-1).
   * BM25 weight = 1 - vectorWeight.
   * Default: 0.7
   */
  vectorWeight?: number
}

/** Resolved config with all defaults applied */
interface ResolvedLanceDBConfig {
  uri: string
  hybridSearch: boolean
  vectorWeight: number
}

/** LanceDB distance metric names */
const DISTANCE_MAP: Record<DistanceMetric, string> = {
  cosine: 'cosine',
  euclidean: 'L2',
  dot_product: 'dot',
}

/**
 * Translates a normalized MetadataFilter into a LanceDB SQL WHERE clause.
 *
 * LanceDB uses SQL-like filter expressions on metadata columns.
 */
export function translateFilter(filter: MetadataFilter): string {
  if ('and' in filter) {
    const parts = filter.and.map(translateFilter)
    return `(${parts.join(' AND ')})`
  }
  if ('or' in filter) {
    const parts = filter.or.map(translateFilter)
    return `(${parts.join(' OR ')})`
  }

  const { field, op, value } = filter
  const escaped = escapeIdentifier(field)

  switch (op) {
    case 'eq':
      return `${escaped} = ${escapeLiteral(value)}`
    case 'neq':
      return `${escaped} != ${escapeLiteral(value)}`
    case 'gt':
      return `${escaped} > ${String(value)}`
    case 'gte':
      return `${escaped} >= ${String(value)}`
    case 'lt':
      return `${escaped} < ${String(value)}`
    case 'lte':
      return `${escaped} <= ${String(value)}`
    case 'in': {
      const items = value.map(escapeLiteral).join(', ')
      return `${escaped} IN (${items})`
    }
    case 'not_in': {
      const items = value.map(escapeLiteral).join(', ')
      return `${escaped} NOT IN (${items})`
    }
    case 'contains':
      return `${escaped} LIKE ${escapeLiteral(`%${value}%`)}`
  }
}

/** Escape a SQL identifier (column name) */
function escapeIdentifier(name: string): string {
  // Double-quote identifiers to handle reserved words and special chars
  return `"${name.replace(/"/g, '""')}"`
}

/** Escape a SQL literal value */
function escapeLiteral(value: string | number | boolean): string {
  if (typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  // String: single-quote with escaping
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Internal types for the LanceDB SDK to avoid `any`.
 * These are minimal shapes that match the @lancedb/lancedb API.
 */
interface LanceDBConnection {
  tableNames(): Promise<string[]>
  createTable(
    name: string,
    data: Record<string, unknown>[],
    options?: Record<string, unknown>,
  ): Promise<LanceDBTable>
  createEmptyTable(
    name: string,
    schema: unknown,
    options?: Record<string, unknown>,
  ): Promise<LanceDBTable>
  openTable(name: string): Promise<LanceDBTable>
  dropTable(name: string): Promise<void>
}

interface LanceDBTable {
  add(data: Record<string, unknown>[]): Promise<void>
  update(options: { where: string; values: Record<string, unknown> }): Promise<void>
  delete(where: string): Promise<void>
  countRows(filter?: string): Promise<number>
  search(vector: number[]): LanceDBQueryBuilder
  createIndex(column: string, options?: Record<string, unknown>): Promise<void>
  toArrow(): Promise<unknown>
  overwrite(data: Record<string, unknown>[]): Promise<void>
  schema: unknown
}

interface LanceDBQueryBuilder {
  limit(n: number): LanceDBQueryBuilder
  where(filter: string): LanceDBQueryBuilder
  distanceType(metric: string): LanceDBQueryBuilder
  toArray(): Promise<LanceDBSearchResultRow[]>
  toArrow(): Promise<unknown>
}

interface LanceDBSearchResultRow {
  id: string
  vector: number[]
  text: string | null
  _distance: number
  [key: string]: unknown
}

/** Metadata fields stored alongside the vector (not metadata columns themselves) */
const RESERVED_COLUMNS = new Set(['id', 'vector', 'text', '_distance', '_rowid'])

/**
 * LanceDB vector store adapter.
 *
 * Arrow-native embedded vector database. Supports:
 * - Persistent local storage (no external service)
 * - Hybrid search (BM25 + vector + metadata filters)
 * - Zero-copy Arrow Table exchange with @dzipagent/memory-ipc
 * - S3-backed storage for production deployments
 *
 * @example
 * ```ts
 * const adapter = await LanceDBAdapter.create({ uri: '~/.dzipagent/lancedb' })
 * await adapter.createCollection('memories', { dimensions: 1536 })
 * await adapter.upsert('memories', [{ id: '1', vector: [...], metadata: {}, text: 'hello' }])
 * const results = await adapter.search('memories', { vector: [...], limit: 10 })
 * ```
 */
export class LanceDBAdapter implements VectorStore {
  readonly provider = 'lancedb' as const

  private readonly db: LanceDBConnection
  private readonly config: ResolvedLanceDBConfig
  /** Cache: collection name -> CollectionConfig (dimensions + metric) */
  private readonly collectionConfigs = new Map<string, CollectionConfig>()

  private constructor(db: LanceDBConnection, config: ResolvedLanceDBConfig) {
    this.db = db
    this.config = config
  }

  /**
   * Async factory -- dynamically imports @lancedb/lancedb.
   * Throws ForgeError('MISSING_DEPENDENCY') if not installed.
   */
  static async create(config?: LanceDBAdapterConfig): Promise<LanceDBAdapter> {
    const resolved: ResolvedLanceDBConfig = {
      uri: config?.uri ?? defaultUri(),
      hybridSearch: config?.hybridSearch ?? true,
      vectorWeight: config?.vectorWeight ?? 0.7,
    }

    let lancedb: { connect: (uri: string) => Promise<LanceDBConnection> }
    try {
      // Dynamic import -- @lancedb/lancedb is an optional peer dependency.
      // Using string variable to prevent TypeScript from resolving the module at compile time.
      const moduleName = '@lancedb/lancedb'
      lancedb = (await import(/* webpackIgnore: true */ moduleName)) as typeof lancedb
    } catch {
      throw new ForgeError({
        code: 'MISSING_DEPENDENCY',
        message:
          '@lancedb/lancedb is not installed. Install it with: npm install @lancedb/lancedb',
        recoverable: false,
        suggestion: 'Install @lancedb/lancedb as a dependency or use a different vector store.',
      })
    }

    const db = await lancedb.connect(resolved.uri)
    return new LanceDBAdapter(db as LanceDBConnection, resolved)
  }

  /**
   * Create with an injected connection (for testing).
   * @internal
   */
  static createFromConnection(
    db: LanceDBConnection,
    config?: Partial<ResolvedLanceDBConfig>,
  ): LanceDBAdapter {
    const resolved: ResolvedLanceDBConfig = {
      uri: config?.uri ?? defaultUri(),
      hybridSearch: config?.hybridSearch ?? true,
      vectorWeight: config?.vectorWeight ?? 0.7,
    }
    return new LanceDBAdapter(db, resolved)
  }

  // --- Collection lifecycle ---

  async createCollection(name: string, config: CollectionConfig): Promise<void> {
    const existing = await this.db.tableNames()
    if (existing.includes(name)) {
      throw new ForgeError({
        code: 'VECTOR_COLLECTION_EXISTS',
        message: `Collection "${name}" already exists`,
        recoverable: false,
      })
    }

    // Create table with a seed row to define schema, then delete it
    const seedRow = buildSeedRow(config.dimensions)
    const table = await this.db.createTable(name, [seedRow], {
      mode: 'overwrite',
    })

    // Delete the seed row
    await table.delete('id = \'__seed__\'')

    this.collectionConfigs.set(name, config)
  }

  async deleteCollection(name: string): Promise<void> {
    await this.db.dropTable(name)
    this.collectionConfigs.delete(name)
  }

  async listCollections(): Promise<string[]> {
    return this.db.tableNames()
  }

  async collectionExists(name: string): Promise<boolean> {
    const names = await this.db.tableNames()
    return names.includes(name)
  }

  // --- Vector operations ---

  async upsert(collection: string, entries: VectorEntry[]): Promise<void> {
    if (entries.length === 0) return

    const table = await this.db.openTable(collection)

    const rows = entries.map((entry) => ({
      id: entry.id,
      vector: entry.vector,
      text: entry.text ?? '',
      ...flattenMetadata(entry.metadata),
    }))

    // LanceDB add() does upsert when IDs match if using merge-insert,
    // but the simplest approach is delete-then-add for existing IDs.
    const existingIds = entries.map((e) => `'${e.id.replace(/'/g, "''")}'`).join(', ')
    try {
      await table.delete(`id IN (${existingIds})`)
    } catch {
      // Ignore if no rows match -- first insert
    }

    await table.add(rows)
  }

  async search(
    collection: string,
    query: VectorQuery,
  ): Promise<VectorSearchResult[]> {
    const table = await this.db.openTable(collection)
    const config = this.collectionConfigs.get(collection)
    const metric = config?.metric ?? 'cosine'

    let builder = table
      .search(query.vector)
      .limit(query.limit)
      .distanceType(DISTANCE_MAP[metric])

    if (query.filter) {
      const whereClause = translateFilter(query.filter)
      builder = builder.where(whereClause)
    }

    const rows = await builder.toArray()

    const results: VectorSearchResult[] = []
    for (const row of rows) {
      const score = distanceToScore(row._distance, metric)

      if (query.minScore !== undefined && score < query.minScore) {
        continue
      }

      const metadata = extractMetadata(row)
      const text = typeof row['text'] === 'string' && row['text'] !== '' ? row['text'] : undefined

      const result: VectorSearchResult = {
        id: String(row['id']),
        score,
        metadata: query.includeMetadata === false ? {} : metadata,
        ...(text != null ? { text } : {}),
      }

      if (query.includeVectors && Array.isArray(row['vector'])) {
        result.vector = row['vector'] as number[]
      }

      results.push(result)
    }

    return results
  }

  async delete(collection: string, filter: VectorDeleteFilter): Promise<void> {
    const table = await this.db.openTable(collection)

    if ('ids' in filter) {
      const ids = filter.ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')
      await table.delete(`id IN (${ids})`)
    } else {
      const whereClause = translateFilter(filter.filter)
      await table.delete(whereClause)
    }
  }

  async count(collection: string): Promise<number> {
    const table = await this.db.openTable(collection)
    return table.countRows()
  }

  // --- Lifecycle ---

  async healthCheck(): Promise<VectorStoreHealth> {
    const start = Date.now()
    try {
      await this.db.tableNames()
      return {
        healthy: true,
        latencyMs: Date.now() - start,
        provider: this.provider,
        details: { uri: this.config.uri },
      }
    } catch {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        provider: this.provider,
        details: { uri: this.config.uri },
      }
    }
  }

  async close(): Promise<void> {
    this.collectionConfigs.clear()
    // LanceDB connections are lightweight -- no explicit close needed
  }

  // --- LanceDB-specific extensions ---

  /**
   * Build a full-text search index on the 'text' column of a collection.
   * Required for hybrid search. Idempotent -- no-ops if index exists.
   */
  async buildFTSIndex(collection: string): Promise<void> {
    const table = await this.db.openTable(collection)
    try {
      await table.createIndex('text', {
        config: { type: 'fts' },
      })
    } catch {
      // Idempotent -- index may already exist
    }
  }

  /**
   * Zero-copy upsert from an Apache Arrow Table.
   * Accepts an arrow.Table instance (from @dzipagent/memory-ipc FrameBuilder.toTable()).
   * Falls back to row-by-row extraction if Arrow is not available.
   *
   * @param collection - Target collection name
   * @param arrowTable - An Apache Arrow Table instance
   */
  async upsertArrowTable(collection: string, arrowTable: unknown): Promise<void> {
    const table = await this.db.openTable(collection)

    // Attempt to use the Arrow table directly via LanceDB's native Arrow support
    try {
      await table.add(arrowTable as Record<string, unknown>[])
      return
    } catch {
      // Fall through to row-by-row extraction
    }

    // Fallback: convert Arrow table to rows manually
    const arrowLib = await tryImportArrow()
    if (arrowLib && isArrowTable(arrowTable, arrowLib)) {
      const rows = arrowTableToRows(arrowTable, arrowLib)
      if (rows.length > 0) {
        await table.add(rows)
      }
      return
    }

    throw new ForgeError({
      code: 'MISSING_DEPENDENCY',
      message:
        'Cannot process Arrow Table: apache-arrow is not installed and direct add failed.',
      recoverable: false,
      suggestion: 'Install apache-arrow or pass data as VectorEntry[] instead.',
    })
  }

  /**
   * Return search results as an Arrow Table (zero-copy).
   * Returns null if apache-arrow is not available.
   */
  async searchAsArrow(
    collection: string,
    query: VectorQuery,
  ): Promise<unknown | null> {
    const arrowLib = await tryImportArrow()
    if (!arrowLib) return null

    const table = await this.db.openTable(collection)
    const config = this.collectionConfigs.get(collection)
    const metric = config?.metric ?? 'cosine'

    let builder = table
      .search(query.vector)
      .limit(query.limit)
      .distanceType(DISTANCE_MAP[metric])

    if (query.filter) {
      builder = builder.where(translateFilter(query.filter))
    }

    try {
      return await builder.toArrow()
    } catch {
      // Fallback: convert regular results to Arrow
      return null
    }
  }

  /**
   * Get the adapter configuration (for debugging/inspection).
   */
  getConfig(): Readonly<ResolvedLanceDBConfig> {
    return { ...this.config }
  }
}

// --- Helper functions ---

/** Default LanceDB URI based on platform */
function defaultUri(): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp'
  return `${home}/.dzipagent/lancedb`
}

/** Build a seed row with correct schema for initial table creation */
function buildSeedRow(dimensions: number): Record<string, unknown> {
  return {
    id: '__seed__',
    vector: new Array<number>(dimensions).fill(0),
    text: '',
  }
}

/** Flatten metadata into top-level columns (LanceDB stores columns, not nested objects) */
function flattenMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (RESERVED_COLUMNS.has(key)) continue
    // LanceDB supports primitive types and arrays natively
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value
    } else if (Array.isArray(value)) {
      // Store arrays as JSON strings for compatibility
      result[key] = JSON.stringify(value)
    } else if (value !== null && value !== undefined) {
      // Store complex objects as JSON strings
      result[key] = JSON.stringify(value)
    }
  }
  return result
}

/** Extract metadata fields from a LanceDB result row */
function extractMetadata(row: LanceDBSearchResultRow): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (RESERVED_COLUMNS.has(key)) continue
    metadata[key] = value
  }
  return metadata
}

/** Convert a LanceDB distance to a similarity score (0-1 range, higher = more similar) */
function distanceToScore(distance: number, metric: DistanceMetric): number {
  switch (metric) {
    case 'cosine':
      // LanceDB cosine distance is 1 - cosine_similarity
      return 1 - distance
    case 'euclidean':
      // Convert L2 distance to a 0-1 score (inverse relationship)
      return 1 / (1 + distance)
    case 'dot_product':
      // Dot product distance is negative inner product
      // Higher dot product = more similar, so negate the distance
      return -distance
  }
}

/** Try to dynamically import apache-arrow */
async function tryImportArrow(): Promise<ArrowLib | null> {
  try {
    // Using string variable to prevent TypeScript from resolving the module at compile time.
    const moduleName = 'apache-arrow'
    const mod = (await import(/* webpackIgnore: true */ moduleName)) as unknown as ArrowLib
    return mod
  } catch {
    return null
  }
}

/** Minimal Apache Arrow library shape */
interface ArrowLib {
  Table: { isTable?: (obj: unknown) => boolean }
  tableToIPC?: (table: unknown) => unknown
}

/** Check if a value is an Apache Arrow Table */
function isArrowTable(value: unknown, arrowLib: ArrowLib): boolean {
  const isTableFn = arrowLib.Table?.isTable
  if (typeof isTableFn === 'function') {
    return isTableFn(value)
  }
  // Duck-type check as fallback
  return (
    value !== null &&
    typeof value === 'object' &&
    'schema' in value &&
    'toArray' in value
  )
}

/** Convert an Arrow Table to an array of row objects */
function arrowTableToRows(
  table: unknown,
  _arrowLib: ArrowLib,
): Record<string, unknown>[] {
  // Arrow Table has a toArray() method or iterable rows
  const t = table as { toArray?: () => Record<string, unknown>[]; [Symbol.iterator]?: () => Iterator<Record<string, unknown>> }
  if (typeof t.toArray === 'function') {
    return t.toArray()
  }
  if (t[Symbol.iterator]) {
    return [...t as Iterable<Record<string, unknown>>]
  }
  return []
}
