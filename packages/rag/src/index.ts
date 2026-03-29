/**
 * @dzipagent/rag — RAG (Retrieval-Augmented Generation) pipeline.
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
