# VectorDB Architecture (`packages/core/src/vectordb`)

## 1. Purpose and Scope

The `vectordb` module in `@dzupagent/core` is a provider-agnostic vector retrieval layer with three primary responsibilities:

1. Define stable contracts (`VectorStore`, `EmbeddingProvider`, shared filter/query types).
2. Provide concrete adapters to multiple backends (Qdrant, Pinecone, pgvector, ChromaDB, Turbopuffer, LanceDB, in-memory).
3. Provide a high-level `SemanticStore` that turns text in/out into vector ops by composing `EmbeddingProvider + VectorStore`.

This folder is the central vector/embedding abstraction used by higher-level packages (`rag`, `memory`, `codegen`, registry search, server CLI status checks, and eval contract suites).

---

## 2. Module Map

### Core contracts and utilities

- `types.ts`
  - Provider-agnostic vector contracts: `VectorStore`, `VectorEntry`, `VectorQuery`, `MetadataFilter`, etc.
- `embedding-types.ts`
  - `EmbeddingProvider` interface contract.
- `filter-utils.ts`
  - `cosineSimilarity()` and in-process metadata filter evaluator.
- `in-memory-vector-store.ts`
  - Brute-force in-memory `VectorStore` implementation.
- `semantic-store.ts`
  - Text-first facade over store+embedding.
- `auto-detect.ts`
  - Env-based provider detection helpers.
- `index.ts`
  - Barrel export for all vectordb APIs.

### Embedding providers (`embeddings/*`)

- `openai-embedding.ts`
- `voyage-embedding.ts`
- `cohere-embedding.ts`
- `ollama-embedding.ts`
- `custom-embedding.ts`

### Vector backend adapters (`adapters/*`)

- `qdrant-adapter.ts`
- `pinecone-adapter.ts`
- `pgvector-adapter.ts`
- `chroma-adapter.ts`
- `turbopuffer-adapter.ts`
- `lancedb-adapter.ts`

---

## 3. Core Abstractions

## 3.1 `VectorStore`

`VectorStore` is the core persistence/query contract:

- Collection lifecycle:
  - `createCollection`
  - `deleteCollection`
  - `listCollections`
  - `collectionExists`
- Vector lifecycle:
  - `upsert`
  - `search`
  - `delete`
  - `count`
- Health/lifecycle:
  - `healthCheck`
  - `close`

Each adapter must implement this API regardless of backend-specific transport and filter syntax.

## 3.2 `EmbeddingProvider`

`EmbeddingProvider` exposes:

- `modelId`
- `dimensions`
- `embed(texts: string[])`
- `embedQuery(text: string)`

Implementations use raw `fetch()` and keep SDK dependencies out of `core`.

## 3.3 `SemanticStore`

`SemanticStore` composes `EmbeddingProvider + VectorStore` and offers text-based operations:

- `ensureCollection()`
- `upsert(collection, docs[])` (auto-embeds text)
- `search(collection, queryText, limit, filter?)` (embeds query + vector search)
- `delete(...)`

This lets callers avoid direct vector math and work in document/query text form.

---

## 4. End-to-End Flow

## 4.1 Document ingest flow

1. Caller sends documents (`id`, `text`, optional metadata) to `SemanticStore.upsert()`.
2. `SemanticStore` batch-calls `EmbeddingProvider.embed(texts)`.
3. `SemanticStore` maps documents into `VectorEntry[]`.
4. `VectorStore.upsert()` writes entries to backend.

## 4.2 Query flow

1. Caller invokes `SemanticStore.search(collection, queryText, limit, filter?)`.
2. Query text is embedded with `EmbeddingProvider.embedQuery()`.
3. Vector query is sent to `VectorStore.search()`.
4. Adapter maps backend response to `VectorSearchResult[]`.
5. `SemanticStore` normalizes to `ScoredDocument[]`.

## 4.3 Deletion flow

- IDs path: `delete(collection, { ids: [...] })`.
- Filter path: `delete(collection, { filter: MetadataFilter })`.

Both flows are normalized in contract and translated per adapter.

## 4.4 Health/status flow

- Call `VectorStore.healthCheck()`.
- In `server`, this powers `vectordbStatus()` and status formatting.

---

## 5. Feature Matrix

| Component | Key features |
|---|---|
| `types.ts` | Normalized query/filter/delete contracts across providers |
| `filter-utils.ts` | Deterministic cosine + local metadata filter evaluator |
| `InMemoryVectorStore` | Zero-dependency O(n) search, good for tests/dev |
| `SemanticStore` | Text-in/text-out wrapper with automatic embedding |
| `auto-detect.ts` | Environment-driven embedding/provider selection |
| Embedding providers | OpenAI, Voyage, Cohere, Ollama, Custom |
| Adapters | Qdrant, Pinecone, pgvector, ChromaDB, Turbopuffer, LanceDB |

---

## 6. Adapter Behavior Notes

## 6.1 Qdrant

- Uses REST API via `fetch`.
- Maps `DistanceMetric` to Qdrant names (`Cosine`, `Euclid`, `Dot`).
- Supports metadata filter translation into Qdrant condition trees.
- Health check: `GET /healthz`.
- `contains` filter is approximated as exact `match.value` (not substring full-text).

## 6.2 Pinecone

- Uses control plane (`https://api.pinecone.io`) and data plane (resolved index host).
- Host resolution cached per collection.
- Supports serverless create-index spec.
- Client-side `minScore` filtering after query response.
- `contains` maps to `$eq` (exact match fallback).

## 6.3 pgvector

- Uses caller-provided `queryFn(sql, params)` (no hard dependency on pg client/ORM).
- Strong SQL injection posture via parameterized values + sanitized identifiers.
- Table naming controlled by `tablePrefix` + validated collection names.
- Metadata filter translated to SQL (`AND`/`OR`, `IN`, `ILIKE`, numeric casts).
- Current behavior: search score and index operator are cosine-oriented (`vector <=> ...`, `vector_cosine_ops`).

## 6.4 ChromaDB

- Uses REST API with optional tenant/database path segments.
- Caches collection UUID by name.
- Converts Chroma distance to score (`score = 1 - distance`).
- Supports metadata filters translated to Chroma `$` operators.

## 6.5 Turbopuffer

- Maps collection to namespace (`namespacePrefix` optional).
- Uses columnar attributes for upsert/search payload.
- Supports pagination in `listCollections` and retries on 429.
- Converts distance to score (`1 - distance`).
- Current behavior: query `distance_metric` is hardcoded to cosine-distance mapping.

## 6.6 LanceDB

- Embedded Arrow-native adapter with async factory (`LanceDBAdapter.create`).
- Optional peer dependency (`@lancedb/lancedb`) loaded dynamically.
- Exposes LanceDB-specific extensions:
  - `buildFTSIndex()`
  - `upsertArrowTable()`
  - `searchAsArrow()`
  - `getConfig()`
- Flattens metadata fields into table columns.
- `hybridSearch`/`vectorWeight` are part of config shape but not yet used in search execution logic.

## 6.7 In-memory

- Uses `Map<string, CollectionData>` and brute-force cosine search.
- Enforces vector dimensionality on upsert.
- Useful for tests/dev/prototyping; not intended for large production workloads.

---

## 7. Auto-Detection and Bootstrapping

## 7.1 Embedding auto-detect (`createAutoEmbeddingProvider`)

Priority order:

1. `VOYAGE_API_KEY`
2. `OPENAI_API_KEY`
3. `COHERE_API_KEY`
4. Throws if none found.

## 7.2 Vector provider detect (`detectVectorProvider`)

Priority order:

1. `VECTOR_PROVIDER` (explicit override)
2. `QDRANT_URL`
3. `TURBOPUFFER_API_KEY`
4. `PINECONE_API_KEY`
5. `LANCEDB_URI`
6. fallback `memory`

This returns provider+config metadata only; it does not instantiate an adapter.

## 7.3 `createAutoSemanticStore`

`createAutoSemanticStore` creates:

- auto-detected embedding provider
- `InMemoryVectorStore`
- composed `SemanticStore`

This is a convenience path for development/testing, not full production backend auto-wiring.

---

## 8. Usage Examples

## 8.1 Minimal local semantic store (no external vector DB)

```ts
import {
  SemanticStore,
  InMemoryVectorStore,
  createCustomEmbedding,
} from '@dzupagent/core'

const embedding = createCustomEmbedding({
  modelId: 'demo',
  dimensions: 3,
  embedFn: async (texts) => texts.map((t) => [t.length, 1, 0]),
})

const semantic = new SemanticStore({
  embedding,
  vectorStore: new InMemoryVectorStore(),
})

await semantic.ensureCollection('docs')
await semantic.upsert('docs', [
  { id: 'a', text: 'hello world', metadata: { topic: 'greeting' } },
])

const hits = await semantic.search('docs', 'hello', 5)
```

## 8.2 Qdrant-backed setup

```ts
import {
  SemanticStore,
  QdrantAdapter,
  createOpenAIEmbedding,
} from '@dzupagent/core'

const embedding = createOpenAIEmbedding({ apiKey: process.env.OPENAI_API_KEY! })
const store = new QdrantAdapter({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
})

const semantic = new SemanticStore({ embedding, vectorStore: store })
await semantic.ensureCollection('knowledge', { dimensions: embedding.dimensions })
```

## 8.3 Detect provider metadata from env

```ts
import { detectVectorProvider } from '@dzupagent/core'

const detected = detectVectorProvider(process.env as Record<string, string | undefined>)
// { provider: 'qdrant' | 'pinecone' | 'turbopuffer' | 'lancedb' | 'memory' | ... , config: {...} }
```

## 8.4 RAG pipeline injection

```ts
import { RagPipeline } from '@dzupagent/rag'
import { createOpenAIEmbedding, InMemoryVectorStore } from '@dzupagent/core'

const embeddingProvider = createOpenAIEmbedding({ apiKey: process.env.OPENAI_API_KEY! })
const vectorStore = new InMemoryVectorStore()

const pipeline = new RagPipeline({}, { embeddingProvider, vectorStore })
```

---

## 9. Where This Is Referenced in Other Packages

## 9.1 `packages/rag`

- `packages/rag/src/pipeline.ts`
  - Injects `EmbeddingProvider` + `VectorStore` from `@dzupagent/core`.
  - Uses vector upsert during ingest and retrieval through a retriever strategy.

## 9.2 `packages/memory`

- `packages/memory/src/memory-types.ts`
  - Defines `SemanticStoreAdapter` intentionally compatible with core `SemanticStore` shape.
- `packages/memory/src/memory-service.ts`
  - Auto-indexes memory records into semantic collections (`memory_<namespace>`).
  - Fuses keyword search and vector search via RRF.
- `packages/memory/src/retrieval/vector-store-search.ts`
  - Adapter that delegates search to semantic store.
- `packages/memory/src/convention/convention-extractor.ts`
  - Optionally embeds conventions into a semantic collection and uses semantic re-ranking.

## 9.3 `packages/codegen`

- `packages/codegen/src/search/code-search-service.ts`
  - Uses `SemanticStore` for AST-chunked code indexing and semantic code retrieval.
  - Applies metadata filters (language, file path, symbol kind).

## 9.4 `packages/core` registry

- `packages/core/src/registry/vector-semantic-search.ts`
  - Uses `SemanticStore` for agent capability indexing and semantic agent discovery.

## 9.5 `packages/server`

- `packages/server/src/cli/vectordb-command.ts`
  - Consumes `VectorStore` interface to expose provider health and collection counts.
- `packages/server/src/persistence/postgres-stores.ts`
  - Implements an independent `DrizzleVectorStore` concept (not implementing core `VectorStore`, but functionally similar).

## 9.6 `packages/evals`

- `packages/evals/src/contracts/suites/vector-store-contract.ts`
  - Contract suite for any `VectorStore` implementation.
- `packages/evals/src/contracts/suites/embedding-provider-contract.ts`
  - Contract suite for any `EmbeddingProvider` implementation.

## 9.7 `packages/domain-nl2sql`

- `packages/domain-nl2sql/src/embedding/schema-embedding-pipeline.ts`
  - Re-declares minimal vector/embedding interfaces to avoid build-order coupling.
  - Runtime usage is still compatible with core abstractions.

---

## 10. Test Coverage

### 10.1 Direct vectordb suites in `packages/core`

- `src/vectordb/__tests__/types.test.ts` (21)
- `src/vectordb/__tests__/in-memory-vector-store.test.ts` (37)
- `src/vectordb/__tests__/semantic-store.test.ts` (18)
- `src/vectordb/__tests__/embeddings.test.ts` (37)
- `src/vectordb/__tests__/qdrant-adapter.test.ts` (31)
- `src/vectordb/__tests__/pinecone-adapter.test.ts` (31)
- `src/vectordb/__tests__/pgvector-adapter.test.ts` (25)
- `src/vectordb/__tests__/chroma-adapter.test.ts` (25)

### 10.2 Additional adapter suites located outside `src/vectordb/__tests__`

- `src/__tests__/vectordb/turbopuffer-adapter.test.ts` (36)
- `src/__tests__/lancedb-adapter.test.ts` (46)

### 10.3 Executed verification

Command run:

```bash
yarn workspace @dzupagent/core test src/vectordb/__tests__ src/__tests__/lancedb-adapter.test.ts src/__tests__/vectordb/turbopuffer-adapter.test.ts
```

Observed result:

- `10` test files passed
- `307` tests passed
- `0` failed

### 10.4 Coverage depth by concern

- Core contracts and typing: covered (`types`, filter shapes, health shape).
- Utility math/filter behavior: covered (`cosineSimilarity`, metadata filter evaluation).
- Semantic orchestration: covered (`ensureCollection`, batch embedding, search, delete).
- Embedding adapters: covered for API shape, defaults, errors, dimension behavior, auto-detect.
- Vector adapters: covered for CRUD/search/filter translation/health/error handling across all adapters.
- Provider auto-detection: covered for priority rules, including Turbopuffer/LanceDB precedence tests.

### 10.5 Remaining practical gaps (design-level)

- Most adapter tests are mocked network/connection tests; full live backend integration is out of scope here.
- Cross-package end-to-end scenarios (e.g., real `rag`/`memory` + external vector backend) are validated indirectly, not by a unified integration suite in this folder.

---

## 11. Public API Notes

- `packages/core/src/vectordb/index.ts` exports all vectordb symbols including LanceDB adapter types.
- `packages/core/src/index.ts` re-exports the main vectordb surface used by consumers.
- Current root re-export list includes Qdrant/Pinecone/PgVector/Chroma/Turbopuffer and semantic/embedding utilities; verify root exports explicitly when introducing new adapters.

