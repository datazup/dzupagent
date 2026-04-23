/**
 * @dzupagent/rag — RAG (Retrieval-Augmented Generation) pipeline.
 *
 * Provides smart text chunking, hybrid retrieval (vector + keyword + RRF),
 * quality-boosted scoring, token-budget-aware context assembly, and a
 * top-level pipeline orchestrator.
 */

export * from './types.js'
export { SmartChunker, DEFAULT_CHUNKING_CONFIG } from './chunker.js'
export { HybridRetriever, DEFAULT_RETRIEVAL_CONFIG } from './retriever.js'
export type { HybridRetrieverConfig } from './retriever.js'
export { ContextAssembler } from './assembler.js'
export { RagPipeline, DEFAULT_PIPELINE_CONFIG } from './pipeline.js'
export type { RagPipelineDeps } from './pipeline.js'
export { QualityBoostedRetriever } from './quality-retriever.js'
export type { SourceQualityMap, QualityBoostConfig } from './quality-retriever.js'
export { CitationTracker } from './citation-tracker.js'
export type { CitationSourceMeta } from './citation-tracker.js'
export { RagMemoryNamespace } from './memory-namespace.js'
export type { RagMemoryConfig, MemoryServiceLike } from './memory-namespace.js'
export { CorpusManager } from './corpus-manager.js'
export type { CorpusManagerConfig } from './corpus-manager.js'
export type {
  Corpus,
  CorpusConfig,
  CorpusSource,
  IngestJobResult,
  CorpusStats,
  CorpusScoredDocument,
} from './corpus-types.js'
export { CorpusNotFoundError, SourceNotFoundError } from './corpus-types.js'

// --- Qdrant wiring ---
export { createQdrantRagPipeline, ensureTenantCollection } from './qdrant-factory.js'
export type { QdrantRagConfig } from './qdrant-factory.js'

// --- Folder Context Generator ---
export { FolderContextGenerator } from './folder-context-generator.js'
export type {
  FolderContextConfig,
  FileScore,
  ContextSnapshot,
  ContextTransferLike,
} from './folder-context-generator.js'

// --- Qdrant Option-A provider (single shared collection + tenantId filter) ---
export {
  QdrantVectorStore,
  QdrantCorpusStore,
  createQdrantRetriever,
  loadQdrantClient,
  __resetQdrantLoaderForTests,
} from './providers/qdrant.js'
export type {
  QdrantVectorStoreConfig,
  QdrantRetrieverConfig,
  QdrantRetrieverWiring,
  QdrantClientLike,
  QdrantFilter,
  QdrantFilterClause,
} from './providers/qdrant.js'

// ---------------------------------------------------------------------------
// Canonical public-API aliases
// ---------------------------------------------------------------------------
//
// The underlying implementations ship under descriptive legacy names
// (`HybridRetriever`, `ContextAssembler`, `SmartChunker`). The aliases below
// expose the documented `@dzupagent/rag` surface — `RagRetriever`,
// `RagContextAssembler`, `ChunkingPipeline` — while keeping the original
// exports intact for existing consumers.
export { HybridRetriever as RagRetriever } from './retriever.js'
export { ContextAssembler as RagContextAssembler } from './assembler.js'
export { SmartChunker as ChunkingPipeline } from './chunker.js'
