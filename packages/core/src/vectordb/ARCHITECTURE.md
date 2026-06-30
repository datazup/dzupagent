# VectorDB Architecture (`packages/core/src/vectordb`)

## Scope
This document covers the vector/embedding subsystem implemented in `packages/core/src/vectordb` within `@dzupagent/core`.

In scope:
- Core contracts and shared utilities: `types.ts`, `embedding-types.ts`, `filter-utils.ts`.
- High-level semantic wrapper: `semantic-store.ts`.
- Auto-detection helpers: `auto-detect.ts`.
- In-memory baseline implementation: `in-memory-vector-store.ts`.
- Embedding providers: `embeddings/*`.
- Vector store adapters: `adapters/*` (Qdrant, Pinecone, Chroma, Turbopuffer, LanceDB).
- Public vectordb barrel: `index.ts`.

Related package-level integration touched by this subsystem:
- `packages/core/src/index.ts` root re-exports.
- `packages/core/src/registry/vector-semantic-search.ts` consumer integration.
- `packages/core/src/events/event-types-platform.ts` vector event type declarations.
- `packages/core/package.json` subpath export `./vectordb`.

## Responsibilities
The subsystem provides a provider-agnostic vector layer for:
- Vector collection lifecycle, upsert/search/delete/count operations via `VectorStore`.
- Text embedding via `EmbeddingProvider`.
- Text-in/text-out semantic operations via `SemanticStore` (embeddings + vector store composition).
- Metadata filter normalization and translation from shared `MetadataFilter` into provider-specific query/filter formats.
- Environment-driven provider detection helpers for bootstrap flows.

Current non-responsibilities:
- It does not emit runtime platform events itself (vector event types are declared elsewhere).
- It does not include built-in centralized logging/metrics/tracing pipelines.
- It does not auto-wire a production vector adapter in `createAutoSemanticStore` (uses `InMemoryVectorStore` only).

## Structure
Top-level vectordb files:
- `types.ts`: `VectorStore` contract and shared vector/filter/search domain types.
- `embedding-types.ts`: `EmbeddingProvider` contract and config shape.
- `filter-utils.ts`: cosine similarity and in-memory metadata filter evaluation.
- `in-memory-vector-store.ts`: brute-force in-memory `VectorStore`.
- `semantic-store.ts`: semantic wrapper over embedding + vector store.
- `auto-detect.ts`: env-based embedding/provider detection and convenience semantic store creation.
- `index.ts`: vectordb public surface/barrel.

Embedding providers (`embeddings/`):
- `openai-embedding.ts`
- `voyage-embedding.ts`
- `cohere-embedding.ts`
- `ollama-embedding.ts`
- `custom-embedding.ts`
- `index.ts` (barrel)

Vector store adapters (`adapters/`):
- `qdrant-adapter.ts`
- `pinecone-adapter.ts`
- `chroma-adapter.ts`
- `turbopuffer-adapter.ts`
- `lancedb-adapter.ts` (public LanceDB barrel)
- `lancedb-adapter-core.ts`
- `lancedb-adapter-types.ts`
- `lancedb-adapter-filter.ts`
- `lancedb-adapter-helpers.ts`
- `lancedb-adapter-arrow.ts`
- `index.ts` (adapter barrel)

Tests currently covering this area:
- `src/vectordb/__tests__/types.test.ts`
- `src/vectordb/__tests__/in-memory-vector-store.test.ts`
- `src/vectordb/__tests__/semantic-store.test.ts`
- `src/vectordb/__tests__/embeddings.test.ts`
- `src/vectordb/__tests__/qdrant-adapter.test.ts`
- `src/vectordb/__tests__/pinecone-adapter.test.ts`
- `src/vectordb/__tests__/chroma-adapter.test.ts`
- `src/__tests__/vectordb/turbopuffer-adapter.test.ts`
- `src/__tests__/lancedb-adapter.test.ts`

## Runtime and Control Flow
1. Semantic upsert flow:
- `SemanticStore.upsert(collection, docs)` extracts text from `Document[]`.
- Calls `EmbeddingProvider.embed(texts)` once per batch.
- Maps documents + vectors to `VectorEntry[]`.
- Delegates persistence to `VectorStore.upsert(collection, entries)`.

2. Semantic query flow:
- `SemanticStore.search(collection, query, limit, filter?)` embeds query text with `embedQuery`.
- Calls `VectorStore.search` with `includeMetadata: true`.
- Normalizes to `ScoredDocument[]` and maps missing `text` to `''`.

3. Collection provisioning flow:
- `SemanticStore.ensureCollection` checks `collectionExists`.
- On missing collection, builds `CollectionConfig` from:
  - `dimensions`: explicit override or `embedding.dimensions`.
  - `metric`: explicit override or `'cosine'`.
  - optional metadata schema.

4. Auto-detection flow:
- `createAutoEmbeddingProvider(env)` precedence:
  - `VOYAGE_API_KEY`
  - `OPENAI_API_KEY`
  - `COHERE_API_KEY`
  - else throws.
- `detectVectorProvider(env)` precedence:
  - `VECTOR_PROVIDER` explicit override
  - `QDRANT_URL`
  - `TURBOPUFFER_API_KEY`
  - `PINECONE_API_KEY`
  - `LANCEDB_URI`
  - fallback `memory`.
- `createAutoSemanticStore(env)` builds:
  - detected embedding provider
  - `InMemoryVectorStore`
  - `SemanticStore`

5. Adapter execution patterns:
- HTTP adapters (`QdrantAdapter`, `PineconeAdapter`, `ChromaDBAdapter`, `TurbopufferAdapter`) call remote APIs through `fetch` (native or injected for tests).
- `LanceDBAdapter` dynamically imports optional peers (`@lancedb/lancedb`, optionally `apache-arrow`) and supports Arrow-related helper paths.

## Key APIs and Types
Core contracts/types:
- `VectorStore`
- `VectorStoreHealth`
- `CollectionConfig`
- `VectorEntry`
- `VectorQuery`
- `VectorSearchResult`
- `VectorDeleteFilter`
- `MetadataFilter`
- `DistanceMetric`

Embedding APIs:
- `EmbeddingProvider`
- `EmbeddingProviderConfig`
- `createOpenAIEmbedding`
- `createVoyageEmbedding`
- `createCohereEmbedding`
- `createOllamaEmbedding`
- `createCustomEmbedding`

Semantic APIs:
- `SemanticStore`
- `SemanticStoreConfig`
- `Document`
- `ScoredDocument`

Auto-detection APIs:
- `createAutoEmbeddingProvider`
- `detectVectorProvider`
- `createAutoSemanticStore`
- `AutoDetectResult`

Adapter APIs:
- `QdrantAdapter`, `translateQdrantFilter`
- `PineconeAdapter`, `translatePineconeFilter`
- `ChromaDBAdapter`
- `TurbopufferAdapter`, `translateTurbopufferFilter`
- `LanceDBAdapter`, `translateLanceDBFilter`

LanceDB-specific extension APIs (beyond `VectorStore`):
- `LanceDBAdapter.create`
- `LanceDBAdapter.createFromConnection`
- `buildFTSIndex`
- `upsertArrowTable`
- `searchAsArrow`
- `getConfig`

## Dependencies
Package dependencies declared in `packages/core/package.json`:
- `@dzupagent/agent-types`
- `@dzupagent/runtime-contracts`
- `@dzupagent/security`

Peer dependencies relevant to vectordb runtime:
- `@lancedb/lancedb` (optional, required for `LanceDBAdapter.create`)
- `apache-arrow` (optional, used by LanceDB Arrow helper paths)
- `@langchain/core`, `@langchain/langgraph`, `zod` are peer deps of the package but not directly required for this vectordb runtime path.

Runtime expectations:
- `globalThis.fetch` for HTTP embedding providers and HTTP vector adapters.
- `process.env` for auto-detection and LanceDB default URI resolution.
- Qdrant is the Datazup local/dev vector database. PostgreSQL is relational-only and is not used as a vector store.

Internal package dependency used in this subsystem:
- LanceDB error signaling uses `ForgeError` from `src/errors/forge-error.ts`.

## Integration Points
Public export surface:
- Subpath export `@dzupagent/core/vectordb` maps to `dist/vectordb/index.js`.
- Root `@dzupagent/core` re-exports most vectordb contracts/providers/adapters from `src/index.ts`.

Current root-vs-subpath asymmetry:
- `src/vectordb/index.ts` exports LanceDB symbols.
- Root `src/index.ts` does not re-export `LanceDBAdapter`, `translateLanceDBFilter`, or `LanceDBAdapterConfig`.
- Consumers needing LanceDB must import from `@dzupagent/core/vectordb`.

Registry integration:
- `VectorStoreSemanticSearch` (`src/registry/vector-semantic-search.ts`) composes `SemanticStore` for agent capability indexing/search in collection `agent_registry`.
- `indexAgent` and `removeAgent` are intentionally fire-and-forget and swallow failures to avoid blocking registry lifecycle operations.

Event contract integration:
- `PlatformDomainEvent` includes vector event variants:
  - `vector:search_completed`
  - `vector:upsert_completed`
  - `vector:embedding_completed`
  - `vector:error`
- Vectordb classes do not emit these events directly; emission must be handled by higher-level orchestration wrappers if needed.

## Testing and Observability
What tests validate today:
- Type-shape compatibility of vectordb contracts.
- In-memory math/filter behavior (`cosineSimilarity`, `evaluateFilter`) and collection/vector lifecycle behavior.
- `SemanticStore` behavior for embedding, batching, filtering, and collection creation defaults.
- Embedding provider request formatting, default dimensions/models, error paths, and ordering guarantees.
- Adapter request/response mapping, filter translation, and score conversion logic across Qdrant/Pinecone/Chroma/Turbopuffer/LanceDB.
- Auto-detection precedence for embedding and vector provider detection (including LanceDB/Turbopuffer branches).
- LanceDB-specific behavior including SQL translation escaping and extension methods (`buildFTSIndex`, `searchAsArrow`, `getConfig`).

Observability available in code:
- Every `VectorStore` implementation exposes `healthCheck(): Promise<VectorStoreHealth>`.
- No built-in subsystem-wide logger/metrics/tracing abstraction is present in this folder.

## Risks and TODOs
- `createAutoSemanticStore` always uses `InMemoryVectorStore` and does not construct adapters from `detectVectorProvider`.
- `SemanticStoreConfig.defaultCollection` is defined but not consumed by current `SemanticStore` methods.
- Root export surface omits LanceDB APIs even though vectordb barrel exports them.
- `TurbopufferAdapter.search` currently sets `distance_metric` from a hardcoded cosine path and does not consult a persisted per-collection metric.
- `TurbopufferAdapter.createCollection` only records the collection locally and does not apply `CollectionConfig` remotely (namespace is materialized on upsert).
- Metadata `contains` behavior is backend-dependent (exact-match fallback for some adapters vs substring SQL/LIKE-style behavior for others).
- LanceDB config fields `hybridSearch` and `vectorWeight` are stored in config but not currently used in the default `search` flow.
- Vector event types exist in platform event unions, but vectordb implementations do not emit them.
- There is no focused unit test for `createAutoSemanticStore` behavior itself.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
