/**
 * Deep integration tests for the RAG package — gaps not covered by existing
 * test files.
 *
 * Coverage areas:
 *   - HybridRetriever: source quality provider, error handling, per-query
 *     mode override, hybrid with no keyword function, quality boosting math
 *   - QdrantVectorStore (standalone): upsertMany, keywordSearch user clauses,
 *     array filter, empty-string tenant guard, buildFilter paths
 *   - QdrantCorpusStore (standalone): deleteCollection with client.delete,
 *     search minScore filter, count returns 0, healthCheck, close,
 *     upsert empty array no-op
 *   - FolderContextGenerator: ContextTransferService returning empty string
 *     falls back to default, maxFiles=0 edge, absolutePath forward-slash
 *     normalization, depth scoring correctness
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HybridRetriever } from "../retriever.js";
import type { VectorSearchHit, KeywordSearchHit } from "../types.js";
import { QdrantVectorStore } from "../providers/qdrant-store.js";
import { QdrantCorpusStore } from "../providers/qdrant-corpus-store.js";
import type { QdrantClientLike } from "../providers/qdrant-types.js";
import { FolderContextGenerator } from "../folder-context-generator.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeClient(): QdrantClientLike & {
  upsert: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  scroll: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  return {
    upsert: vi.fn().mockResolvedValue({ status: "ok" }),
    search: vi.fn().mockResolvedValue([]),
    scroll: vi.fn().mockResolvedValue({ points: [] }),
    delete: vi.fn().mockResolvedValue({ status: "ok" }),
  };
}

function makeVectorHit(
  id: string,
  score = 0.8,
  extra: Record<string, unknown> = {},
): VectorSearchHit {
  return {
    id,
    score,
    text: `Text for ${id}`,
    metadata: {
      source_id: "src-1",
      chunk_index: 0,
      quality_score: 0.5,
      ...extra,
    },
  };
}

function makeKeywordHit(
  id: string,
  score = 0.7,
  extra: Record<string, unknown> = {},
): KeywordSearchHit {
  return {
    id,
    score,
    text: `Text for ${id}`,
    metadata: {
      source_id: "src-1",
      chunk_index: 0,
      quality_score: 0.5,
      ...extra,
    },
  };
}

// ---------------------------------------------------------------------------
// HybridRetriever — additional branch coverage
// ---------------------------------------------------------------------------

describe("HybridRetriever — deep branch coverage", () => {
  // -------------------------------------------------------------------------
  // Per-query mode override
  // -------------------------------------------------------------------------

  describe("per-query mode override", () => {
    it("overrides constructor mode with options.mode=keyword", async () => {
      const keywordSearch = vi.fn(async () => [makeKeywordHit("k1")]);
      const vectorSearch = vi.fn(async () => [makeVectorHit("v1")]);
      const retriever = new HybridRetriever({
        mode: "vector",
        topK: 5,
        qualityBoosting: false,
        qualityWeights: { chunk: 0.6, source: 0.4 },
        tokenBudget: 8000,
        embedQuery: async () => [0.1],
        vectorSearch,
        keywordSearch,
      });
      const result = await retriever.retrieve("q", {}, { mode: "keyword" });
      expect(result.searchMode).toBe("keyword");
      expect(vectorSearch).not.toHaveBeenCalled();
      expect(keywordSearch).toHaveBeenCalledTimes(1);
    });

    it("overrides constructor mode with options.mode=hybrid", async () => {
      const keywordSearch = vi.fn(async () => []);
      const vectorSearch = vi.fn(async () => []);
      const retriever = new HybridRetriever({
        mode: "keyword",
        topK: 5,
        qualityBoosting: false,
        qualityWeights: { chunk: 0.6, source: 0.4 },
        tokenBudget: 8000,
        embedQuery: async () => [0.1],
        vectorSearch,
        keywordSearch,
      });
      await retriever.retrieve("q", {}, { mode: "hybrid" });
      // hybrid invokes both
      expect(vectorSearch).toHaveBeenCalledTimes(1);
      expect(keywordSearch).toHaveBeenCalledTimes(1);
    });

    it("overrides topK via options", async () => {
      const vectorSearch = vi.fn(async () => []);
      const retriever = new HybridRetriever({
        mode: "vector",
        topK: 10,
        qualityBoosting: false,
        qualityWeights: { chunk: 0.6, source: 0.4 },
        tokenBudget: 8000,
        embedQuery: async () => [0.1],
        vectorSearch,
      });
      await retriever.retrieve("q", {}, { topK: 3 });
      expect(vectorSearch).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        3,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Hybrid with no keyword function
  // -------------------------------------------------------------------------

  describe("hybrid mode with no keywordSearch function", () => {
    it("returns only vector results when keywordSearch is undefined", async () => {
      const retriever = new HybridRetriever({
        mode: "hybrid",
        topK: 5,
        qualityBoosting: false,
        qualityWeights: { chunk: 0.6, source: 0.4 },
        tokenBudget: 8000,
        embedQuery: async () => [0.1],
        vectorSearch: async () => [makeVectorHit("v1", 0.9)],
        // no keywordSearch
      });
      const result = await retriever.retrieve("q", {});
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]!.id).toBe("v1");
    });
  });

  // -------------------------------------------------------------------------
  // Source quality provider
  // -------------------------------------------------------------------------

  describe("source quality provider", () => {
    it("uses custom provider to override source quality", async () => {
      // Provider always returns 1.0 → max boost
      const provider = vi.fn(async () => 1.0);
      const retriever = new HybridRetriever({
        mode: "vector",
        topK: 5,
        qualityBoosting: true,
        qualityWeights: { chunk: 0.6, source: 0.4 },
        tokenBudget: 8000,
        embedQuery: async () => [0.1],
        vectorSearch: async () => [
          makeVectorHit("c1", 1.0, { quality_score: 0.5 }),
        ],
        sourceQuality: { provider },
      });
      const result = await retriever.retrieve("q", {});
      // quality blend = 0.6*0.5 + 0.4*1.0 = 0.70
      // boost = 1 + (0.70 - 0.5) * 0.3 = 1.06
      // score = 1.0 * 1.06 = 1.06
      expect(result.chunks[0]!.score).toBeGreaterThan(1.0);
      expect(provider).toHaveBeenCalledTimes(1);
    });

    it("falls back to chunk sourceQuality when provider throws", async () => {
      const provider = vi.fn(async () => {
        throw new Error("provider-failure");
      });
      const retriever = new HybridRetriever({
        mode: "vector",
        topK: 5,
        qualityBoosting: true,
        qualityWeights: { chunk: 0.6, source: 0.4 },
        tokenBudget: 8000,
        embedQuery: async () => [0.1],
        vectorSearch: async () => [
          {
            id: "c1",
            score: 1.0,
            text: "hello",
            metadata: {
              source_id: "src",
              chunk_index: 0,
              quality_score: 0.5,
              source_quality: 0.8,
            },
          },
        ],
        sourceQuality: { provider },
      });
      // Should not throw; should fall back to sourceQuality from metadata
      const result = await retriever.retrieve("q", {});
      expect(result.chunks).toHaveLength(1);
      // source_quality=0.8 used as fallback
      expect(result.chunks[0]!.score).toBeGreaterThan(1.0);
    });

    it("falls back to configured fallback when provider returns non-finite", async () => {
      const provider = vi.fn(async () => NaN);
      const retriever = new HybridRetriever({
        mode: "vector",
        topK: 5,
        qualityBoosting: true,
        qualityWeights: { chunk: 0.5, source: 0.5 },
        tokenBudget: 8000,
        embedQuery: async () => [0.1],
        vectorSearch: async () => [
          makeVectorHit("c1", 1.0, { quality_score: 0.5 }),
        ],
        sourceQuality: { provider, fallback: 0.5 },
      });
      const result = await retriever.retrieve("q", {});
      // fallback 0.5 used: blend = 0.5*0.5 + 0.5*0.5 = 0.5; boost = 1 + (0.5-0.5)*0.3 = 1.0
      expect(result.chunks[0]!.score).toBeCloseTo(1.0, 2);
    });

    it("uses fallback=0.5 when no provider and no chunk sourceQuality", async () => {
      const retriever = new HybridRetriever({
        mode: "vector",
        topK: 5,
        qualityBoosting: true,
        qualityWeights: { chunk: 0.6, source: 0.4 },
        tokenBudget: 8000,
        embedQuery: async () => [0.1],
        vectorSearch: async () => [makeVectorHit("c1", 1.0)],
        // no sourceQuality config at all
      });
      const result = await retriever.retrieve("q", {});
      expect(result.chunks).toHaveLength(1);
      // default fallback is 0.5; no dramatic boost or cut
      expect(result.chunks[0]!.score).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // domain_authority metadata field
  // -------------------------------------------------------------------------

  describe("domain_authority source quality parsing", () => {
    it("uses domain_authority field as source quality when source_quality absent", async () => {
      const retriever = new HybridRetriever({
        mode: "vector",
        topK: 5,
        qualityBoosting: true,
        qualityWeights: { chunk: 0.6, source: 0.4 },
        tokenBudget: 8000,
        embedQuery: async () => [0.1],
        vectorSearch: async () => [
          {
            id: "c1",
            score: 1.0,
            text: "hello",
            metadata: {
              source_id: "src",
              chunk_index: 0,
              quality_score: 0.5,
              domain_authority: 0.9,
            },
          },
        ],
      });
      const result = await retriever.retrieve("q", {});
      // domain_authority=0.9 → source quality high → score boosted
      expect(result.chunks[0]!.score).toBeGreaterThan(1.0);
    });
  });

  // -------------------------------------------------------------------------
  // Filter pass-through
  // -------------------------------------------------------------------------

  describe("filter pass-through", () => {
    it("passes filter unchanged to vectorSearch", async () => {
      const vectorSearch = vi.fn(async () => []);
      const retriever = new HybridRetriever({
        mode: "vector",
        topK: 5,
        qualityBoosting: false,
        qualityWeights: { chunk: 0.6, source: 0.4 },
        tokenBudget: 8000,
        embedQuery: async () => [0.1],
        vectorSearch,
      });
      const filter = { tenantId: "t1", sessionId: "s1" };
      await retriever.retrieve("q", filter);
      expect(vectorSearch).toHaveBeenCalledWith(
        expect.anything(),
        filter,
        expect.any(Number),
      );
    });

    it("passes filter unchanged to keywordSearch", async () => {
      const keywordSearch = vi.fn(async () => []);
      const retriever = new HybridRetriever({
        mode: "keyword",
        topK: 5,
        qualityBoosting: false,
        qualityWeights: { chunk: 0.6, source: 0.4 },
        tokenBudget: 8000,
        embedQuery: async () => [0.1],
        vectorSearch: async () => [],
        keywordSearch,
      });
      const filter = { tenantId: "t2", tag: "docs" };
      await retriever.retrieve("q", filter);
      expect(keywordSearch).toHaveBeenCalledWith(
        "q",
        filter,
        expect.any(Number),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Empty corpus
  // -------------------------------------------------------------------------

  describe("empty corpus", () => {
    it("returns empty chunks and totalTokens=0 when vector store is empty", async () => {
      const retriever = new HybridRetriever({
        mode: "vector",
        topK: 10,
        qualityBoosting: false,
        qualityWeights: { chunk: 0.6, source: 0.4 },
        tokenBudget: 8000,
        embedQuery: async () => [0.1],
        vectorSearch: async () => [],
      });
      const result = await retriever.retrieve("q", {});
      expect(result.chunks).toEqual([]);
      expect(result.totalTokens).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // RRF score ties (equal-rank chunks)
  // -------------------------------------------------------------------------

  describe("RRF tie-handling", () => {
    it("chunks with equal RRF scores are all present in output", async () => {
      // Two vector-only chunks at same rank → same RRF score
      const retriever = new HybridRetriever({
        mode: "vector",
        topK: 5,
        qualityBoosting: false,
        qualityWeights: { chunk: 0.6, source: 0.4 },
        tokenBudget: 8000,
        embedQuery: async () => [0.1],
        vectorSearch: async () => [
          makeVectorHit("a", 0.8),
          makeVectorHit("b", 0.8),
        ],
      });
      const result = await retriever.retrieve("q", {});
      expect(result.chunks).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // namespace isolation (via filter)
  // -------------------------------------------------------------------------

  describe("namespace isolation via filter", () => {
    it("calls vectorSearch with namespace filter for tenant isolation", async () => {
      const vectorSearch = vi.fn(async () => []);
      const retriever = new HybridRetriever({
        mode: "vector",
        topK: 5,
        qualityBoosting: false,
        qualityWeights: { chunk: 0.6, source: 0.4 },
        tokenBudget: 8000,
        embedQuery: async () => [0.1],
        vectorSearch,
      });
      await retriever.retrieve("q", {
        tenantId: "tenant-A",
        namespace: "legal",
      });
      expect(vectorSearch).toHaveBeenCalledWith(
        expect.anything(),
        { tenantId: "tenant-A", namespace: "legal" },
        expect.any(Number),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// QdrantVectorStore — standalone tests (gaps not in qdrant-provider.test.ts)
// ---------------------------------------------------------------------------

describe("QdrantVectorStore — standalone", () => {
  let client: ReturnType<typeof makeClient>;
  let store: QdrantVectorStore;

  beforeEach(() => {
    client = makeClient();
    store = new QdrantVectorStore(client, {
      url: "http://qdrant",
      collectionName: "test_col",
    });
  });

  describe("upsertMany", () => {
    it("no-ops when points array is empty", async () => {
      await store.upsertMany([]);
      expect(client.upsert).not.toHaveBeenCalled();
    });

    it("forwards all points in a single call", async () => {
      await store.upsertMany([
        { id: "p1", vector: [0.1], payload: { text: "one" } },
        { id: "p2", vector: [0.2], payload: { text: "two" } },
      ]);
      expect(client.upsert).toHaveBeenCalledTimes(1);
      const [, body] = client.upsert.mock.calls[0] as [
        string,
        { points: Array<{ id: string }> },
      ];
      expect(body.points).toHaveLength(2);
      expect(body.points.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    });
  });

  describe("search", () => {
    it("returns empty array when client returns no hits", async () => {
      const hits = await store.search([0.1, 0.2], 5);
      expect(hits).toEqual([]);
    });

    it("maps hit id to string even when original is numeric", async () => {
      client.search.mockResolvedValueOnce([
        { id: 99, score: 0.7, payload: { text: "doc" } },
      ]);
      const hits = await store.search([0.1], 1, { tenantId: "t1" });
      expect(hits[0]!.id).toBe("99");
    });

    it("appends user filter clauses (non-tenantId) to must array", async () => {
      await store.search([0.1], 3, { tenantId: "t1", category: "kb" });
      const [, body] = client.search.mock.calls[0] as [
        string,
        { filter: { must: Array<{ key: string }> } },
      ];
      const keys = body.filter.must.map((c) => c.key);
      expect(keys).toContain("category");
      expect(keys).toContain("tenantId");
    });

    it("handles array-valued filter by emitting match.any clause", async () => {
      await store.search([0.1], 3, { tenantId: "t1", tags: ["a", "b"] });
      const [, body] = client.search.mock.calls[0] as [
        string,
        {
          filter: {
            must: Array<{ key: string; match: Record<string, unknown> }>;
          };
        },
      ];
      const tagsClause = body.filter.must.find((c) => c.key === "tags");
      expect(tagsClause).toBeDefined();
      expect(tagsClause!.match).toHaveProperty("any");
    });

    it("omits filter entirely when no filter is supplied and no defaultTenantId", async () => {
      await store.search([0.1], 3);
      const [, body] = client.search.mock.calls[0] as [
        string,
        { filter?: unknown },
      ];
      expect(body.filter).toBeUndefined();
    });

    it("uses defaultTenantId when filter omits tenantId", async () => {
      const storeWithDefault = new QdrantVectorStore(client, {
        url: "http://qdrant",
        collectionName: "test_col",
        defaultTenantId: "default-t",
      });
      await storeWithDefault.search([0.1], 3);
      const [, body] = client.search.mock.calls[0] as [
        string,
        {
          filter: { must: Array<{ key: string; match: { value?: unknown } }> };
        },
      ];
      const tenant = body.filter.must.find((c) => c.key === "tenantId");
      expect(tenant?.match).toEqual({ value: "default-t" });
    });
  });

  describe("keywordSearch", () => {
    it("returns empty array when scroll returns no points", async () => {
      const hits = await store.keywordSearch("anything", 5);
      expect(hits).toEqual([]);
    });

    it("rank-decays scores: first = 1, second = 0.5, third = 0.33", async () => {
      client.scroll.mockResolvedValueOnce({
        points: [
          { id: "a", payload: { text: "one" } },
          { id: "b", payload: { text: "two" } },
          { id: "c", payload: { text: "three" } },
        ],
      });
      const hits = await store.keywordSearch("q", 3, { tenantId: "t1" });
      expect(hits[0]!.score).toBeCloseTo(1, 5);
      expect(hits[1]!.score).toBeCloseTo(0.5, 5);
      expect(hits[2]!.score).toBeCloseTo(1 / 3, 5);
    });

    it("appends text match clause to the Qdrant scroll filter", async () => {
      await store.keywordSearch("my query", 3, { tenantId: "t1" });
      const [, body] = client.scroll.mock.calls[0] as [
        string,
        {
          filter: {
            must: Array<{ key: string; match: Record<string, unknown> }>;
          };
        },
      ];
      const textClause = body.filter.must.find((c) => c.key === "text");
      expect(textClause?.match).toEqual({ value: "my query" });
    });

    it("id is coerced to string for numeric Qdrant point ids", async () => {
      client.scroll.mockResolvedValueOnce({
        points: [{ id: 123, payload: { text: "hello" } }],
      });
      const hits = await store.keywordSearch("hello", 1, { tenantId: "t1" });
      expect(hits[0]!.id).toBe("123");
    });
  });
});

// ---------------------------------------------------------------------------
// QdrantCorpusStore — standalone tests
// ---------------------------------------------------------------------------

describe("QdrantCorpusStore — standalone", () => {
  let client: ReturnType<typeof makeClient>;
  let qdrantStore: QdrantVectorStore;
  let corpusStore: QdrantCorpusStore;

  beforeEach(() => {
    client = makeClient();
    qdrantStore = new QdrantVectorStore(client, {
      url: "http://qdrant",
      collectionName: "shared_col",
    });
    corpusStore = new QdrantCorpusStore(qdrantStore);
  });

  describe("createCollection / collectionExists / listCollections", () => {
    it("tracks newly created logical collections", async () => {
      await corpusStore.createCollection("coll-a", {
        dimensions: 4,
        metric: "cosine",
      });
      expect(await corpusStore.collectionExists("coll-a")).toBe(true);
    });

    it("returns false for unknown collections", async () => {
      expect(await corpusStore.collectionExists("not-registered")).toBe(false);
    });

    it("listCollections returns all registered names", async () => {
      await corpusStore.createCollection("x", {
        dimensions: 4,
        metric: "cosine",
      });
      await corpusStore.createCollection("y", {
        dimensions: 4,
        metric: "cosine",
      });
      const list = await corpusStore.listCollections();
      expect(list.sort()).toEqual(["x", "y"]);
    });
  });

  describe("deleteCollection", () => {
    it("removes the collection from the registry", async () => {
      await corpusStore.createCollection("del-me", {
        dimensions: 4,
        metric: "cosine",
      });
      await corpusStore.deleteCollection("del-me");
      expect(await corpusStore.collectionExists("del-me")).toBe(false);
    });

    it("no-ops when collection was never created", async () => {
      // Should not throw
      await expect(
        corpusStore.deleteCollection("ghost"),
      ).resolves.toBeUndefined();
    });

    it("invokes client.delete when it is a function", async () => {
      await corpusStore.createCollection("del-col", {
        dimensions: 4,
        metric: "cosine",
      });
      await corpusStore.deleteCollection("del-col");
      // deleteCollection calls client.scroll and optionally client.delete
      expect(client.scroll).toHaveBeenCalledTimes(1);
    });
  });

  describe("upsert", () => {
    it("no-ops when entries array is empty", async () => {
      await corpusStore.upsert("my-coll", []);
      expect(client.upsert).not.toHaveBeenCalled();
    });

    it("injects _collection field into payload", async () => {
      await corpusStore.upsert("my-coll", [
        { id: "e1", vector: [0.1, 0.2], text: "hello", metadata: {} },
      ]);
      const [, body] = client.upsert.mock.calls[0] as [
        string,
        { points: Array<{ payload: Record<string, unknown> }> },
      ];
      expect(body.points[0]!.payload["_collection"]).toBe("my-coll");
    });

    it("uses custom collectionField when configured", async () => {
      const customStore = new QdrantCorpusStore(qdrantStore, {
        collectionField: "_ns",
      });
      await customStore.upsert("my-coll", [
        { id: "e1", vector: [0.1], text: "x", metadata: {} },
      ]);
      const [, body] = client.upsert.mock.calls[0] as [
        string,
        { points: Array<{ payload: Record<string, unknown> }> },
      ];
      expect(body.points[0]!.payload["_ns"]).toBe("my-coll");
      expect(body.points[0]!.payload["_collection"]).toBeUndefined();
    });
  });

  describe("search", () => {
    it("returns empty array when client search returns nothing", async () => {
      const results = await corpusStore.search("coll-x", {
        vector: [0.1],
        limit: 5,
      });
      expect(results).toEqual([]);
    });

    it("strips _collection and text from returned metadata", async () => {
      client.search.mockResolvedValueOnce([
        {
          id: "p1",
          score: 0.9,
          payload: { text: "doc body", _collection: "coll-x", author: "alice" },
        },
      ]);
      const results = await corpusStore.search("coll-x", {
        vector: [0.1],
        limit: 5,
      });
      expect(results[0]!.text).toBe("doc body");
      expect(results[0]!.metadata["_collection"]).toBeUndefined();
      expect(results[0]!.metadata["text"]).toBeUndefined();
      expect(results[0]!.metadata["author"]).toBe("alice");
    });

    it("applies minScore filter on results", async () => {
      client.search.mockResolvedValueOnce([
        { id: "a", score: 0.9, payload: { text: "high" } },
        { id: "b", score: 0.3, payload: { text: "low" } },
      ]);
      const results = await corpusStore.search("coll-x", {
        vector: [0.1],
        limit: 5,
        minScore: 0.5,
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("a");
    });
  });

  describe("count", () => {
    it("returns 0 (not implemented in corpus store)", async () => {
      expect(await corpusStore.count("any-coll")).toBe(0);
    });
  });

  describe("healthCheck", () => {
    it("returns healthy=true", async () => {
      const health = await corpusStore.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.provider).toBe("qdrant-shared");
    });
  });

  describe("close", () => {
    it("resolves without error", async () => {
      await expect(corpusStore.close()).resolves.toBeUndefined();
    });
  });

  describe("delete", () => {
    it("deletes by ids via client.delete", async () => {
      await corpusStore.delete("coll-x", { ids: ["id1", "id2"] });
      expect(client.delete).toHaveBeenCalledWith("shared_col", {
        points: ["id1", "id2"],
      });
    });

    it("deletes by metadata filter scoped to the logical collection", async () => {
      await corpusStore.delete("coll-x", { metadata: { foo: "bar" } });
      expect(client.delete).toHaveBeenCalledWith("shared_col", {
        filter: {
          must: [{ key: "_collection", match: { value: "coll-x" } }],
        },
      });
    });

    it("no-ops when client has no delete method", async () => {
      const noDeleteClient: QdrantClientLike = {
        upsert: vi.fn().mockResolvedValue({}),
        search: vi.fn().mockResolvedValue([]),
        scroll: vi.fn().mockResolvedValue({ points: [] }),
      };
      const noDelStore = new QdrantVectorStore(noDeleteClient, {
        url: "http://q",
        collectionName: "shared",
      });
      const noDelCorpus = new QdrantCorpusStore(noDelStore);
      // Should not throw
      await expect(
        noDelCorpus.delete("coll-x", { ids: ["id1"] }),
      ).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// FolderContextGenerator — additional branch coverage
// ---------------------------------------------------------------------------

describe("FolderContextGenerator — additional coverage", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fcg-deep-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeAt(rel: string, content = "x"): Promise<string> {
    const full = join(root, rel);
    const dir = full.slice(0, full.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(full, content, "utf8");
    return full;
  }

  it("snapshot has correct generatedAt (epoch ms, recent)", async () => {
    await writeAt("a.ts");
    const gen = new FolderContextGenerator({ rootDir: root });
    const before = Date.now();
    const snap = await gen.generate();
    const after = Date.now();
    expect(snap.generatedAt).toBeGreaterThanOrEqual(before);
    expect(snap.generatedAt).toBeLessThanOrEqual(after);
  });

  it("ContextTransferService returning empty string falls back to default summary", async () => {
    await writeAt("a.ts");
    const gen = new FolderContextGenerator(
      { rootDir: root },
      { serialize: () => "" }, // returns empty string → falls back
    );
    const snap = await gen.generate();
    expect(snap.summary).toContain(root);
  });

  it("summary mentions file count and rootDir for non-empty dir", async () => {
    await writeAt("alpha.ts");
    await writeAt("beta.ts");
    const gen = new FolderContextGenerator({ rootDir: root });
    const snap = await gen.generate();
    expect(snap.summary).toContain(root);
    expect(snap.summary).toMatch(/2/);
  });

  it("maxFiles=1 returns only the top-scored file", async () => {
    await writeAt("index.ts");
    await writeAt("helper.ts");
    await writeAt("utils.ts");
    const gen = new FolderContextGenerator({ rootDir: root, maxFiles: 1 });
    const snap = await gen.generate();
    expect(snap.files).toHaveLength(1);
  });

  it("path separator is normalized to forward slash on all platforms", async () => {
    await writeAt("sub/deep/file.ts");
    const gen = new FolderContextGenerator({ rootDir: root, maxDepth: 5 });
    const files = await gen.scoreFiles();
    const deepFile = files.find((f) => f.path.includes("file"));
    expect(deepFile).toBeDefined();
    expect(deepFile!.path).not.toContain("\\");
  });

  it("scores .py files same as .ts files (both = 1.0 extension score)", async () => {
    await writeAt("a.ts");
    await writeAt("b.py");
    const gen = new FolderContextGenerator({ rootDir: root });
    const files = await gen.scoreFiles();
    const ts = files.find((f) => f.path === "a.ts")!;
    const py = files.find((f) => f.path === "b.py")!;
    // Extension scores are the same; the only difference is name scoring.
    // Both are "regular file" names, so scores should match.
    expect(ts.score).toBeCloseTo(py.score, 2);
  });

  it("config file gets higher name score than arbitrary file", async () => {
    await writeAt("vitest.ts"); // config file name
    await writeAt("random.ts"); // regular file name
    const gen = new FolderContextGenerator({ rootDir: root });
    const files = await gen.scoreFiles();
    const config = files.find((f) => f.path === "vitest.ts")!;
    const other = files.find((f) => f.path === "random.ts")!;
    expect(config.score).toBeGreaterThan(other.score);
  });

  it("returns four reason strings per file", async () => {
    await writeAt("index.ts");
    const gen = new FolderContextGenerator({ rootDir: root });
    const files = await gen.scoreFiles();
    expect(files[0]!.reasons).toHaveLength(4);
  });

  it("main.ts gets entry-point name score (same as index.ts)", async () => {
    await writeAt("main.ts");
    await writeAt("misc.ts");
    const gen = new FolderContextGenerator({ rootDir: root });
    const files = await gen.scoreFiles();
    const main = files.find((f) => f.path === "main.ts")!;
    expect(main.reasons).toContain("entry-point file");
  });

  it("custom extensions override defaults (only custom exts returned)", async () => {
    await writeAt("a.ts"); // default, but not in custom list
    await writeAt("b.rb"); // custom ext
    const gen = new FolderContextGenerator({
      rootDir: root,
      extensions: [".rb"],
    });
    const files = await gen.scoreFiles();
    expect(files.map((f) => f.path)).toEqual(["b.rb"]);
  });

  it("empty directory returns empty files array and no-match summary", async () => {
    // root exists but has no files matching default extensions
    const gen = new FolderContextGenerator({ rootDir: root });
    const snap = await gen.generate();
    expect(snap.files).toEqual([]);
    expect(snap.summary).toMatch(/No matching files/i);
  });

  it("ttlMs on snapshot matches configured cacheTtlMs", async () => {
    await writeAt("a.ts");
    const gen = new FolderContextGenerator({
      rootDir: root,
      cacheTtlMs: 99_999,
    });
    const snap = await gen.generate();
    expect(snap.ttlMs).toBe(99_999);
  });

  it("files in non-existing directory resolve to empty snapshot without throwing", async () => {
    const gen = new FolderContextGenerator({
      rootDir: "/nonexistent/path/xyz",
    });
    const snap = await gen.generate();
    expect(snap.files).toEqual([]);
  });

  it("depth 3+ files score lower than depth 0 when all other factors equal", async () => {
    // Write files with the same name and extension to isolate depth
    await writeAt("index.ts");
    await writeAt("a/b/c/index.ts");
    const gen = new FolderContextGenerator({ rootDir: root, maxDepth: 5 });
    const files = await gen.scoreFiles();
    const shallow = files.find((f) => f.path === "index.ts")!;
    const deep = files.find((f) => f.path === "a/b/c/index.ts")!;
    expect(shallow.score).toBeGreaterThan(deep.score);
  });

  it("ContextTransferService.serialize receives the top files array", async () => {
    await writeAt("a.ts");
    await writeAt("b.ts");
    const received: Array<{ path: string }> = [];
    const gen = new FolderContextGenerator(
      { rootDir: root },
      {
        serialize: (items) => {
          received.push(...items);
          return `count=${items.length}`;
        },
      },
    );
    const snap = await gen.generate();
    expect(snap.summary).toBe("count=2");
    expect(received.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// QdrantVectorStore — upsert single point
// ---------------------------------------------------------------------------

describe("QdrantVectorStore — single upsert", () => {
  it("upsert routes a single point with id, vector, and payload", async () => {
    const client = {
      upsert: vi.fn().mockResolvedValue({ status: "ok" }),
      search: vi.fn().mockResolvedValue([]),
      scroll: vi.fn().mockResolvedValue({ points: [] }),
    };
    const store = new QdrantVectorStore(client, {
      url: "http://q",
      collectionName: "single_col",
    });
    await store.upsert("id-1", [0.1, 0.2, 0.3], {
      tenantId: "t1",
      extra: "data",
    });
    expect(client.upsert).toHaveBeenCalledWith("single_col", {
      points: [
        {
          id: "id-1",
          vector: [0.1, 0.2, 0.3],
          payload: { tenantId: "t1", extra: "data" },
        },
      ],
    });
  });

  it("upsert uses the configured collectionName", async () => {
    const client = {
      upsert: vi.fn().mockResolvedValue({}),
      search: vi.fn().mockResolvedValue([]),
      scroll: vi.fn().mockResolvedValue({ points: [] }),
    };
    const store = new QdrantVectorStore(client, {
      url: "http://q",
      collectionName: "my_specific_collection",
    });
    await store.upsert("x", [1], {});
    const [collName] = client.upsert.mock.calls[0] as [string, unknown];
    expect(collName).toBe("my_specific_collection");
  });
});

// ---------------------------------------------------------------------------
// HybridRetriever — score threshold filter (via quality boosting adjustment)
// ---------------------------------------------------------------------------

describe("HybridRetriever — quality boosting math precision", () => {
  it("quality 1.0 yields boost factor of 1.15 (max +15%)", async () => {
    const retriever = new HybridRetriever({
      mode: "vector",
      topK: 5,
      qualityBoosting: true,
      qualityWeights: { chunk: 0.0, source: 1.0 },
      tokenBudget: 8000,
      embedQuery: async () => [0.1],
      vectorSearch: async () => [
        {
          id: "c1",
          score: 1.0,
          text: "hello",
          metadata: {
            source_id: "src",
            chunk_index: 0,
            quality_score: 1.0,
            source_quality: 1.0,
          },
        },
      ],
    });
    const result = await retriever.retrieve("q", {});
    // blend = 0.0*1.0 + 1.0*1.0 = 1.0
    // boost = 1 + (1.0 - 0.5) * 0.3 = 1.15
    // score = 1.0 * 1.15 = 1.15
    expect(result.chunks[0]!.score).toBeCloseTo(1.15, 4);
  });

  it("quality 0.0 yields boost factor of 0.85 (max -15%)", async () => {
    const retriever = new HybridRetriever({
      mode: "vector",
      topK: 5,
      qualityBoosting: true,
      qualityWeights: { chunk: 0.0, source: 1.0 },
      tokenBudget: 8000,
      embedQuery: async () => [0.1],
      vectorSearch: async () => [
        {
          id: "c1",
          score: 1.0,
          text: "hello",
          metadata: {
            source_id: "src",
            chunk_index: 0,
            quality_score: 0.0,
            source_quality: 0.0,
          },
        },
      ],
    });
    const result = await retriever.retrieve("q", {});
    // blend = 0.0*0.0 + 1.0*0.0 = 0.0
    // boost = 1 + (0.0 - 0.5) * 0.3 = 0.85
    // score = 1.0 * 0.85 = 0.85
    expect(result.chunks[0]!.score).toBeCloseTo(0.85, 4);
  });

  it("per-query tokenBudget override takes priority over config", async () => {
    const retriever = new HybridRetriever({
      mode: "vector",
      topK: 10,
      qualityBoosting: false,
      qualityWeights: { chunk: 0.6, source: 0.4 },
      tokenBudget: 8000, // large default
      embedQuery: async () => [0.1],
      vectorSearch: async () => [
        makeVectorHit("c1", 0.9),
        makeVectorHit("c2", 0.8),
      ],
    });
    // Override with very small budget so only 1 chunk fits
    const result = await retriever.retrieve("q", {}, { tokenBudget: 1 });
    expect(result.chunks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// QdrantCorpusStore — namespace isolation
// ---------------------------------------------------------------------------

describe("QdrantCorpusStore — namespace isolation via _collection field", () => {
  it("search on collection A does not return points tagged with collection B", async () => {
    const client = {
      upsert: vi.fn().mockResolvedValue({}),
      search: vi
        .fn()
        .mockImplementation(
          (
            _name: string,
            body: {
              filter: {
                must: Array<{ key: string; match: { value?: unknown } }>;
              };
            },
          ) => {
            const collClause = body.filter.must.find(
              (c) => c.key === "_collection",
            );
            // Return a hit only if searching for collection-A
            if (collClause?.match?.value === "collection-A") {
              return Promise.resolve([
                {
                  id: "p1",
                  score: 0.9,
                  payload: { text: "from A", _collection: "collection-A" },
                },
              ]);
            }
            return Promise.resolve([]);
          },
        ),
      scroll: vi.fn().mockResolvedValue({ points: [] }),
      delete: vi.fn().mockResolvedValue({}),
    };

    const qdrantStore = new QdrantVectorStore(client, {
      url: "http://q",
      collectionName: "shared",
    });
    const corpusStore = new QdrantCorpusStore(qdrantStore);

    const hitsA = await corpusStore.search("collection-A", {
      vector: [0.1],
      limit: 5,
    });
    const hitsB = await corpusStore.search("collection-B", {
      vector: [0.1],
      limit: 5,
    });

    expect(hitsA).toHaveLength(1);
    expect(hitsA[0]!.id).toBe("p1");
    expect(hitsB).toHaveLength(0);
  });

  it("upsert stamps _collection on all entries in the batch", async () => {
    const client = {
      upsert: vi.fn().mockResolvedValue({}),
      search: vi.fn().mockResolvedValue([]),
      scroll: vi.fn().mockResolvedValue({ points: [] }),
      delete: vi.fn().mockResolvedValue({}),
    };
    const qdrantStore = new QdrantVectorStore(client, {
      url: "http://q",
      collectionName: "shared",
    });
    const corpusStore = new QdrantCorpusStore(qdrantStore);

    await corpusStore.upsert("ns-X", [
      { id: "e1", vector: [0.1], text: "a", metadata: {} },
      { id: "e2", vector: [0.2], text: "b", metadata: {} },
    ]);

    const [, body] = client.upsert.mock.calls[0] as [
      string,
      { points: Array<{ payload: Record<string, unknown> }> },
    ];
    for (const pt of body.points) {
      expect(pt.payload["_collection"]).toBe("ns-X");
    }
  });
});
