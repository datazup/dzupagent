/**
 * VectorDB abstraction layer barrel — types, embedding providers, auto-detection.
 */

// --- Core types ---
export type {
  DistanceMetric,
  CollectionConfig,
  VectorEntry,
  VectorQuery,
  VectorSearchResult,
  VectorDeleteFilter,
  MetadataFilter,
  VectorStoreHealth,
  VectorStore,
} from './types.js'

// --- Embedding types ---
export type {
  EmbeddingProvider,
  EmbeddingProviderConfig,
} from './embedding-types.js'

// --- Embedding providers ---
export {
  createOpenAIEmbedding,
  createVoyageEmbedding,
  createCohereEmbedding,
  createOllamaEmbedding,
  createCustomEmbedding,
} from './embeddings/index.js'
export type {
  OpenAIEmbeddingConfig,
  VoyageEmbeddingConfig,
  CohereEmbeddingConfig,
  OllamaEmbeddingConfig,
  CustomEmbeddingConfig,
} from './embeddings/index.js'

// --- Filter utilities ---
export { cosineSimilarity, evaluateFilter } from './filter-utils.js'

// --- In-memory vector store ---
export { InMemoryVectorStore } from './in-memory-vector-store.js'

// --- Semantic store ---
export { SemanticStore } from './semantic-store.js'
export type { SemanticStoreConfig, Document, ScoredDocument } from './semantic-store.js'

// --- Auto-detection ---
export { createAutoEmbeddingProvider, detectVectorProvider, createAutoSemanticStore } from './auto-detect.js'
export type { AutoDetectResult } from './auto-detect.js'

// --- Adapters ---
export {
  QdrantAdapter, translateQdrantFilter,
  PineconeAdapter, translatePineconeFilter,
  PgVectorAdapter,
  ChromaDBAdapter,
} from './adapters/index.js'
export type {
  QdrantAdapterConfig,
  PineconeAdapterConfig,
  PgVectorAdapterConfig,
  ChromaDBAdapterConfig,
} from './adapters/index.js'
