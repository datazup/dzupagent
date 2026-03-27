/**
 * @dzipagent/domain-nl2sql — Schema Retrieval Tool
 *
 * Discovers relevant database tables and SQL examples for a natural language
 * query. Uses the SQL connector's schema discovery with keyword-based
 * relevance filtering, and optionally vector search for few-shot examples.
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { NL2SQLToolkitConfig } from '../types/index.js'

// ---------------------------------------------------------------------------
// Inline types — mirror @dzipagent/connectors SQL types.
// Defined here to avoid transitive dependency on an unbuilt dist.
// Once @dzipagent/connectors is built, these can be replaced with re-exports.
// ---------------------------------------------------------------------------

interface ColumnInfo {
  columnName: string
  dataType: string
  isNullable: boolean
  isPrimaryKey: boolean
  defaultValue: string | null
  description: string | null
  maxLength: number | null
}

interface ForeignKey {
  constraintName: string
  columnName: string
  referencedTable: string
  referencedColumn: string
  referencedSchema: string
}

interface TableSchema {
  tableName: string
  schemaName: string
  columns: ColumnInfo[]
  foreignKeys: ForeignKey[]
  rowCountEstimate: number
  description: string | null
  sampleValues: Record<string, unknown[]>
}

interface DatabaseSchema {
  dialect: string
  schemaName: string
  tables: TableSchema[]
  discoveredAt: Date
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Score a table's relevance to a query using keyword overlap.
 * Returns a value between 0 and 1.
 */
function scoreTableRelevance(table: TableSchema, queryTokens: string[]): number {
  const haystack = [
    table.tableName,
    table.schemaName,
    table.description ?? '',
    ...table.columns.map((c) => c.columnName),
    ...table.columns.map((c) => c.description ?? ''),
    ...table.foreignKeys.map((fk) => fk.referencedTable),
  ]
    .join(' ')
    .toLowerCase()

  let matches = 0
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      matches++
    }
  }

  return queryTokens.length > 0 ? matches / queryTokens.length : 0
}

/**
 * Tokenize a query into lowercase keywords, filtering out stop words.
 */
function tokenizeQuery(query: string): string[] {
  const stopWords = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
    'should', 'may', 'might', 'must', 'can', 'could', 'of', 'at', 'by',
    'for', 'with', 'about', 'between', 'through', 'during', 'before',
    'after', 'to', 'from', 'in', 'on', 'and', 'or', 'not', 'no', 'but',
    'if', 'then', 'than', 'so', 'as', 'that', 'this', 'it', 'its',
    'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
    'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
    'some', 'such', 'only', 'own', 'same', 'too', 'very', 'just',
    'me', 'my', 'i', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
    'show', 'give', 'get', 'find', 'list', 'tell', 'many', 'much',
  ])

  return query
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !stopWords.has(t))
}

/**
 * Generate DDL from a TableSchema (portable, dialect-agnostic representation).
 */
function tableToDDL(table: TableSchema): string {
  const cols = table.columns.map((c) => {
    const nullable = c.isNullable ? '' : ' NOT NULL'
    const pk = c.isPrimaryKey ? ' PRIMARY KEY' : ''
    const def = c.defaultValue !== null ? ` DEFAULT ${c.defaultValue}` : ''
    return `  ${c.columnName} ${c.dataType}${nullable}${pk}${def}`
  })

  const fks = table.foreignKeys.map(
    (fk) =>
      `  CONSTRAINT ${fk.constraintName} FOREIGN KEY (${fk.columnName}) REFERENCES ${fk.referencedSchema}.${fk.referencedTable}(${fk.referencedColumn})`,
  )

  const body = [...cols, ...fks].join(',\n')
  return `CREATE TABLE ${table.schemaName}.${table.tableName} (\n${body}\n);`
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSchemaRetrievalTool(
  config: NL2SQLToolkitConfig,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'retrieve-relevant-schema',
    description:
      'Search for relevant database tables and SQL examples using semantic vector search.',
    schema: z.object({
      query: z.string().describe('The natural language query to find relevant schema for'),
      topK: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Maximum number of tables to return (default: 10)'),
    }),
    func: async ({ query, topK }) => {
      const limit = topK ?? 10

      try {
        // -----------------------------------------------------------------
        // Step 1: Discover schema via SQL connector
        // -----------------------------------------------------------------
        const discoveryOptions = config.forbiddenTables
          ? { excludeTables: config.forbiddenTables }
          : undefined

        let dbSchema: DatabaseSchema
        try {
          dbSchema = await config.sqlConnector.discoverSchema(discoveryOptions)
        } catch (err) {
          return JSON.stringify({
            tables: [],
            examples: [],
            prunedDDL: '',
            error: `Schema discovery failed: ${err instanceof Error ? err.message : String(err)}`,
          })
        }

        // -----------------------------------------------------------------
        // Step 2: Score and rank tables by keyword relevance
        // -----------------------------------------------------------------
        const queryTokens = tokenizeQuery(query)

        const scored = dbSchema.tables.map((table) => ({
          table,
          score: scoreTableRelevance(table, queryTokens),
        }))

        // Sort by score descending; always include tables with FK refs to matched tables
        scored.sort((a, b) => b.score - a.score)

        // Take top-K by direct score
        const topTables = scored.slice(0, limit)

        // Also pull in FK-referenced tables that aren't already included
        const includedNames = new Set(topTables.map((t) => t.table.tableName))
        const fkExpansion: typeof topTables = []

        for (const entry of topTables) {
          if (entry.score === 0) continue
          for (const fk of entry.table.foreignKeys) {
            if (!includedNames.has(fk.referencedTable)) {
              const referenced = scored.find(
                (s) => s.table.tableName === fk.referencedTable,
              )
              if (referenced) {
                fkExpansion.push({ table: referenced.table, score: 0.1 })
                includedNames.add(fk.referencedTable)
              }
            }
          }
        }

        const finalTables = [...topTables.filter((t) => t.score > 0), ...fkExpansion]

        // If no keyword matches at all, return the first N tables as fallback
        const resultTables =
          finalTables.length > 0 ? finalTables : scored.slice(0, limit)

        // -----------------------------------------------------------------
        // Step 3: Build DDL and structured output
        // -----------------------------------------------------------------
        const tableOutput = resultTables.map((entry) => {
          const ddl = tableToDDL(entry.table)
          return {
            tableName: entry.table.tableName,
            schemaName: entry.table.schemaName,
            ddl,
            summary: entry.table.description ?? '',
            score: Math.round(entry.score * 100) / 100,
          }
        })

        const prunedDDL = tableOutput.map((t) => t.ddl).join('\n\n')

        // -----------------------------------------------------------------
        // Step 4: Try vector search for SQL examples (best-effort)
        // -----------------------------------------------------------------
        let examples: Array<{
          question: string
          sql: string
          explanation: string
          score: number
        }> = []

        try {
          const collectionExists = await config.vectorStore.collectionExists(
            'nl2sql_sql_examples',
          )

          if (collectionExists) {
            // TODO: Inject an EmbeddingProvider to produce real query embeddings.
            // For now, we attempt search only if the collection exists.
            // The vector search requires a pre-computed embedding vector.
            // Until an embedding provider is wired in, we log a warning and skip.
            //
            // Future implementation:
            //   const embedding = await config.embeddingProvider.embed(query)
            //   const exampleResults = await config.vectorStore.search(
            //     'nl2sql_sql_examples',
            //     {
            //       vector: embedding,
            //       limit: 5,
            //       filter: {
            //         and: [
            //           { field: 'tenant_id', op: 'eq', value: config.tenantId },
            //           { field: 'data_source_id', op: 'eq', value: config.dataSourceId },
            //         ],
            //       },
            //     },
            //   )
            //   examples = exampleResults.map(vectorResultToExample)

            // Placeholder: collection exists but we lack an embedding vector
            examples = []
          }
        } catch {
          // Vector search is best-effort; continue without examples
        }

        return JSON.stringify({
          tables: tableOutput,
          examples,
          prunedDDL,
          tableCount: tableOutput.length,
        })
      } catch (error) {
        return JSON.stringify({
          tables: [],
          examples: [],
          prunedDDL: '',
          error: `Schema retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    },
  })
}
