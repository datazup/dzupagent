/**
 * SchemaEmbeddingPipeline — orchestrates DDL generation, SHA-256 hash diff
 * detection, LLM-based table summary generation, and vector store upsert.
 *
 * This replaces the @nl2sql/vector-store SchemaEmbeddingPipeline with one
 * backed by the @dzipagent/core VectorStore + EmbeddingProvider abstractions.
 */

import { createHash } from 'node:crypto'

import type {
  TableSchema,
  TableEmbeddingInput,
  SQLExampleInput,
  SQLDialect,
} from '../types/index.js'

// ---------------------------------------------------------------------------
// Re-declare minimal VectorStore & EmbeddingProvider shapes locally to avoid
// build-order dependency on @dzipagent/core (which may not be built yet when
// domain-nl2sql compiles). At runtime, callers pass concrete instances.
// ---------------------------------------------------------------------------

/** Minimal subset of @dzipagent/core VectorStore used by this pipeline. */
interface VectorStorePort {
  upsert(
    collection: string,
    entries: Array<{
      id: string
      vector: number[]
      metadata: Record<string, unknown>
      text?: string
    }>,
  ): Promise<void>

  delete(
    collection: string,
    filter: { ids: string[] } | { filter: unknown },
  ): Promise<void>
}

/** Minimal subset of @dzipagent/core EmbeddingProvider used by this pipeline. */
interface EmbeddingProviderPort {
  readonly dimensions: number
  embed(texts: string[]): Promise<number[][]>
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input for LLM-based table summary generation. */
export interface TableSummaryInput {
  table: TableSchema
  dialect: SQLDialect
  ddl: string
}

/** Result from LLM-based table summary generation. */
export interface TableSummaryResult {
  tableName: string
  summary: string
}

/**
 * Interface for the summary generator dependency.
 * Implementations typically call a chat model to produce natural-language
 * descriptions of each table based on its DDL.
 */
export interface SummaryGenerator {
  generateSummaries(
    inputs: readonly TableSummaryInput[],
  ): Promise<TableSummaryResult[]>
}

/** Database schema — the set of tables discovered from a data source. */
export interface DatabaseSchema {
  tables: TableSchema[]
  dialect: SQLDialect
}

/** Configuration for the SchemaEmbeddingPipeline. */
export interface SchemaEmbeddingPipelineConfig {
  /** Vector store for upserting / deleting embeddings. */
  vectorStore: VectorStorePort
  /** Embedding provider for generating vectors from text. */
  embeddingProvider: EmbeddingProviderPort
  /** LLM-based summary generator that produces NL descriptions of tables. */
  summaryGenerator: SummaryGenerator
  /** DDL generator function (table, dialect) => DDL string. */
  ddlGenerator: (table: TableSchema, dialect: SQLDialect) => string
  /** Max entries per upsert batch (default: 100). */
  batchSize?: number
}

/** Input for a single pipeline run. */
export interface EmbeddingPipelineInput {
  tenantId: string
  dataSourceId: string
  workspaceId?: string | null | undefined
  schema: DatabaseSchema
  /** Previously stored DDL hashes (tableName -> sha256 hex) for diff detection. */
  existingHashes?: Map<string, string> | undefined
}

/** Result returned after a pipeline run. */
export interface EmbeddingPipelineResult {
  /** Number of tables whose embeddings were created or updated. */
  tablesProcessed: number
  /** Number of tables skipped because their DDL hash was unchanged. */
  tablesSkipped: number
  /** Total number of tables in the discovered schema. */
  tablesTotal: number
  /** Updated DDL hashes for persistence (tableName -> sha256 hex). */
  ddlHashes: Map<string, string>
}

// ---------------------------------------------------------------------------
// Collection name constants
// ---------------------------------------------------------------------------

export const TABLE_SCHEMA_COLLECTION = 'nl2sql_table_schemas' as const
export const SQL_EXAMPLE_COLLECTION = 'nl2sql_sql_examples' as const

// ---------------------------------------------------------------------------
// Deterministic UUID v5 generation using built-in node:crypto
// ---------------------------------------------------------------------------

/**
 * UUID v5 namespace (DNS namespace from RFC 4122).
 * Used as the namespace for all deterministic IDs in this pipeline.
 */
const NL2SQL_UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

/**
 * Generate a deterministic UUID v5 from a composite key.
 *
 * Uses SHA-1 (per RFC 4122 Section 4.3) to hash `namespace + name`,
 * then formats the result as a v5 UUID string.
 */
function uuidV5(name: string, namespace: string): string {
  // Parse namespace UUID to 16 bytes
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const nameBytes = Buffer.from(name, 'utf8')

  const hash = createHash('sha1')
    .update(nsBytes)
    .update(nameBytes)
    .digest()

  // Set version 5 (bits 4-7 of byte 6)
  hash[6] = (hash[6]! & 0x0f) | 0x50
  // Set variant (bits 6-7 of byte 8)
  hash[8] = (hash[8]! & 0x3f) | 0x80

  const hex = hash.subarray(0, 16).toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface TableDDLEntry {
  table: TableSchema
  ddl: string
  hash: string
}

function hashDDL(ddl: string): string {
  return createHash('sha256').update(ddl).digest('hex')
}

function deterministicId(
  prefix: string,
  tenantId: string,
  uniqueKey: string,
): string {
  return uuidV5(`${prefix}:${tenantId}:${uniqueKey}`, NL2SQL_UUID_NAMESPACE)
}

// ---------------------------------------------------------------------------
// SchemaEmbeddingPipeline
// ---------------------------------------------------------------------------

/**
 * Orchestration service that ties together schema discovery, summary
 * generation, and vector store operations.
 *
 * Pipeline flow:
 * 1. Generate DDL for each discovered table.
 * 2. Compute SHA-256 hash of each DDL and compare with previously stored
 *    hashes to detect changes (diff detection).
 * 3. For changed tables, call the summary generator to produce natural
 *    language descriptions.
 * 4. Generate embeddings via the EmbeddingProvider.
 * 5. Upsert the table embeddings (DDL + summary) into the vector store.
 * 6. Return processing statistics and updated hashes for persistence.
 */
export class SchemaEmbeddingPipeline {
  private readonly vectorStore: VectorStorePort
  private readonly embeddingProvider: EmbeddingProviderPort
  private readonly summaryGenerator: SummaryGenerator
  private readonly ddlGenerator: (table: TableSchema, dialect: SQLDialect) => string
  private readonly batchSize: number

  constructor(config: SchemaEmbeddingPipelineConfig) {
    this.vectorStore = config.vectorStore
    this.embeddingProvider = config.embeddingProvider
    this.summaryGenerator = config.summaryGenerator
    this.ddlGenerator = config.ddlGenerator
    this.batchSize = config.batchSize ?? 100
  }

  /**
   * Execute the full embedding pipeline: DDL generation, diff detection,
   * summary generation, embedding, and vector store upsert.
   */
  async run(input: EmbeddingPipelineInput): Promise<EmbeddingPipelineResult> {
    const { tenantId, dataSourceId, workspaceId, schema, existingHashes } =
      input
    const newHashes = new Map<string, string>()

    // 1. Generate DDL + hash for each table
    const tableData: TableDDLEntry[] = schema.tables.map((table) => {
      const ddl = this.ddlGenerator(table, schema.dialect)
      const hash = hashDDL(ddl)
      newHashes.set(table.tableName, hash)
      return { table, ddl, hash }
    })

    // 2. Filter to only changed tables (new or modified DDL)
    const changedTables = tableData.filter(({ table, hash }) => {
      const existingHash = existingHashes?.get(table.tableName)
      return existingHash !== hash
    })

    const skipped = tableData.length - changedTables.length

    if (changedTables.length === 0) {
      return {
        tablesProcessed: 0,
        tablesSkipped: skipped,
        tablesTotal: tableData.length,
        ddlHashes: newHashes,
      }
    }

    // 3. Generate summaries for changed tables
    const summaryInputs: TableSummaryInput[] = changedTables.map(
      ({ table, ddl }) => ({
        table,
        dialect: schema.dialect,
        ddl,
      }),
    )

    const summaries =
      await this.summaryGenerator.generateSummaries(summaryInputs)

    // 4. Build embedding inputs
    const summaryMap = new Map<string, string>(
      summaries.map((s) => [s.tableName, s.summary]),
    )

    const embeddingInputs: TableEmbeddingInput[] = changedTables.map(
      ({ table, ddl }) => {
        const qualifiedName =
          table.schemaName !== ''
            ? `${table.schemaName}.${table.tableName}`
            : table.tableName
        const summary =
          summaryMap.get(qualifiedName) ??
          summaryMap.get(table.tableName) ??
          ''

        return {
          tenantId,
          dataSourceId,
          workspaceId: workspaceId ?? null,
          tableName: table.tableName,
          schemaName: table.schemaName,
          ddl,
          summary,
          foreignKeyTables: table.foreignKeys.map((fk) => fk.referencedTable),
        }
      },
    )

    // 5. Embed summaries and upsert to vector store
    const texts = embeddingInputs.map((inp) => inp.summary)
    const vectors = await this.embeddingProvider.embed(texts)

    const entries = embeddingInputs.map((inp, idx) => ({
      id: deterministicId('table', inp.tenantId, inp.tableName),
      vector: vectors[idx]!,
      metadata: {
        tenant_id: inp.tenantId,
        data_source_id: inp.dataSourceId,
        workspace_id: inp.workspaceId,
        table_name: inp.tableName,
        schema_name: inp.schemaName,
        ddl: inp.ddl,
        summary: inp.summary,
        foreign_key_tables: inp.foreignKeyTables,
      } as Record<string, unknown>,
      text: inp.summary,
    }))

    await this.batchUpsert(TABLE_SCHEMA_COLLECTION, entries)

    return {
      tablesProcessed: changedTables.length,
      tablesSkipped: skipped,
      tablesTotal: tableData.length,
      ddlHashes: newHashes,
    }
  }

  /**
   * Delete all table embeddings for a given tenant + data source.
   */
  async deleteTableEmbeddings(
    tenantId: string,
    dataSourceId: string,
  ): Promise<void> {
    await this.vectorStore.delete(TABLE_SCHEMA_COLLECTION, {
      filter: {
        and: [
          { field: 'tenant_id', op: 'eq', value: tenantId },
          { field: 'data_source_id', op: 'eq', value: dataSourceId },
        ],
      },
    })
  }

  /**
   * Upsert entries in batches to avoid oversized requests.
   */
  private async batchUpsert(
    collection: string,
    entries: Array<{
      id: string
      vector: number[]
      metadata: Record<string, unknown>
      text?: string
    }>,
  ): Promise<void> {
    for (let i = 0; i < entries.length; i += this.batchSize) {
      const batch = entries.slice(i, i + this.batchSize)
      await this.vectorStore.upsert(collection, batch)
    }
  }
}

// ---------------------------------------------------------------------------
// SQL example embedding helper
// ---------------------------------------------------------------------------

/** Input for embedding a single SQL example. */
export interface SQLExampleEmbeddingInput {
  tenantId: string
  dataSourceId: string
  workspaceId?: string | null | undefined
  question: string
  sql: string
  explanation?: string | undefined
}

/** Dependencies for the embedSQLExamples function. */
export interface SQLExampleEmbeddingDeps {
  vectorStore: VectorStorePort
  embeddingProvider: EmbeddingProviderPort
  batchSize?: number
}

/**
 * Embed SQL examples (question/SQL pairs) into the vector store.
 *
 * This is a standalone function because SQL example ingestion is independent
 * of the schema discovery pipeline -- examples can come from user feedback,
 * curated sets, or historical queries.
 *
 * @param deps - Vector store and embedding provider.
 * @param examples - Array of SQL examples to embed.
 * @returns The number of examples upserted.
 */
export async function embedSQLExamples(
  deps: SQLExampleEmbeddingDeps,
  examples: readonly SQLExampleEmbeddingInput[],
): Promise<number> {
  if (examples.length === 0) {
    return 0
  }

  const { vectorStore, embeddingProvider, batchSize = 100 } = deps

  const inputs: SQLExampleInput[] = examples.map((example) => ({
    tenantId: example.tenantId,
    dataSourceId: example.dataSourceId,
    workspaceId: example.workspaceId ?? null,
    question: example.question,
    sql: example.sql,
    explanation: example.explanation ?? '',
  }))

  // Embed the question text for each example
  const texts = inputs.map((inp) => inp.question)
  const vectors = await embeddingProvider.embed(texts)

  const entries = inputs.map((inp, idx) => ({
    id: deterministicId('example', inp.tenantId, inp.question),
    vector: vectors[idx]!,
    metadata: {
      tenant_id: inp.tenantId,
      data_source_id: inp.dataSourceId,
      workspace_id: inp.workspaceId,
      question: inp.question,
      sql: inp.sql,
      explanation: inp.explanation,
    } as Record<string, unknown>,
    text: inp.question,
  }))

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize)
    await vectorStore.upsert(SQL_EXAMPLE_COLLECTION, batch)
  }

  return inputs.length
}

/**
 * Delete all SQL example embeddings for a given tenant + data source.
 */
export async function deleteSQLExampleEmbeddings(
  vectorStore: VectorStorePort,
  tenantId: string,
  dataSourceId: string,
): Promise<void> {
  await vectorStore.delete(SQL_EXAMPLE_COLLECTION, {
    filter: {
      and: [
        { field: 'tenant_id', op: 'eq', value: tenantId },
        { field: 'data_source_id', op: 'eq', value: dataSourceId },
      ],
    },
  })
}
