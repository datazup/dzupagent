/**
 * Public configuration and structural client types for the Qdrant
 * Option-A provider (single shared collection + `tenantId` payload
 * filter). Kept SDK-agnostic so tests can pass plain objects via the
 * `client` test seam.
 */

// ---------------------------------------------------------------------------
// Public configuration
// ---------------------------------------------------------------------------

/** Configuration for the Qdrant vector store. */
export interface QdrantVectorStoreConfig {
  /** Qdrant server URL (e.g. `http://localhost:6333`). */
  url: string
  /** Qdrant API key (omit for unauthenticated servers). */
  apiKey?: string
  /** Single shared collection name (Option A — tenants isolated by filter). */
  collectionName: string
  /**
   * Test seam: inject a pre-built client to bypass the dynamic import.
   * When provided, `loadQdrantClient` is not called.
   */
  client?: QdrantClientLike
}

/** Configuration for the Qdrant retriever wiring. */
export interface QdrantRetrieverConfig extends QdrantVectorStoreConfig {
  /**
   * Optional default tenant id applied to every search when the
   * caller's `filter` argument does not already carry one. Most callers
   * pass `tenantId` per-request via the filter; this is a safety net.
   */
  defaultTenantId?: string
  /**
   * Hook that maps a Qdrant point payload to the `text` surface
   * expected by `HybridRetriever`. Defaults to
   * `payload.text` then empty string.
   */
  textField?: string
}

// ---------------------------------------------------------------------------
// Minimal client surface (structural typing)
// ---------------------------------------------------------------------------

/**
 * Structural subset of the @qdrant/js-client-rest `QdrantClient` we
 * actually use. Keeps this file decoupled from the SDK's TS types so
 * tests can supply a plain object via `config.client`.
 */
export interface QdrantClientLike {
  upsert: (
    collectionName: string,
    body: {
      points: Array<{
        id: string | number
        vector: number[]
        payload?: Record<string, unknown>
      }>
    },
  ) => Promise<unknown>
  search: (
    collectionName: string,
    body: {
      vector: number[]
      limit: number
      with_payload?: boolean
      filter?: QdrantFilter
      score_threshold?: number
    },
  ) => Promise<
    Array<{
      id: string | number
      score: number
      payload?: Record<string, unknown> | null
    }>
  >
  scroll: (
    collectionName: string,
    body: {
      limit: number
      with_payload?: boolean
      filter?: QdrantFilter
    },
  ) => Promise<{
    points: Array<{
      id: string | number
      payload?: Record<string, unknown> | null
    }>
  }>
}

/** Top-level Qdrant filter, only the bits we emit. */
export interface QdrantFilter {
  must?: QdrantFilterClause[]
  must_not?: QdrantFilterClause[]
  should?: QdrantFilterClause[]
}

/** Single filter clause we may emit. */
export interface QdrantFilterClause {
  key: string
  match: { value: string | number | boolean } | { any: Array<string | number> }
}

/** Constructor signature exposed by `@qdrant/js-client-rest`. */
export type QdrantClientCtor = new (config: { url: string; apiKey?: string }) => QdrantClientLike
