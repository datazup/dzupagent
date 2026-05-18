# @dzupagent/rag Architecture

## Scope
`@dzupagent/rag` provides framework-level Retrieval Augmented Generation primitives in `packages/rag`.

Current implemented scope:
- Chunking and chunk quality scoring (`SmartChunker`).
- Retrieval in `vector`, `keyword`, and `hybrid` modes with Reciprocal Rank Fusion (`HybridRetriever`).
- Context assembly with source modes and token budgeting (`ContextAssembler`).
- End-to-end orchestration for ingest, retrieve, and assemble (`RagPipeline`).
- Optional quality re-ranking wrapper (`QualityBoostedRetriever`).
- Citation construction and formatting (`CitationTracker`).
- Optional memory-service bridge (`RagMemoryNamespace`).
- Corpus lifecycle management over vector storage (`CorpusManager` and corpus types).
- Filesystem context scoring/caching utility (`FolderContextGenerator`).
- Two Qdrant integration strategies:
  - per-tenant collection pipeline factory (`qdrant-factory.ts`)
  - shared collection + `tenantId` filtering provider modules (`src/providers/*`).

The package builds to ESM (`dist/index.js`, `dist/index.d.ts`) via `tsup`.

## Responsibilities
Primary responsibilities in code:
- Split raw text into boundary-aware chunks with overlap and quality metadata.
- Store and retrieve semantically relevant chunks via injected vector/keyword interfaces.
- Fuse vector and keyword ranks with RRF in hybrid mode.
- Apply optional quality-based score adjustment (chunk + source weighting).
- Enforce retrieval and assembly token budgets.
- Produce LLM-ready source-grounded context text and system prompts.
- Manage tenant/session scoping at retrieval/ingest boundaries.
- Expose reusable Qdrant wiring helpers without forcing hard runtime coupling.
- Provide in-process corpus CRUD/ingest/re-ingest/search APIs.

Non-responsibilities:
- No built-in persistent corpus registry (current corpus registry is in-memory).
- No built-in tracing/metrics backend.
- No application-specific product logic.

## Structure
Package layout and roles:
- `src/index.ts`: public exports and canonical aliases (`RagRetriever`, `RagContextAssembler`, `ChunkingPipeline`).
- `src/types.ts`: shared type contracts for chunking, retrieval, assembly, and pipeline options/results.
- `src/chunker.ts`: `SmartChunker`, chunk boundaries, overlap behavior, quality scoring.
- `src/retriever.ts`: `HybridRetriever`, mode switching, RRF, quality boosting, token budget enforcement.
- `src/quality-retriever.ts`: additional score-boost wrapper using source-quality maps.
- `src/assembler.ts`: `ContextAssembler`, source-mode-aware context generation and prompt builders.
- `src/pipeline.ts`: `RagPipeline`, ingest/retrieve/assemble orchestration and tenant retriever cache.
- `src/citation-tracker.ts`: citation mapping and formatting helpers.
- `src/memory-namespace.ts`: memory namespace adapter with required scope key enforcement.
- `src/corpus-types.ts`: corpus model types and domain errors.
- `src/corpus-manager.ts`: corpus lifecycle and source/chunk bookkeeping.
- `src/folder-context-generator.ts`: recursive scan, weighted file scoring, TTL snapshot cache.
- `src/qdrant-factory.ts`: per-tenant collection Qdrant `RagPipeline` factory.
- `src/providers/qdrant.ts`: barrel for shared-collection Qdrant provider modules.
- `src/providers/qdrant-loader.ts`: optional peer dynamic import and memoized loader.
- `src/providers/qdrant-store.ts`: shared-collection vector/keyword operations with tenant filter injection.
- `src/providers/qdrant-retriever.ts`: `HybridRetriever` wiring from Qdrant store.
- `src/providers/qdrant-corpus-store.ts`: `VectorStore` facade for `CorpusManager` logical collections.
- `src/providers/qdrant-types.ts`: SDK-agnostic structural types for Qdrant client and config.
- `src/__tests__/*.test.ts`: unit/deep/integration-style tests across modules.
- `README.md`: package overview and examples.
- `vitest.config.ts`: Node-only single-fork test setup with coverage thresholds.

## Runtime and Control Flow
1. `RagPipeline.ingest(text, options)`:
- Resolves chunking config (default merged with optional per-call overrides).
- Uses `SmartChunker.chunkText` to produce `ChunkResult[]`.
- Optionally embeds chunk text batches (`autoEmbed !== false`).
- Writes vector entries to collection `${collectionPrefix}${tenantId}`.
- Stores metadata fields like `source_id`, `session_id`, `chunk_index`, `quality_score`, `token_count`.
- Returns counts and timing (`embeddingTimeMs`, `storageTimeMs`).

2. `RagPipeline.retrieve(query, options)`:
- Reuses or lazily creates per-tenant `HybridRetriever` instances.
- Converts flat filter records into `MetadataFilter` (`eq` and optional `and` composition).
- Delegates to `HybridRetriever.retrieve`.

3. `HybridRetriever.retrieve`:
- Chooses `vector`, `keyword`, or `hybrid` branch.
- In `hybrid`, runs vector + keyword in parallel and fuses with RRF (`k=60`).
- Optionally applies quality boosting with source quality strategy/fallback.
- Sorts descending by final score, then trims by token budget.
- Returns chunks, total tokens, search mode, and query latency.

4. `RagPipeline.assembleContext(query, options)`:
- Retrieves chunks using provided `maxTokens` or default retrieval token budget.
- Builds source metadata map (caller-provided or generated defaults).
- Uses `ContextAssembler.assembleContext`.

5. `ContextAssembler.assembleContext`:
- Builds context pieces from source-mode rules:
  - `off`: exclude source.
  - `insights`: use summary text when present.
  - `full`: include retrieved chunks.
- Sorts insights first, then full chunks by score.
- Enforces token budget by dropping low-ranked `full` pieces first.
- Produces `systemPrompt`, `contextText`, `citations`, `sourceBreakdown`, `totalTokens`.

6. `CorpusManager` lifecycle:
- `createCorpus` provisions a vector collection and registers corpus metadata in memory.
- `ingestSource` chunks text, upserts via `SemanticStore`, tracks source/chunk IDs.
- `invalidateSource` and `reIngestSource` delete/replace source chunks.
- `search` runs semantic search through `SemanticStore`.
- `deleteCorpus` cleans in-memory maps and deletes backing collection.

7. Qdrant paths:
- Path A (`createQdrantRagPipeline`): one collection per tenant, via `QdrantAdapter`.
- Path B (`providers/*`): single shared collection, tenant isolation via `tenantId` payload filters, optional dynamic peer load.

## Key APIs and Types
Primary exported classes/functions:
- `SmartChunker`, `DEFAULT_CHUNKING_CONFIG`.
- `HybridRetriever`, `DEFAULT_RETRIEVAL_CONFIG`.
- `ContextAssembler`.
- `RagPipeline`, `DEFAULT_PIPELINE_CONFIG`.
- `QualityBoostedRetriever`.
- `CitationTracker`.
- `RagMemoryNamespace`.
- `CorpusManager`.
- `FolderContextGenerator`.
- `createQdrantRagPipeline`, `ensureTenantCollection`.
- `QdrantVectorStore`, `QdrantCorpusStore`, `createQdrantRetriever`, `loadQdrantClient`, `__resetQdrantLoaderForTests`.

Canonical aliases:
- `RagRetriever` -> `HybridRetriever`.
- `RagContextAssembler` -> `ContextAssembler`.
- `ChunkingPipeline` -> `SmartChunker`.

Key contracts and result types:
- Pipeline/config: `RagPipelineConfig`, `ChunkingConfig`, `RetrievalConfig`, `IngestOptions`, `IngestResult`, `RetrievalResult`, `AssembledContext`.
- Retrieval signatures: `VectorSearchFn`, `KeywordSearchFn`, `VectorSearchHit`, `KeywordSearchHit`, `ScoredChunk`.
- Assembly types: `AssemblyOptions`, `SourceMeta`, `CitationResult`, `SourceContextBreakdown`, `ContextMode`.
- Corpus types: `Corpus`, `CorpusConfig`, `CorpusSource`, `CorpusStats`, `CorpusScoredDocument`, `IngestJobResult`, plus `CorpusNotFoundError` and `SourceNotFoundError`.
- Qdrant wiring types: `QdrantRagConfig`, `QdrantVectorStoreConfig`, `QdrantRetrieverConfig`, `QdrantRetrieverWiring`, `QdrantClientLike`.

## Dependencies
`package.json` dependencies and peers:
- Runtime dependencies:
  - `@dzupagent/core` (vector DB and embedding contracts/adapters).
  - `@dzupagent/memory` (declared dependency; memory bridge remains interface-based).
- Peer dependencies:
  - `@langchain/core` (required peer).
  - `@qdrant/js-client-rest` (optional peer; dynamically loaded in provider path).
  - `zod` (required peer).
- Dev dependencies:
  - `typescript`, `tsup`, `vitest`, `@langchain/core`.

Operational dependency notes:
- Shared-collection Qdrant provider path is intentionally non-fatal when `@qdrant/js-client-rest` is absent (`tryCreate` / loader returns `null`).
- Per-tenant Qdrant factory path depends on `QdrantAdapter` from `@dzupagent/core/advanced`.

## Integration Points
Framework seams:
- `RagPipelineDeps.embeddingProvider`: inject any `EmbeddingProvider` implementation.
- `RagPipelineDeps.vectorStore`: inject any `VectorStore` implementation.
- `RagPipelineDeps.keywordSearch`: optional keyword search callback for keyword/hybrid modes.
- `HybridRetrieverConfig.sourceQuality.provider`: optional async sync source-quality policy hook.
- `RagMemoryNamespace`: consumes any service matching `MemoryServiceLike` (`put/get`, optional `search/delete`).

Qdrant seams:
- `createQdrantRagPipeline(config)`: fast setup for per-tenant collection topology.
- `ensureTenantCollection(adapter, tenantId, options)`: idempotent collection provisioning helper.
- `createQdrantRetriever(config)`: builds `vectorSearch`/`keywordSearch` adapters for `HybridRetriever`.
- `QdrantCorpusStore`: allows multiple logical corpus IDs in one physical Qdrant collection via `_collection` payload tagging.

## Testing and Observability
Implemented tests cover:
- Chunking behavior and quality scoring (`chunker-*`, `minimal-chunker`).
- Retrieval modes, RRF, quality boost behavior (`retriever`, `quality-retriever*`).
- Assembly behavior and prompt shaping (`assembler*`).
- Pipeline ingest/retrieve/assemble and source deletion paths (`pipeline-*`, `rag.integration`).
- Corpus lifecycle and type/error contracts (`corpus-manager`, `corpus-types`).
- Memory bridge (`memory-namespace`).
- Folder context utility (`folder-context-generator`).
- Qdrant factory/provider components (`qdrant-factory`, `qdrant-provider`).
- Public export surface (`public-exports`).

Vitest configuration details (`vitest.config.ts`):
- Node environment.
- `maxConcurrency: 1`, `fileParallelism: false`, fork pool with `singleFork: true`.
- Coverage thresholds: statements/lines `70`, branches/functions `60`.
- Explicit test exclusions for `chunker.test.ts` and `minimal-chunker.test.ts` in this config.

Observability currently exposed by package code:
- Operation timing fields in pipeline results (`embeddingTimeMs`, `storageTimeMs`, `queryTimeMs`).
- `QdrantCorpusStore.healthCheck()` minimal health surface.
- No built-in metrics emitter, tracing instrumentation, or structured logger in this package.

## Risks and TODOs
Current code-grounded risks and limitations:
- README examples include fields/signatures that do not fully match current type contracts; code exports are authoritative.
- `CorpusManager` corpus registry is process-local in-memory state and is lost on restart.
- `QdrantCorpusStore.count()` is a placeholder returning `0`.
- `QdrantCorpusStore.delete()` metadata-filter branch scopes deletion to logical collection but does not map arbitrary `VectorDeleteFilter` clause shapes.
- Shared Qdrant provider intentionally drops unknown nested filter shapes in `userClauses` (conservative translation).
- `RagMemoryNamespace.searchChunks()` uses position-derived synthetic score because the memory search contract does not provide per-record scores.
- Two distinct Qdrant multi-tenant strategies coexist; deployments need explicit selection and consistency.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js