# VectorDB Architecture (`packages/core/src/vectordb`)

## Scope
This document describes the vector database subsystem under `packages/core/src/vectordb`.

Implementation files in scope:
- `types.ts`
- `embedding-types.ts`
- `filter-utils.ts`
- `in-memory-vector-store.ts`
- `semantic-store.ts`
- `auto-detect.ts`
- `index.ts`
- `embeddings/*`
- `adapters/*`

Package-level integration references in scope:
- `packages/core/src/index.ts` (package root re-exports)
- `packages/core/src/registry/vector-semantic-search.ts` (consumer of `SemanticStore`)
- `packages/core/src/events/event-types.ts` (event types only)

Test files in scope:
- `src/vectordb/__tests__/types.test.ts`
- `src/vectordb/__tests__/in-memory-vector-store.test.ts`
- `src/vectordb/__tests__/semantic-store.test.ts`
- `src/vectordb/__tests__/embeddings.test.ts`
- `src/vectordb/__tests__/qdrant-adapter.test.ts`
- `src/vectordb/__tests__/pinecone-adapter.test.ts`
- `src/vectordb/__tests__/pgvector-adapter.test.ts`
- `src/vectordb/__tests__/chroma-adapter.test.ts`
- `src/__tests__/vectordb/turbopuffer-adapter.test.ts`
- `src/__tests__/lancedb-adapter.test.ts`

## Responsibilities
The subsystem provides a provider-agnostic vector/search abstraction plus concrete adapter implementations.

Primary responsibilities:
- Define stable vector contracts (`VectorStore`, query/filter/result types, collection config).
- Define stable embedding contracts (`EmbeddingProvider`) and provider factories.
- Provide text-first semantic operations via `SemanticStore` (embed + upsert/search).
- Implement concrete `VectorStore` adapters:
  - `InMemoryVectorStore`
  - `QdrantAdapter`
  - `PineconeAdapter`
  - `PgVectorAdapter`
  - `ChromaDBAdapter`
  - `TurbopufferAdapter`
  - `LanceDBAdapter`
- Provide env-driven detection helpers for embeddings and vector provider metadata.

Non-responsibilities in current code:
- No direct event emission from vectordb classes.
- No centralized telemetry/metrics wiring beyond per-adapter `healthCheck()` results.
- No production adapter auto-instantiation in `createAutoSemanticStore` (it always uses in-memory store).

## Structure
Core contracts and utilities:
- `types.ts`: vector contracts and metadata filter AST.
- `embedding-types.ts`: `EmbeddingProvider` contract.
- `filter-utils.ts`: `cosineSimilarity` and `evaluateFilter` for local evaluation.

Core orchestration:
- `semantic-store.ts`: `SemanticStore` wrapping `EmbeddingProvider + VectorStore`.
- `auto-detect.ts`:
  - `createAutoEmbeddingProvider`
  - `detectVectorProvider`
  - `createAutoSemanticStore`

Embedding providers (`embeddings/*`):
- `createOpenAIEmbedding`
- `createVoyageEmbedding`
- `createCohereEmbedding`
- `createOllamaEmbedding`
- `createCustomEmbedding`

Vector adapters (`adapters/*`):
- `QdrantAdapter` + `translateQdrantFilter`
- `PineconeAdapter` + `translatePineconeFilter`
- `PgVectorAdapter`
- `ChromaDBAdapter`
- `TurbopufferAdapter` + `translateTurbopufferFilter`
- `LanceDBAdapter` + `translateLanceDBFilter`

Public export surface:
- `src/vectordb/index.ts` exports all of the above.
- `src/index.ts` re-exports most vectordb APIs, but not LanceDB symbols.

## Runtime and Control Flow
Semantic write flow:
1. Caller invokes `SemanticStore.upsert(collection, docs)`.
2. `EmbeddingProvider.embed(texts)` is called once per batch.
3. Documents are converted to `VectorEntry[]` (`id`, `vector`, `metadata`, `text`).
4. `VectorStore.upsert(collection, entries)` persists data in the selected backend.

Semantic search flow:
1. Caller invokes `SemanticStore.search(collection, queryText, limit, filter?)`.
2. `EmbeddingProvider.embedQuery(queryText)` produces query vector.
3. `VectorStore.search` executes similarity search.
4. Results are mapped to `ScoredDocument[]`; missing text is normalized to `''`.

Collection bootstrap flow:
1. Caller invokes `SemanticStore.ensureCollection(collection, config?)`.
2. Store is checked via `collectionExists`.
3. If absent, `createCollection` is called with:
   - `dimensions` from config or `embedding.dimensions`
   - `metric` defaulting to `'cosine'`

Delete flow:
1. Caller invokes `SemanticStore.delete(collection, filter)`.
2. Filter is forwarded unchanged (`{ ids }` or `{ filter: MetadataFilter }`).

Auto-detect flow:
1. `createAutoEmbeddingProvider` selects provider by env priority:
   - `VOYAGE_API_KEY` -> Voyage
   - `OPENAI_API_KEY` -> OpenAI
   - `COHERE_API_KEY` -> Cohere
   - otherwise throws.
2. `detectVectorProvider` returns provider metadata by env priority:
   - explicit `VECTOR_PROVIDER`
   - `QDRANT_URL`
   - `TURBOPUFFER_API_KEY`
   - `PINECONE_API_KEY`
   - `LANCEDB_URI`
   - fallback `'memory'`.
3. `createAutoSemanticStore` builds `SemanticStore` with detected embedding and `InMemoryVectorStore`.

## Key APIs and Types
Core vector contracts (`types.ts`):
- `DistanceMetric = 'cosine' | 'euclidean' | 'dot_product'`
- `CollectionConfig`
- `VectorEntry`
- `VectorQuery`
- `VectorSearchResult`
- `VectorDeleteFilter`
- `MetadataFilter`
- `VectorStoreHealth`
- `VectorStore` interface

Embedding contracts (`embedding-types.ts`):
- `EmbeddingProvider`
- `EmbeddingProviderConfig`

Semantic wrapper (`semantic-store.ts`):
- `SemanticStore`
- `SemanticStoreConfig`
- `Document`
- `ScoredDocument`

Auto-detection (`auto-detect.ts`):
- `createAutoEmbeddingProvider`
- `detectVectorProvider`
- `createAutoSemanticStore`
- `AutoDetectResult`

Adapters and translation helpers:
- `QdrantAdapter`, `translateQdrantFilter`
- `PineconeAdapter`, `translatePineconeFilter`
- `PgVectorAdapter`
- `ChromaDBAdapter`
- `TurbopufferAdapter`, `translateTurbopufferFilter`
- `LanceDBAdapter`, `translateLanceDBFilter`

Adapter-specific API extensions:
- `LanceDBAdapter.create(...)` async factory with dynamic optional dependency loading.
- `LanceDBAdapter.createFromConnection(...)` test/internal constructor path.
- LanceDB-only methods: `buildFTSIndex`, `upsertArrowTable`, `searchAsArrow`, `getConfig`.

## Dependencies
Internal package dependencies used by this subsystem:
- `../../errors/forge-error.js` (LanceDB adapter uses `ForgeError`).

`@dzupagent/core` package dependencies relevant here:
- `@dzupagent/agent-types`
- `@dzupagent/runtime-contracts`

Optional peer dependencies used directly by vectordb code:
- `@lancedb/lancedb` (required at runtime for `LanceDBAdapter.create`)
- `apache-arrow` (optional runtime path for Arrow helpers in LanceDB adapter)

Runtime platform dependencies:
- `globalThis.fetch` for all HTTP embeddings/adapters (`Qdrant`, `Pinecone`, `ChromaDB`, `Turbopuffer`, and cloud embedding providers).
- `process.env` for provider auto-detection and default LanceDB URI resolution.

## Integration Points
Package exports:
- `src/vectordb/index.ts` is the canonical vectordb barrel and includes LanceDB exports.
- `src/index.ts` re-exports vectordb APIs including Turbopuffer, but currently omits LanceDB exports/types.

Registry integration:
- `src/registry/vector-semantic-search.ts` consumes `SemanticStore`.
- `VectorStoreSemanticSearch` indexes registered agents into `agent_registry` collection.
- Index/remove operations are fire-and-forget and intentionally non-fatal.

Event model integration:
- `src/events/event-types.ts` defines vector-related event payloads (`vector:search_completed`, `vector:upsert_completed`, `vector:embedding_completed`, `vector:error`).
- Current vectordb implementations do not emit these events directly.

## Testing and Observability
Coverage shape (unit tests):
- Type contracts and filter AST compatibility.
- `cosineSimilarity`/`evaluateFilter` behavior and edge cases.
- `InMemoryVectorStore` lifecycle, query semantics, include flags, and dimension validation.
- `SemanticStore` orchestration (`ensureCollection`, batched embed, search mapping, delete delegation).
- Embedding providers:
  - request shape
  - result ordering
  - model/dimension defaults
  - HTTP error handling
  - provider detection precedence.
- Adapter tests for Qdrant/Pinecone/PgVector/Chroma/Turbopuffer/LanceDB:
  - request/SQL generation
  - filter translation
  - score/minScore handling
  - health checks
  - auth header behavior
  - provider precedence checks (`detectVectorProvider`) for Turbopuffer/LanceDB.

Observability currently in code:
- Standardized `healthCheck()` on all `VectorStore` implementations.
- No built-in logging hooks, metrics emitter, or event bus emission inside vectordb classes.

## Risks and TODOs
- `createAutoSemanticStore` ignores `detectVectorProvider` output and always wires `InMemoryVectorStore`; this can hide misconfiguration in production-like environments.
- `SemanticStoreConfig.defaultCollection` exists but is not used by `SemanticStore` methods.
- Root package export mismatch: LanceDB exports exist in `src/vectordb/index.ts` but are not re-exported from `src/index.ts`.
- `TurbopufferAdapter.search` hardcodes cosine metric mapping in request body (`distance_metric` uses cosine constant), not the collection metric.
- `PgVectorAdapter.createCollection` always builds cosine `ivfflat` index (`vector_cosine_ops`) regardless of requested `CollectionConfig.metric`.
- Filter semantics are not portable for `contains` across adapters:
  - Qdrant/Pinecone/Turbopuffer degrade to exact/equality-like behavior.
  - PgVector/Chroma/LanceDB use substring-like semantics.
- LanceDB config fields `hybridSearch` and `vectorWeight` are persisted in config but not used in `search` decision logic.
- Vectordb event types are defined globally but not emitted from vectordb runtime paths.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

