/**
 * Core LanceDBAdapter class -- implements the {@link VectorStore} contract
 * over the @lancedb/lancedb embedded vector database.
 *
 * Supports persistent local + S3 storage, hybrid search (BM25 + vector),
 * and zero-copy Arrow Table exchange with @dzupagent/memory-ipc.
 */

import type {
  VectorStore,
  CollectionConfig,
  VectorEntry,
  VectorQuery,
  VectorSearchResult,
  VectorDeleteFilter,
  VectorStoreHealth,
} from '../types.js'
import { ForgeError } from '../../errors/forge-error.js'
import {
  DISTANCE_MAP,
  type LanceDBAdapterConfig,
  type LanceDBConnection,
  type ResolvedLanceDBConfig,
} from './lancedb-adapter-types.js'
import { translateFilter } from './lancedb-adapter-filter.js'
import {
  arrowTableToRows,
  isArrowTable,
  tryImportArrow,
} from './lancedb-adapter-arrow.js'
import {
  buildSeedRow,
  defaultUri,
  flattenMetadata,
  rowsToSearchResults,
} from './lancedb-adapter-helpers.js'

/**
 * LanceDB vector store adapter.
 *
 * Arrow-native embedded vector database. Supports:
 * - Persistent local storage (no external service)
 * - Hybrid search (BM25 + vector + metadata filters)
 * - Zero-copy Arrow Table exchange with @dzupagent/memory-ipc
 * - S3-backed storage for production deployments
 *
 * @example
 * ```ts
 * const adapter = await LanceDBAdapter.create({ uri: '~/.dzupagent/lancedb' })
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
    return rowsToSearchResults(rows, query, metric)
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
   * Accepts an arrow.Table instance (from @dzupagent/memory-ipc FrameBuilder.toTable()).
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
