/**
 * Embedding pipeline for NL2SQL schema and SQL example ingestion.
 *
 * Re-exports the SchemaEmbeddingPipeline class, the embedSQLExamples helper,
 * and all related types.
 */

export {
  SchemaEmbeddingPipeline,
  embedSQLExamples,
  deleteSQLExampleEmbeddings,
  TABLE_SCHEMA_COLLECTION,
  SQL_EXAMPLE_COLLECTION,
} from './schema-embedding-pipeline.js'

export type {
  // Pipeline config & I/O
  SchemaEmbeddingPipelineConfig,
  EmbeddingPipelineInput,
  EmbeddingPipelineResult,
  DatabaseSchema,

  // Summary generator interface
  SummaryGenerator,
  TableSummaryInput,
  TableSummaryResult,

  // SQL example embedding
  SQLExampleEmbeddingInput,
  SQLExampleEmbeddingDeps,
} from './schema-embedding-pipeline.js'
