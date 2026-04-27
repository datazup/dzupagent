# @dzupagent/rag Architecture

## Scope
`@dzupagent/rag` is the RAG package in `dzupagent/packages/rag`. The current implementation covers:

- Chunk generation and chunk-quality scoring (`SmartChunker`)
- Retrieval orchestration over injected vector/keyword search (`HybridRetriever`)
- Context assembly and prompt shaping (`ContextAssembler`)
- End-to-end ingest/retrieve/assemble orchestration (`RagPipeline`)
- Optional source-quality re-ranking wrapper (`QualityBoostedRetriever`)
- Citation metadata and formatting (`CitationTracker`)
- Optional memory bridge (`RagMemoryNamespace`)
- Corpus lifecycle manager (`CorpusManager` + corpus types)
- Filesystem context ranking utility (`FolderContextGenerator`)
- Qdrant integration path: per-tenant collections via `QdrantAdapter` (`qdrant-factory.ts`)
- Qdrant integration path: single shared collection with `tenantId` filtering (`providers/qdrant.ts`)

Build output is ESM (`dist/index.js` + `dist/index.d.ts`) via `tsup`.

## Responsibilities
The package is responsible for reusable framework-level RAG primitives, not app-specific product logic.

Primary responsibilities:

- Convert raw text into chunked units with metadata and quality scores.
- Retrieve relevant chunks in `vector`, `keyword`, or `hybrid` mode.
- Fuse vector and keyword results using Reciprocal Rank Fusion (RRF).
- Apply optional quality-based score boosting.
- Enforce token budgets during retrieval and context assembly.
- Assemble source-aware context text, citations, and system prompts.
- Provide tenant/session scoped ingestion and retrieval orchestration.
- Provide optional convenience adapters for Qdrant-backed deployments.
- Provide a lightweight corpus registry API on top of vector storage.

## Structure
Current package layout:

- `src/index.ts`: public export surface, including canonical aliases (`RagRetriever`, `RagContextAssembler`, `ChunkingPipeline`).
- `src/types.ts`: shared config and data contracts (`RagPipelineConfig`, `RetrievalResult`, `AssembledContext`, etc.).
- `src/chunker.ts`: `SmartChunker` + default chunking config + quality metrics logic.
- `src/retriever.ts`: `HybridRetriever` + quality strategy hooks + RRF + token budget filtering.
- `src/quality-retriever.ts`: wrapper retriever for external source-quality maps.
- `src/assembler.ts`: `ContextAssembler` for source-mode-aware context construction.
- `src/pipeline.ts`: `RagPipeline` orchestration and tenant retriever cache.
- `src/citation-tracker.ts`: source registration and citation generation/formatting.
- `src/memory-namespace.ts`: memory service bridge (duck-typed interface).
- `src/corpus-types.ts`: corpus contracts and errors.
- `src/corpus-manager.ts`: in-process corpus lifecycle manager.
- `src/folder-context-generator.ts`: folder scoring and cached context snapshot generation.
- `src/qdrant-factory.ts`: `createQdrantRagPipeline` and `ensureTenantCollection` (per-tenant collection strategy).
- `src/providers/qdrant.ts`: dynamic Qdrant loader, single-collection vector store, retriever wiring, and `QdrantCorpusStore` facade.
- `src/__tests__/*.test.ts`: unit/deep/coverage/integration-style tests for all major modules.
- `README.md`: package usage overview and examples.
- `vitest.config.ts`: Node test environment, single-fork execution, coverage thresholds.

## Runtime and Control Flow
### 1. Ingestion (`RagPipeline.ingest`)

1. Merge default and per-call chunking config.
2. Chunk source text via `SmartChunker.chunkText(text, sourceId)`.
3. Optionally embed chunk texts in batches using `embeddingProvider.embed(...)`.
4. Upsert vectors into collection `${collectionPrefix}${tenantId}` via injected `VectorStore`.
5. Persist metadata (`source_id`, `session_id`, `chunk_index`, `quality_score`, `token_count`, plus caller metadata).
6. Return `IngestResult` with timing counters.

### 2. Retrieval (`RagPipeline.retrieve` -> `HybridRetriever.retrieve`)

1. Select tenant-scoped retriever instance from cache (or create one).
2. Build filter with `session_id` and convert to `@dzupagent/core` metadata filter.
3. Execute configured mode: `vector` embeds and runs vector search, `keyword` runs keyword callback search, and `hybrid` runs both and fuses with RRF (`k=60`).
4. Optionally apply quality boosting (chunk/source blend).
5. Sort by score and apply token-budget truncation.
6. Return `RetrievalResult` with `searchMode`, chunks, token count, and query latency.

### 3. Assembly (`RagPipeline.assembleContext` -> `ContextAssembler.assembleContext`)

1. Retrieve chunks with retrieval budget from `maxTokens` or default token budget.
2. Resolve source metadata (provided map or auto-built defaults).
3. Build context pieces by source mode: `off` excludes source content, `insights` uses source summaries, and `full` uses retrieved chunk text.
4. Sort context pieces (insights first, then score-desc).
5. Apply assembly token budget (drops lowest-ranked `full` chunks first).
6. Produce `AssembledContext` with `systemPrompt`, `contextText`, `citations`, `totalTokens`, and `sourceBreakdown`.

### 4. Corpus flow (`CorpusManager`)

1. `createCorpus` provisions a vector collection and registers in-memory corpus metadata.
2. `ingestSource` chunks and upserts via `SemanticStore`; tracks chunk IDs by corpus/source.
3. `invalidateSource` / `reIngestSource` remove and replace source chunks.
4. `search` runs semantic retrieval against corpus collection.
5. `deleteCorpus` removes registry state and backing collection.

### 5. Qdrant wiring strategies

- Strategy A (`qdrant-factory.ts`): one collection per tenant (`rag_<tenantId>` by default), using `QdrantAdapter` from `@dzupagent/core`.
- Strategy B (`providers/qdrant.ts`): one shared collection with mandatory `tenantId` payload filtering in queries.

## Key APIs and Types
Public exports are from `src/index.ts`.

Core runtime APIs:

- `SmartChunker`, `DEFAULT_CHUNKING_CONFIG`
- `HybridRetriever`, `DEFAULT_RETRIEVAL_CONFIG`
- `ContextAssembler`
- `RagPipeline`, `DEFAULT_PIPELINE_CONFIG`
- `QualityBoostedRetriever`
- `CitationTracker`
- `RagMemoryNamespace`
- `CorpusManager`
- `FolderContextGenerator`
- `createQdrantRagPipeline`, `ensureTenantCollection`
- `QdrantVectorStore`, `QdrantCorpusStore`, `createQdrantRetriever`, `loadQdrantClient`

Canonical aliases:

- `RagRetriever` -> `HybridRetriever`
- `RagContextAssembler` -> `ContextAssembler`
- `ChunkingPipeline` -> `SmartChunker`

Key contracts:

- Pipeline config/data: `RagPipelineConfig`, `IngestOptions`, `IngestResult`, `RetrievalResult`, `AssembledContext`
- Retrieval contracts: `VectorSearchFn`, `KeywordSearchFn`, `VectorSearchHit`, `KeywordSearchHit`, `ScoredChunk`
- Assembly contracts: `SourceMeta`, `AssemblyOptions`, `CitationResult`, `SourceContextBreakdown`
- Corpus contracts: `Corpus`, `CorpusConfig`, `CorpusSource`, `CorpusStats`, `CorpusScoredDocument`
- Qdrant contracts: `QdrantRagConfig`, `QdrantVectorStoreConfig`, `QdrantRetrieverConfig`, `QdrantRetrieverWiring`

## Dependencies
`package.json` currently defines:

Runtime dependencies:

- `@dzupagent/core`: provides vector-store and embedding interfaces plus concrete adapters (used directly).
- `@dzupagent/memory`: declared runtime dependency (RAG memory bridge uses a duck-typed interface and does not import concrete runtime symbols from this package).

Peer dependencies:

- `@langchain/core` (required peer).
- `@qdrant/js-client-rest` (optional peer; dynamically imported by `providers/qdrant.ts`).
- `zod` (required peer).

Dev dependencies include `typescript`, `tsup`, `vitest`, and local peer-test alignment for `@langchain/core`.

## Integration Points
Framework integration seams:

- `RagPipelineDeps.embeddingProvider`: any `EmbeddingProvider` from `@dzupagent/core` contract.
- `RagPipelineDeps.vectorStore`: any `VectorStore` from `@dzupagent/core` contract.
- `RagPipelineDeps.keywordSearch`: optional lexical search function.
- `RagMemoryNamespace`: plug-in memory service implementing `put/get` (+ optional `search/delete`).

Qdrant integration seams:

- `createQdrantRagPipeline(config)`: fast path for per-tenant collection strategy.
- `ensureTenantCollection(adapter, tenantId, options)`: startup collection provisioning helper.
- `createQdrantRetriever(config)`: returns vector/keyword function adapters for `HybridRetriever`.
- `QdrantCorpusStore`: adapts shared-collection Qdrant strategy to `VectorStore` for `CorpusManager`.

## Testing and Observability
Test surface under `src/__tests__` covers:

- Chunking behavior and quality scoring (`chunker-*`, `minimal-chunker`).
- Retrieval modes, RRF fusion, quality boosting (`retriever`, `quality-retriever*`, `pipeline-memory-retriever`).
- Assembly behavior and prompt generation (`assembler*`).
- Pipeline ingest/retrieve/assembly/cache/delete behavior (`pipeline.unit`, `pipeline-deep`, `pipeline-coverage`, `rag.integration`).
- Qdrant strategy modules (`qdrant-factory`, `qdrant-provider`).
- Corpus lifecycle and errors (`corpus-manager`, `corpus-types`).
- Memory namespace and folder context generator (`memory-namespace`, `folder-context-generator`).
- Public export contract (`public-exports`).

Test runtime setup:

- Vitest in Node environment with single-fork execution (`pool: 'forks'`, `singleFork: true`) and elevated heap.
- Coverage thresholds: statements/lines 70, branches/functions 60.

Observability currently in code:

- `RagPipeline` returns timing fields (`embeddingTimeMs`, `storageTimeMs`, `queryTimeMs`) in operation results.
- `QdrantCorpusStore.healthCheck()` returns vector-store health status.
- No built-in metrics emitter, tracer, or structured logger is implemented in this package.

## Risks and TODOs
Current code-level risks and implementation notes:

- `README.md` examples are partially drifted from current signatures/field names; source APIs should be treated as authoritative until examples are refreshed.
- `CorpusManager` registry state is in-memory only and does not survive process restarts.
- `QdrantCorpusStore.count()` intentionally returns `0` (no real per-collection count call implemented).
- `QdrantCorpusStore.delete()` metadata-filter delete path is broad for the logical collection and does not translate arbitrary `VectorDeleteFilter` clauses.
- `RagMemoryNamespace.searchChunks()` uses position-based synthetic scores because `MemoryServiceLike.search` does not carry native score fields.
- Two Qdrant multi-tenant strategies coexist (per-tenant collections and shared collection with filter); deployments should choose one strategy intentionally.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

