/**
 * QdrantVectorStore — Option A backend for HybridRetriever.
 *
 * Strategy: a single Qdrant collection with `tenantId` payload filter
 * (NOT a collection-per-tenant). This keeps operational footprint small
 * and lets a host wire `HybridRetriever` against a real vector backend
 * without bringing the Qdrant SDK into the framework's required
 * dependency graph.
 *
 * The Qdrant client is loaded via dynamic import — mirrors the
 * `loadBullMQ` pattern in `codev-app/api/queue.service.ts`. If the
 * package is not installed we return `null` from
 * {@link createQdrantRetriever} and {@link QdrantVectorStore.tryCreate}
 * rather than throwing.
 *
 * NOTE: This file deliberately does NOT touch the existing
 * `createQdrantRagPipeline` factory in `../qdrant-factory.ts` which
 * uses the per-tenant-collection adapter from `@dzupagent/core`. Both
 * strategies are valid and target different operational profiles.
 *
 * MC-041: this module is now a thin barrel that re-exports from focused
 * sibling modules. Existing import paths continue to work unchanged.
 */

// --- Public configuration + structural client types -----------------------
export type {
  QdrantClientCtor,
  QdrantClientLike,
  QdrantFilter,
  QdrantFilterClause,
  QdrantRetrieverConfig,
  QdrantVectorStoreConfig,
} from './qdrant-types.js'

// --- Dynamic loader (with test-reset hook) --------------------------------
export {
  __resetQdrantLoaderForTests,
  loadQdrantClient,
} from './qdrant-loader.js'

// --- Vector store wrapper -------------------------------------------------
export { QdrantVectorStore } from './qdrant-store.js'

// --- HybridRetriever wiring -----------------------------------------------
export {
  createQdrantRetriever,
  type QdrantRetrieverWiring,
} from './qdrant-retriever.js'

// --- VectorStore facade for CorpusManager ---------------------------------
export { QdrantCorpusStore } from './qdrant-corpus-store.js'
