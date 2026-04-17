# VectorDB Architecture (`packages/core/src/vectordb`)

## Scope
This document covers the vector subsystem in `packages/core/src/vectordb` and immediate package-level integration points in `packages/core/src/index.ts`, `packages/core/src/registry/vector-semantic-search.ts`, and `packages/core/src/events/event-types.ts`.

Code in scope:
- `types.ts`
- `embedding-types.ts`
- `filter-utils.ts`
- `in-memory-vector-store.ts`
- `semantic-store.ts`
- `auto-detect.ts`
- `index.ts`
- `embeddings/openai-embedding.ts`
- `embeddings/voyage-embedding.ts`
- `embeddings/cohere-embedding.ts`
- `embeddings/ollama-embedding.ts`
- `embeddings/custom-embedding.ts`
- `adapters/qdrant-adapter.ts`
- `adapters/pinecone-adapter.ts`
- `adapters/pgvector-adapter.ts`
- `adapters/chroma-adapter.ts`
- `adapters/turbopuffer-adapter.ts`
- `adapters/lancedb-adapter.ts`

Tests in scope:
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
The module provides a provider-agnostic vector layer with three main responsibilities:

1. Define stable vector and embedding contracts.
2. Implement multiple vector and embedding providers.
3. Provide a text-first semantic wrapper (`SemanticStore`) over vector operations.

Operational responsibilities:
- Collection lifecycle management.
- Vector upsert, similarity search, and deletion.
- Metadata filter normalization and adapter translation.
- Basic health reporting via `healthCheck()`.
- Environment-based provider auto-detection helpers.

## Structure
Core contracts and orchestration:
- `types.ts`: `VectorStore` and shared vector/filter/query contracts.
- `embedding-types.ts`: `EmbeddingProvider` contract.
- `filter-utils.ts`: `cosineSimilarity` and `evaluateFilter`.
- `in-memory-vector-store.ts`: in-process `VectorStore` implementation.
- `semantic-store.ts`: text input/output wrapper around `EmbeddingProvider + VectorStore`.
- `auto-detect.ts`: environment-based embedding/provider detection utilities.
- `index.ts`: vectordb barrel exports.

Embedding implementations:
- `createOpenAIEmbedding`.
- `createVoyageEmbedding`.
- `createCohereEmbedding`.
- `createOllamaEmbedding`.
- `createCustomEmbedding`.

Vector adapters:
- `QdrantAdapter`.
- `PineconeAdapter`.
- `PgVectorAdapter`.
- `ChromaDBAdapter`.
- `TurbopufferAdapter`.
- `LanceDBAdapter`.

## Runtime and Control Flow
Semantic write path:
1. Caller sends `Document[]` to `SemanticStore.upsert(collection, docs)`.
2. `EmbeddingProvider.embed(texts)` runs once for the batch.
3. Results are mapped to `VectorEntry[]`.
4. `VectorStore.upsert(collection, entries)` persists vectors.

Semantic query path:
1. Caller invokes `SemanticStore.search(collection, queryText, limit, filter?)`.
2. `EmbeddingProvider.embedQuery(queryText)` generates query vector.
3. `VectorStore.search` runs similarity search.
4. `SemanticStore` maps provider output to `ScoredDocument[]`.

Collection bootstrap path:
1. Caller invokes `SemanticStore.ensureCollection(collection, config?)`.
2. Store existence is checked via `collectionExists`.
3. If missing, collection is created using provided config or embedding defaults.

Delete path:
1. Caller passes `{ ids: string[] }` or `{ filter: MetadataFilter }`.
2. `SemanticStore.delete` forwards to `VectorStore.delete` unchanged.

Auto-detect path:
1. `createAutoEmbeddingProvider` resolves provider from env priority.
2. `detectVectorProvider` resolves backend metadata from env priority.
3. `createAutoSemanticStore` creates `SemanticStore` with detected embedding and `InMemoryVectorStore`.

## Key APIs and Types
Primary types:
- `DistanceMetric = 'cosine' | 'euclidean' | 'dot_product'`.
- `CollectionConfig`.
- `VectorEntry`.
- `VectorQuery`.
- `VectorSearchResult`.
- `VectorDeleteFilter`.
- `MetadataFilter`.
- `VectorStoreHealth`.
- `EmbeddingProvider`.
- `EmbeddingProviderConfig`.
- `SemanticStoreConfig`.
- `Document`.
- `ScoredDocument`.

Primary interfaces and classes:
- `VectorStore`.
- `InMemoryVectorStore`.
- `SemanticStore`.
- `QdrantAdapter`.
- `PineconeAdapter`.
- `PgVectorAdapter`.
- `ChromaDBAdapter`.
- `TurbopufferAdapter`.
- `LanceDBAdapter`.

Factory and utility APIs:
- `createOpenAIEmbedding`.
- `createVoyageEmbedding`.
- `createCohereEmbedding`.
- `createOllamaEmbedding`.
- `createCustomEmbedding`.
- `createAutoEmbeddingProvider`.
- `detectVectorProvider`.
- `createAutoSemanticStore`.
- `cosineSimilarity`.
- `evaluateFilter`.
- `translateQdrantFilter`.
- `translatePineconeFilter`.
- `translateTurbopufferFilter`.
- `translateLanceDBFilter`.

Current adapter behavior notes:
- Qdrant: REST API with optional `api-key` header; `contains` is translated as exact match.
- Pinecone: control-plane plus data-plane host lookup; `contains` maps to `$eq`; `minScore` is filtered client-side.
- pgvector: uses injected `queryFn`; identifier sanitization plus parameterized values.
- ChromaDB: caches collection UUIDs; converts distance to score using `1 - distance`.
- Turbopuffer: namespace-based storage, batched upserts, retry on HTTP 429.
- LanceDB: async factory with dynamic import and extra methods `buildFTSIndex`, `upsertArrowTable`, `searchAsArrow`, `getConfig`.

## Dependencies
Package dependencies relevant to this module:
- `@dzupagent/context`.
- `@dzupagent/memory`.
- `@dzupagent/runtime-contracts`.

Peer dependencies relevant to this module:
- `@lancedb/lancedb` (optional, required for `LanceDBAdapter.create`).
- `apache-arrow` (optional, used by LanceDB Arrow paths).

Runtime dependencies:
- `globalThis.fetch` for HTTP-based adapters and embedding providers.
- Environment variables for auto-detection in `auto-detect.ts`.

Internal dependencies:
- `adapters/lancedb-adapter.ts` uses `ForgeError` from `src/errors/forge-error.ts`.

## Integration Points
Package exports:
- `src/vectordb/index.ts` exports all vectordb contracts/adapters including LanceDB.
- `src/index.ts` re-exports most vectordb APIs, including Turbopuffer.
- `src/index.ts` currently does not re-export LanceDB symbols.
- `src/stable.ts` is facade-only and does not expose vectordb.
- `src/advanced.ts` mirrors `src/index.ts`.

Registry integration:
- `src/registry/vector-semantic-search.ts` depends on `SemanticStore`.
- Indexing and deletion in `VectorStoreSemanticSearch` are fire-and-forget and intentionally non-fatal.

Event model integration:
- `src/events/event-types.ts` defines vector event payloads.
- `src/vectordb` code does not emit these events directly.

## Testing and Observability
Testing coverage is extensive at unit level for contracts, filters, semantic orchestration, adapter translation, error handling, and provider detection.

Covered areas:
- Core types and filter semantics.
- In-memory store correctness and dimension validation.
- Semantic wrapper behavior (`ensureCollection`, batch embed, query, delete).
- Embedding providers and auto-detection precedence.
- Adapter-specific request/response mapping, filtering, and health behavior.
- Turbopuffer rate-limit retry behavior.
- pgvector SQL generation and injection-safety expectations.
- LanceDB dynamic dependency and Arrow fallback behavior.

Observability in module:
- Built-in observability is limited to `VectorStore.healthCheck()`.
- No direct logging, metrics emission, or event-bus instrumentation exists in `src/vectordb`.

## Risks and TODOs
- `createAutoSemanticStore` ignores detected vector backend and always uses `InMemoryVectorStore`.
- `SemanticStoreConfig.defaultCollection` exists but is not used by `SemanticStore`.
- Export surface mismatch: LanceDB is exported from `src/vectordb/index.ts` but not re-exported from package root `src/index.ts`.
- `TurbopufferAdapter.search` hardcodes cosine distance mapping and does not use collection metric.
- `PgVectorAdapter` currently creates cosine ivfflat index and uses cosine scoring path regardless of `CollectionConfig.metric`.
- `contains` semantics differ by backend, so behavior is not portable across all adapters.
- LanceDB config fields `hybridSearch` and `vectorWeight` are accepted/stored but not applied in `search` execution.
- Vector event types are defined centrally but not emitted by vectordb implementations.

## Changelog
- 2026-04-16: automated refresh via scripts/refresh-architecture-docs.js