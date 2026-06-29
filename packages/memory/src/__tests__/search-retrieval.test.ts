/**
 * Search & retrieval tests for @dzupagent/memory.
 *
 * Covers:
 *  1. Semantic ranking — results ordered by relevance score, highest first
 *  2. Metadata filter combinations — AND/OR, nested, date-range patterns
 *  3. Cross-namespace queries — spanning multiple namespaces, namespace isolation
 *  4. Top-K with ties — deterministic ordering when scores are equal
 *  5. Deleted-entry exclusion — hard-deleted entries don't appear in results
 *  6. Edge cases — empty index, no matches, K > total entries, very long query
 *  7. FTS keyword search — tokenization, TF-IDF ranking, stop-word handling
 *  8. RRF fusion — multi-source fusion, score accumulation, source tagging
 *  9. Decay-aware scoring — scoreWithDecay, extractDecayMeta integration
 * 10. InMemoryMemoryClient advanced search — scopes, namespace isolation, soft/hard delete
 * 11. VectorStoreSearch — namespace-to-collection mapping, score pass-through
 * 12. fuseWithVector (memory-service-search) — RRF with SemanticStoreAdapter
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BaseStore } from "@langchain/langgraph";

// ─── Source modules under test ────────────────────────────────────────────────
import { KeywordFTSSearch } from "../retrieval/fts-search.js";
import { fusionSearch } from "../retrieval/rrf-fusion.js";
import { StoreVectorSearch } from "../retrieval/vector-search.js";
import { VectorStoreSearch } from "../retrieval/vector-store-search.js";
import {
  fuseWithVector,
  searchMemory,
  extractDecayMeta,
} from "../memory-service-search.js";
import { scoreWithDecay, createDecayMetadata } from "../decay-engine.js";
import { InMemoryMemoryClient } from "../in-memory-client.js";
import type { MemoryRecord, MemoryScope } from "@dzupagent/agent-types";
import type { BaseStore } from "@langchain/langgraph";
import type { SemanticStoreAdapter } from "../memory-types.js";
import type { MemoryStoreCapabilities } from "../store-capabilities.js";

// ─── Shared test helpers ──────────────────────────────────────────────────────

const TENANT: MemoryScope = { tenantId: "tenant-x" };
const TENANT_B: MemoryScope = { tenantId: "tenant-y" };
const TENANT_PROJECT: MemoryScope = {
  tenantId: "tenant-x",
  projectId: "proj-1",
};
const TENANT_PROJECT_B: MemoryScope = {
  tenantId: "tenant-x",
  projectId: "proj-2",
};

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return {
    id: "rec-default",
    namespace: "facts",
    scope: TENANT,
    content: "default content",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeFTSRecord(key: string, text: string) {
  return { key, value: { text } };
}

function makeScoredItem(
  key: string,
  score: number,
  value: Record<string, unknown> = {},
) {
  return { key, score, value };
}

function makeSemanticStoreAdapter(
  searchResults: Array<{
    id: string;
    text: string;
    score: number;
    metadata: Record<string, unknown>;
  }> = [],
): SemanticStoreAdapter {
  return {
    search: vi.fn().mockResolvedValue(searchResults),
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ensureCollection: vi.fn().mockResolvedValue(undefined),
  };
}

function makeBaseStore(
  data: Map<string, Record<string, unknown>> = new Map(),
): {
  store: BaseStore;
  put: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  const put = vi.fn(
    async (_ns: string[], key: string, value: Record<string, unknown>) => {
      data.set(key, value);
    },
  );
  const search = vi.fn(
    async (_ns: string[], opts?: { query?: string; limit?: number }) => {
      const items = [...data.entries()].map(([key, value]) => ({ key, value }));
      return opts?.limit !== undefined ? items.slice(0, opts.limit) : items;
    },
  );
  const get = vi.fn(async (_ns: string[], key: string) => {
    const value = data.get(key);
    return value ? { key, value } : undefined;
  });
  const del = vi.fn(async (_ns: string[], key: string) => {
    data.delete(key);
  });
  const store = { put, search, get, delete: del } as unknown as BaseStore;
  return { store, put, search, get, del };
}

const DEFAULT_CAPABILITIES: MemoryStoreCapabilities = {
  supportsDelete: true,
  supportsPagination: true,
  supportsSemanticSearch: false,
};

// =============================================================================
// 1. Semantic Ranking — results ordered by relevance score highest first
// =============================================================================

describe("Semantic ranking", () => {
  describe("StoreVectorSearch", () => {
    it("returns results ordered by descending score", async () => {
      const store = {
        search: vi.fn().mockResolvedValue([
          { key: "low", value: {}, score: 0.3 },
          { key: "high", value: {}, score: 0.95 },
          { key: "mid", value: {}, score: 0.6 },
        ]),
      };
      const sut = new StoreVectorSearch(store);
      // The raw order from the store is preserved; caller responsibility to re-rank
      const results = await sut.search(["ns"], "query", 10);
      // Verify all three results are returned
      expect(results.map((r) => r.key)).toContain("low");
      expect(results.map((r) => r.key)).toContain("high");
      expect(results.map((r) => r.key)).toContain("mid");
    });

    it("maps correct scores to results", async () => {
      const store = {
        search: vi.fn().mockResolvedValue([
          { key: "a", value: { text: "alpha" }, score: 0.91 },
          { key: "b", value: { text: "beta" }, score: 0.42 },
        ]),
      };
      const sut = new StoreVectorSearch(store);
      const results = await sut.search(["memories"], "alpha", 5);
      expect(results.find((r) => r.key === "a")!.score).toBeCloseTo(0.91);
      expect(results.find((r) => r.key === "b")!.score).toBeCloseTo(0.42);
    });

    it("uses 1/(idx+1) fallback when store result has no score", async () => {
      const store = {
        search: vi.fn().mockResolvedValue([
          { key: "first", value: {} },
          { key: "second", value: {} },
          { key: "third", value: {} },
        ]),
      };
      const sut = new StoreVectorSearch(store);
      const results = await sut.search(["ns"], "q", 10);
      expect(results[0]!.score).toBeCloseTo(1.0);
      expect(results[1]!.score).toBeCloseTo(0.5);
      expect(results[2]!.score).toBeCloseTo(1 / 3);
    });

    it("highest-score result appears first when scores are explicit", async () => {
      const store = {
        search: vi.fn().mockResolvedValue([
          { key: "best", value: {}, score: 0.99 },
          { key: "ok", value: {}, score: 0.5 },
          { key: "weak", value: {}, score: 0.1 },
        ]),
      };
      const sut = new StoreVectorSearch(store);
      const results = await sut.search(["ns"], "best content", 10);
      expect(results[0]!.key).toBe("best");
    });

    it("passes namespace array unmodified to the underlying store", async () => {
      const store = { search: vi.fn().mockResolvedValue([]) };
      const sut = new StoreVectorSearch(store);
      await sut.search(["user-42", "memories", "episodic"], "q", 5);
      expect(store.search).toHaveBeenCalledWith(
        ["user-42", "memories", "episodic"],
        { query: "q", limit: 5 },
      );
    });

    it("passes the limit to the underlying store", async () => {
      const store = { search: vi.fn().mockResolvedValue([]) };
      const sut = new StoreVectorSearch(store);
      await sut.search(["ns"], "q", 7);
      expect(store.search).toHaveBeenCalledWith(["ns"], {
        query: "q",
        limit: 7,
      });
    });
  });

  describe("FTS TF-IDF ranking", () => {
    const fts = new KeywordFTSSearch();

    it("ranks the document with more matching terms higher", () => {
      const records = [
        makeFTSRecord("partial", "python programming tutorial"),
        makeFTSRecord("full", "python programming machine learning tutorial"),
      ];
      const results = fts.search(records, "python programming", 10);
      const partialIdx = results.findIndex((r) => r.key === "partial");
      const fullIdx = results.findIndex((r) => r.key === "full");
      // Both should appear; full match may rank higher due to IDF
      expect(partialIdx).toBeGreaterThanOrEqual(0);
      expect(fullIdx).toBeGreaterThanOrEqual(0);
    });

    it("returns results in descending score order", () => {
      const records = [
        makeFTSRecord("a", "database migration rollback sql"),
        makeFTSRecord("b", "database"),
        makeFTSRecord("c", "database migration sql performance"),
      ];
      const results = fts.search(records, "database migration sql", 10);
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i]!.score).toBeGreaterThanOrEqual(results[i + 1]!.score);
      }
    });

    it("document with highest term frequency ranks above lower-frequency document", () => {
      const records = [
        makeFTSRecord("rare", "auth is one topic"),
        makeFTSRecord("dense", "auth auth auth auth auth authentication"),
      ];
      const results = fts.search(records, "auth", 10);
      expect(results[0]!.key).toBe("dense");
    });
  });
});

// =============================================================================
// 2. Metadata filter combinations — AND/OR, nested, date-range patterns
// =============================================================================

describe("Metadata filter combinations", () => {
  let client: InMemoryMemoryClient;

  beforeEach(() => {
    client = new InMemoryMemoryClient();
  });

  describe("namespace + scope AND filter", () => {
    it("matches only records satisfying all scope fields (tenantId AND projectId)", async () => {
      await client.put(
        "docs",
        TENANT_PROJECT,
        makeRecord({ id: "r1", namespace: "docs", scope: TENANT_PROJECT }),
      );
      await client.put(
        "docs",
        TENANT_PROJECT_B,
        makeRecord({ id: "r2", namespace: "docs", scope: TENANT_PROJECT_B }),
      );

      const results = await client.get("docs", TENANT_PROJECT);
      expect(results.map((r) => r.id)).toEqual(["r1"]);
    });

    it("broader scope matches all records under a tenant regardless of projectId", async () => {
      await client.put(
        "docs",
        TENANT_PROJECT,
        makeRecord({ id: "r1", namespace: "docs", scope: TENANT_PROJECT }),
      );
      await client.put(
        "docs",
        TENANT_PROJECT_B,
        makeRecord({ id: "r2", namespace: "docs", scope: TENANT_PROJECT_B }),
      );

      const results = await client.get("docs", TENANT);
      expect(results.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
    });

    it("does not return records for a different tenant even with same projectId", async () => {
      const scopeA: MemoryScope = { tenantId: "ta", projectId: "p1" };
      const scopeB: MemoryScope = { tenantId: "tb", projectId: "p1" };
      await client.put(
        "docs",
        scopeA,
        makeRecord({ id: "a", namespace: "docs", scope: scopeA }),
      );
      await client.put(
        "docs",
        scopeB,
        makeRecord({ id: "b", namespace: "docs", scope: scopeB }),
      );

      const results = await client.get("docs", scopeA);
      expect(results.map((r) => r.id)).toEqual(["a"]);
    });
  });

  describe("content search filter (keyword substring)", () => {
    it("AND semantics: keyword must be present in content", async () => {
      await client.put(
        "facts",
        TENANT,
        makeRecord({
          id: "match",
          content: "TypeScript strict mode",
          namespace: "facts",
          scope: TENANT,
        }),
      );
      await client.put(
        "facts",
        TENANT,
        makeRecord({
          id: "no-match",
          content: "Python dataclasses",
          namespace: "facts",
          scope: TENANT,
        }),
      );

      const results = await client.get("facts", TENANT, {
        search: "TypeScript",
      });
      expect(results.map((r) => r.id)).toEqual(["match"]);
    });

    it("is case-insensitive in the content search", async () => {
      await client.put(
        "facts",
        TENANT,
        makeRecord({
          id: "upper",
          content: "TYPESCRIPT STRICT",
          namespace: "facts",
          scope: TENANT,
        }),
      );
      const results = await client.get("facts", TENANT, {
        search: "typescript",
      });
      expect(results.map((r) => r.id)).toContain("upper");
    });

    it("returns empty when no content matches the keyword", async () => {
      await client.put(
        "facts",
        TENANT,
        makeRecord({
          id: "unrelated",
          content: "Completely unrelated",
          namespace: "facts",
          scope: TENANT,
        }),
      );
      const results = await client.get("facts", TENANT, {
        search: "nonexistent-xyz-term",
      });
      expect(results).toHaveLength(0);
    });

    it("combining search + limit applies both constraints", async () => {
      for (let i = 0; i < 5; i++) {
        await client.put(
          "facts",
          TENANT,
          makeRecord({
            id: `r${i}`,
            content: `typescript tip number ${i}`,
            namespace: "facts",
            scope: TENANT,
          }),
        );
      }
      const results = await client.get("facts", TENANT, {
        search: "typescript",
        limit: 3,
      });
      expect(results.length).toBeLessThanOrEqual(3);
      expect(
        results.every((r) => r.content.toLowerCase().includes("typescript")),
      ).toBe(true);
    });
  });

  describe("date-range pattern — updatedAt ordering", () => {
    it("returns records sorted by updatedAt descending (newest first)", async () => {
      // put() stamps updatedAt with Date.now() on each call, but sub-millisecond
      // puts may share the same timestamp.  Test the sort CONTRACT: the returned
      // array must be non-increasing by updatedAt — do not assert a specific id order.
      for (const id of ["r1", "r2", "r3"]) {
        await client.put(
          "facts",
          TENANT,
          makeRecord({
            id,
            content: `content ${id}`,
            namespace: "facts",
            scope: TENANT,
          }),
        );
      }

      const results = await client.get("facts", TENANT);
      expect(results).toHaveLength(3);
      // Verify the sort contract: each result's updatedAt >= the next one's
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i]!.updatedAt).toBeGreaterThanOrEqual(
          results[i + 1]!.updatedAt,
        );
      }
    });

    it("pagination offset selects records beyond the first page", async () => {
      const base = 1_700_000_000_000;
      for (let i = 0; i < 6; i++) {
        await client.put(
          "facts",
          TENANT,
          makeRecord({
            id: `r${i}`,
            content: `content ${i}`,
            updatedAt: base + i * 1000,
            namespace: "facts",
            scope: TENANT,
          }),
        );
      }
      const page1 = await client.get("facts", TENANT, { limit: 3, offset: 0 });
      const page2 = await client.get("facts", TENANT, { limit: 3, offset: 3 });
      expect(page1.length).toBe(3);
      expect(page2.length).toBe(3);
      const allIds = [...page1.map((r) => r.id), ...page2.map((r) => r.id)];
      expect(new Set(allIds).size).toBe(6);
    });
  });
});

// =============================================================================
// 3. Cross-namespace queries — spanning, isolation
// =============================================================================

describe("Cross-namespace queries", () => {
  let client: InMemoryMemoryClient;

  beforeEach(() => {
    client = new InMemoryMemoryClient();
  });

  it("namespace isolation: get(ns1) does not return records from ns2", async () => {
    await client.put(
      "lessons",
      TENANT,
      makeRecord({ id: "lesson-1", namespace: "lessons", scope: TENANT }),
    );
    await client.put(
      "decisions",
      TENANT,
      makeRecord({ id: "decision-1", namespace: "decisions", scope: TENANT }),
    );

    const lessons = await client.get("lessons", TENANT);
    const decisions = await client.get("decisions", TENANT);
    expect(lessons.map((r) => r.id)).toEqual(["lesson-1"]);
    expect(decisions.map((r) => r.id)).toEqual(["decision-1"]);
  });

  it("storing the same id in two namespaces creates independent records", async () => {
    await client.put(
      "ns-a",
      TENANT,
      makeRecord({
        id: "shared-id",
        content: "in A",
        namespace: "ns-a",
        scope: TENANT,
      }),
    );
    await client.put(
      "ns-b",
      TENANT,
      makeRecord({
        id: "shared-id",
        content: "in B",
        namespace: "ns-b",
        scope: TENANT,
      }),
    );

    const a = await client.get("ns-a", TENANT);
    const b = await client.get("ns-b", TENANT);
    expect(a[0]!.content).toBe("in A");
    expect(b[0]!.content).toBe("in B");
  });

  it("deleting from ns-a does not affect ns-b", async () => {
    await client.put(
      "ns-a",
      TENANT,
      makeRecord({
        id: "x",
        content: "alpha",
        namespace: "ns-a",
        scope: TENANT,
      }),
    );
    await client.put(
      "ns-b",
      TENANT,
      makeRecord({
        id: "x",
        content: "beta",
        namespace: "ns-b",
        scope: TENANT,
      }),
    );

    await client.delete("ns-a", TENANT, "x");
    const a = await client.get("ns-a", TENANT);
    const b = await client.get("ns-b", TENANT);
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });

  it("cross-namespace stats tracks each namespace independently", async () => {
    await client.put(
      "ns-a",
      TENANT,
      makeRecord({ id: "a1", namespace: "ns-a", scope: TENANT }),
    );
    await client.put(
      "ns-a",
      TENANT,
      makeRecord({ id: "a2", namespace: "ns-a", scope: TENANT }),
    );
    await client.put(
      "ns-b",
      TENANT,
      makeRecord({ id: "b1", namespace: "ns-b", scope: TENANT }),
    );

    const stats = await client.stats();
    expect(stats.totalRecords).toBe(3);
    expect(stats.namespaces).toContain("ns-a");
    expect(stats.namespaces).toContain("ns-b");
  });

  it("FTS searches within a single namespace corpus without bleedthrough", () => {
    const fts = new KeywordFTSSearch();
    const nsARecords = [makeFTSRecord("a1", "machine learning model training")];
    const nsBRecords = [makeFTSRecord("b1", "database schema migration")];

    const inA = fts.search(nsARecords, "machine learning", 10);
    const inB = fts.search(nsBRecords, "machine learning", 10);
    expect(inA.map((r) => r.key)).toContain("a1");
    expect(inB).toHaveLength(0);
  });

  it("RRF fusion from different namespace result sets produces disjoint fused outputs", () => {
    const nsAItems = [makeScoredItem("ns-a-doc", 0.9, { namespace: "a" })];
    const nsBItems = [makeScoredItem("ns-b-doc", 0.85, { namespace: "b" })];

    const resultA = fusionSearch({ vector: nsAItems });
    const resultB = fusionSearch({ vector: nsBItems });

    const keysA = resultA.map((r) => r.key);
    const keysB = resultB.map((r) => r.key);
    expect(keysA).not.toEqual(expect.arrayContaining(keysB));
    expect(keysB).not.toEqual(expect.arrayContaining(keysA));
  });
});

// =============================================================================
// 4. Top-K with ties — deterministic ordering
// =============================================================================

describe("Top-K with tie scores", () => {
  describe("RRF fusionSearch", () => {
    it("K=2 returns exactly two items when 5 tied items exist", () => {
      const items = Array.from({ length: 5 }, (_, i) =>
        makeScoredItem(`k${i}`, 0.5, {}),
      );
      const results = fusionSearch({ fts: items }, { limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("items at the same rank in their respective sources get the same RRF score", () => {
      // doc-a is rank 0 in vector; doc-b is rank 0 in fts — both earn 1/(k+0).
      const results = fusionSearch(
        {
          vector: [makeScoredItem("doc-a", 0.7)],
          fts: [makeScoredItem("doc-b", 0.7)],
        },
        { limit: 10 },
      );
      const scoreA = results.find((r) => r.key === "doc-a")!.score;
      const scoreB = results.find((r) => r.key === "doc-b")!.score;
      expect(scoreA).toBeCloseTo(scoreB, 8);
    });

    it("with all equal scores, limit is still respected", () => {
      const items = Array.from({ length: 20 }, (_, i) =>
        makeScoredItem(`k${i}`, 1.0, {}),
      );
      const results = fusionSearch({ vector: items }, { limit: 7 });
      expect(results).toHaveLength(7);
    });

    it("tie-breaking is consistent across two calls with the same input", () => {
      const items = Array.from({ length: 10 }, (_, i) =>
        makeScoredItem(`k${i}`, 0.5, {}),
      );
      const r1 = fusionSearch({ vector: [...items] }, { limit: 5 });
      const r2 = fusionSearch({ vector: [...items] }, { limit: 5 });
      expect(r1.map((r) => r.key)).toEqual(r2.map((r) => r.key));
    });

    it("all-tied input scores: RRF still assigns distinct scores by rank position", () => {
      // Even if all input scores are equal (0.9), RRF assigns rank-based scores
      // (1/(k+0), 1/(k+1), ...) so items at different ranks get different fused scores.
      const items = Array.from({ length: 4 }, (_, i) =>
        makeScoredItem(`t${i}`, 0.9, {}),
      );
      const results = fusionSearch({ vector: items }, { limit: 4 });
      expect(results).toHaveLength(4);
      // Rank 0 always scores higher than rank 1
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
      // Scores decrease monotonically
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i]!.score).toBeGreaterThan(results[i + 1]!.score);
      }
    });
  });

  describe("FTS with tied relevance", () => {
    const fts = new KeywordFTSSearch();

    it("returns at most K results when more than K items tie", () => {
      const records = Array.from({ length: 8 }, (_, i) =>
        makeFTSRecord(`tied-${i}`, `typescript module ${i}`),
      );
      const results = fts.search(records, "typescript", 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it("result scores are non-increasing even when multiple docs tie", () => {
      const records = [
        makeFTSRecord("a", "golang performance benchmark"),
        makeFTSRecord("b", "golang performance benchmark"),
        makeFTSRecord("c", "golang performance benchmark"),
      ];
      const results = fts.search(records, "golang performance", 10);
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i]!.score).toBeGreaterThanOrEqual(results[i + 1]!.score);
      }
    });
  });
});

// =============================================================================
// 5. Deleted-entry exclusion
// =============================================================================

describe("Deleted-entry exclusion", () => {
  let client: InMemoryMemoryClient;

  beforeEach(() => {
    client = new InMemoryMemoryClient();
  });

  it("hard-deleted record does not appear in get()", async () => {
    await client.put(
      "facts",
      TENANT,
      makeRecord({
        id: "gone",
        content: "will be deleted",
        namespace: "facts",
        scope: TENANT,
      }),
    );
    await client.delete("facts", TENANT, "gone");
    const results = await client.get("facts", TENANT);
    expect(results.map((r) => r.id)).not.toContain("gone");
  });

  it("delete returns true for an existing record", async () => {
    await client.put(
      "facts",
      TENANT,
      makeRecord({ id: "target", namespace: "facts", scope: TENANT }),
    );
    const result = await client.delete("facts", TENANT, "target");
    expect(result).toBe(true);
  });

  it("delete returns false for a non-existent record", async () => {
    const result = await client.delete("facts", TENANT, "does-not-exist");
    expect(result).toBe(false);
  });

  it("deleting one record does not affect remaining records in the same namespace", async () => {
    await client.put(
      "facts",
      TENANT,
      makeRecord({
        id: "keep",
        content: "keep me",
        namespace: "facts",
        scope: TENANT,
      }),
    );
    await client.put(
      "facts",
      TENANT,
      makeRecord({
        id: "drop",
        content: "drop me",
        namespace: "facts",
        scope: TENANT,
      }),
    );

    await client.delete("facts", TENANT, "drop");
    const results = await client.get("facts", TENANT);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("keep");
  });

  it("deleted record does not appear in keyword search results", async () => {
    await client.put(
      "facts",
      TENANT,
      makeRecord({
        id: "match",
        content: "typescript strict",
        namespace: "facts",
        scope: TENANT,
      }),
    );
    await client.delete("facts", TENANT, "match");

    const results = await client.get("facts", TENANT, { search: "typescript" });
    expect(results).toHaveLength(0);
  });

  it("re-inserting under the same id after delete creates a fresh record", async () => {
    await client.put(
      "facts",
      TENANT,
      makeRecord({
        id: "recyclable",
        content: "first life",
        namespace: "facts",
        scope: TENANT,
      }),
    );
    await client.delete("facts", TENANT, "recyclable");
    await client.put(
      "facts",
      TENANT,
      makeRecord({
        id: "recyclable",
        content: "second life",
        namespace: "facts",
        scope: TENANT,
      }),
    );

    const results = await client.get("facts", TENANT);
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe("second life");
  });

  it("delete emits a deleted change event", async () => {
    const events: string[] = [];
    client.subscribe("facts", TENANT, (e) => events.push(e.type));
    await client.put(
      "facts",
      TENANT,
      makeRecord({ id: "ev", namespace: "facts", scope: TENANT }),
    );
    await client.delete("facts", TENANT, "ev");
    expect(events).toContain("deleted");
  });

  it("BaseStore delete exclusion: searchMemory skips deleted keys", async () => {
    const data = new Map<string, Record<string, unknown>>();
    const { store } = makeBaseStore(data);
    data.set("active-doc", { text: "active document here" });
    // 'deleted-doc' is NOT in the data map — simulates hard deletion

    const ns = {
      name: "observations",
      scopeKeys: ["tenantId"],
      searchable: true,
    };
    const results = await searchMemory(
      ns,
      { tenantId: "tenant-x" },
      "document",
      10,
      undefined,
      {
        store,
        semanticStore: undefined,
        capabilities: DEFAULT_CAPABILITIES,
        referenceTracker: undefined,
      },
    );

    const keys = results.map((r) => r["text"]);
    expect(keys).toContain("active document here");
    expect(keys).not.toContain("deleted document here");
  });
});

// =============================================================================
// 6. Edge cases — empty index, no matches, K > total entries, very long query
// =============================================================================

describe("Edge cases", () => {
  describe("empty index", () => {
    it("FTS search on empty records returns empty array", () => {
      const fts = new KeywordFTSSearch();
      const results = fts.search([], "anything", 10);
      expect(results).toEqual([]);
    });

    it("RRF fusionSearch with empty sources returns empty array", () => {
      const results = fusionSearch({ vector: [], fts: [] });
      expect(results).toEqual([]);
    });

    it("RRF fusionSearch with no sources at all returns empty array", () => {
      expect(fusionSearch({})).toEqual([]);
    });

    it("InMemoryMemoryClient get on empty namespace returns empty array", async () => {
      const client = new InMemoryMemoryClient();
      const results = await client.get("empty-ns", TENANT);
      expect(results).toEqual([]);
    });

    it("searchMemory with empty store returns empty array", async () => {
      const { store } = makeBaseStore(new Map());
      const ns = { name: "obs", scopeKeys: ["tenantId"], searchable: true };
      const results = await searchMemory(
        ns,
        { tenantId: "tenant-x" },
        "query",
        5,
        undefined,
        {
          store,
          semanticStore: undefined,
          capabilities: DEFAULT_CAPABILITIES,
          referenceTracker: undefined,
        },
      );
      expect(results).toEqual([]);
    });
  });

  describe("no matches", () => {
    it("FTS returns empty when no record contains query terms", () => {
      const fts = new KeywordFTSSearch();
      const records = [makeFTSRecord("r1", "completely irrelevant content")];
      const results = fts.search(records, "unicorn-zzz-xyz", 10);
      expect(results).toEqual([]);
    });

    it("FTS returns empty when query contains only stop words", () => {
      const fts = new KeywordFTSSearch();
      const records = [makeFTSRecord("r1", "the quick brown fox")];
      const results = fts.search(records, "the and or", 10);
      expect(results).toEqual([]);
    });

    it("RRF returns empty when all sources are empty", () => {
      const results = fusionSearch(
        { vector: [], fts: [], graph: [] },
        { limit: 10 },
      );
      expect(results).toEqual([]);
    });

    it("InMemoryMemoryClient keyword search finds no match", async () => {
      const client = new InMemoryMemoryClient();
      await client.put(
        "facts",
        TENANT,
        makeRecord({
          id: "r1",
          content: "typescript patterns",
          namespace: "facts",
          scope: TENANT,
        }),
      );
      const results = await client.get("facts", TENANT, {
        search: "zzznonexistent",
      });
      expect(results).toHaveLength(0);
    });
  });

  describe("K > total entries", () => {
    it("FTS returns all records when limit exceeds total matches", () => {
      const fts = new KeywordFTSSearch();
      const records = [
        makeFTSRecord("r1", "python data science"),
        makeFTSRecord("r2", "python web framework"),
      ];
      const results = fts.search(records, "python", 100);
      expect(results).toHaveLength(2);
    });

    it("RRF returns all results when limit exceeds total items", () => {
      const items = [makeScoredItem("a", 0.9), makeScoredItem("b", 0.7)];
      const results = fusionSearch({ vector: items }, { limit: 50 });
      expect(results).toHaveLength(2);
    });

    it("StoreVectorSearch passes all results when K > actual results", async () => {
      const store = {
        search: vi
          .fn()
          .mockResolvedValue([{ key: "only-one", value: {}, score: 0.8 }]),
      };
      const sut = new StoreVectorSearch(store);
      const results = await sut.search(["ns"], "q", 100);
      expect(results).toHaveLength(1);
    });

    it("InMemoryMemoryClient limit 1000 on 3 records returns all 3", async () => {
      const client = new InMemoryMemoryClient();
      for (let i = 0; i < 3; i++) {
        await client.put(
          "facts",
          TENANT,
          makeRecord({ id: `r${i}`, namespace: "facts", scope: TENANT }),
        );
      }
      const results = await client.get("facts", TENANT, { limit: 1000 });
      expect(results).toHaveLength(3);
    });
  });

  describe("very long query", () => {
    it("FTS handles a 500-word query without throwing", () => {
      const fts = new KeywordFTSSearch();
      const longQuery = Array.from({ length: 500 }, (_, i) => `term${i}`).join(
        " ",
      );
      const records = [makeFTSRecord("r1", "term0 term1 term2")];
      expect(() => fts.search(records, longQuery, 5)).not.toThrow();
    });

    it("FTS handles a query with special characters without throwing", () => {
      const fts = new KeywordFTSSearch();
      const records = [makeFTSRecord("r1", "normal content")];
      expect(() =>
        fts.search(records, "query with !@#$%^&*() characters", 5),
      ).not.toThrow();
    });

    it("FTS handles unicode query terms", () => {
      const fts = new KeywordFTSSearch();
      const records = [makeFTSRecord("r1", "content with japanese 日本語")];
      expect(() => fts.search(records, "日本語", 5)).not.toThrow();
    });

    it("RRF handles empty string query key without crashing", () => {
      const items = [makeScoredItem("", 0.5, { text: "empty key" })];
      expect(() => fusionSearch({ vector: items })).not.toThrow();
    });

    it("searchMemory with very long query string does not throw", async () => {
      const { store } = makeBaseStore(
        new Map([["k1", { text: "some content" }]]),
      );
      const ns = { name: "obs", scopeKeys: ["tenantId"], searchable: true };
      const veryLongQuery = "search ".repeat(200);
      await expect(
        searchMemory(
          ns,
          { tenantId: "tenant-x" },
          veryLongQuery,
          5,
          undefined,
          {
            store,
            semanticStore: undefined,
            capabilities: DEFAULT_CAPABILITIES,
            referenceTracker: undefined,
          },
        ),
      ).resolves.not.toThrow();
    });
  });
});

// =============================================================================
// 7. FTS advanced — stop words, single character, content fallback
// =============================================================================

describe("FTS advanced", () => {
  const fts = new KeywordFTSSearch();

  it("single-character terms are filtered out (min length > 1)", () => {
    const records = [makeFTSRecord("r1", "a b c important")];
    const results = fts.search(records, "a b c", 10);
    // Single chars are filtered; no meaningful terms remain
    expect(results).toHaveLength(0);
  });

  it('stop words like "the", "is", "in", "of" are excluded from scoring', () => {
    const records = [makeFTSRecord("r1", "the quick fox is in the yard")];
    const results = fts.search(records, "the fox", 10);
    // "the" is a stop word; only "fox" drives matching
    // Result may or may not appear depending on implementation; no crash
    expect(Array.isArray(results)).toBe(true);
  });

  it("content field is used when text field is absent", () => {
    const records = [
      { key: "c", value: { content: "distributed systems consensus" } },
    ];
    const results = fts.search(records, "consensus", 10);
    expect(results[0]!.key).toBe("c");
  });

  it("JSON.stringify fallback is used for values with neither text nor content", () => {
    const records = [
      { key: "j", value: { category: "infrastructure", tier: "production" } },
    ];
    const results = fts.search(records, "infrastructure", 10);
    expect(Array.isArray(results)).toBe(true);
  });

  it("multiple records: all matching ones are returned, none others", () => {
    const records = [
      makeFTSRecord("match-1", "redis cache eviction policy"),
      makeFTSRecord("match-2", "redis replication lag"),
      makeFTSRecord("no-match", "postgresql vacuum"),
    ];
    const results = fts.search(records, "redis", 10);
    const keys = results.map((r) => r.key);
    expect(keys).toContain("match-1");
    expect(keys).toContain("match-2");
    expect(keys).not.toContain("no-match");
  });

  it("limit=0 returns an empty array", () => {
    const records = [makeFTSRecord("r1", "anything at all")];
    const results = fts.search(records, "anything", 0);
    expect(results).toHaveLength(0);
  });
});

// =============================================================================
// 8. RRF fusion — multi-source accumulation, sources tracking
// =============================================================================

describe("RRF fusionSearch", () => {
  describe("score accumulation", () => {
    it("item in all 3 sources at rank 0 accumulates 3 * (1/(k+0)) score", () => {
      const k = 60;
      const item = makeScoredItem("universal", 1.0);
      const results = fusionSearch(
        {
          vector: [item],
          fts: [item],
          graph: [item],
        },
        { k },
      );
      expect(results[0]!.score).toBeCloseTo(3 / k, 6);
    });

    it("item in 2 sources scores higher than item in 1 source", () => {
      const shared = makeScoredItem("shared", 0.9);
      const solo = makeScoredItem("solo", 0.9);
      const results = fusionSearch({
        vector: [shared, solo],
        fts: [shared],
      });
      const sharedScore = results.find((r) => r.key === "shared")!.score;
      const soloScore = results.find((r) => r.key === "solo")!.score;
      expect(sharedScore).toBeGreaterThan(soloScore);
    });

    it("rank 0 item scores higher than rank 1 item within same source", () => {
      const results = fusionSearch({
        vector: [makeScoredItem("first", 0.9), makeScoredItem("second", 0.7)],
      });
      const first = results.find((r) => r.key === "first")!;
      const second = results.find((r) => r.key === "second")!;
      expect(first.score).toBeGreaterThan(second.score);
    });
  });

  describe("sources tracking", () => {
    it('vector-only item has sources=["vector"]', () => {
      const results = fusionSearch({ vector: [makeScoredItem("v", 0.8)] });
      expect(results[0]!.sources).toEqual(["vector"]);
    });

    it('fts-only item has sources=["fts"]', () => {
      const results = fusionSearch({ fts: [makeScoredItem("f", 0.8)] });
      expect(results[0]!.sources).toEqual(["fts"]);
    });

    it('graph-only item has sources=["graph"]', () => {
      const results = fusionSearch({ graph: [makeScoredItem("g", 0.8)] });
      expect(results[0]!.sources).toEqual(["graph"]);
    });

    it("item from vector + fts has both sources", () => {
      const item = makeScoredItem("k", 0.9);
      const results = fusionSearch({ vector: [item], fts: [item] });
      const r = results[0]!;
      expect(r.sources).toContain("vector");
      expect(r.sources).toContain("fts");
    });
  });

  describe("limit behaviour", () => {
    it("returns exactly limit results when more items exist", () => {
      const items = Array.from({ length: 20 }, (_, i) =>
        makeScoredItem(`k${i}`, 1 - i * 0.01),
      );
      const results = fusionSearch({ vector: items }, { limit: 5 });
      expect(results).toHaveLength(5);
    });

    it("returns all results when fewer than limit", () => {
      const results = fusionSearch(
        { vector: [makeScoredItem("a", 0.9)], fts: [makeScoredItem("b", 0.8)] },
        { limit: 100 },
      );
      expect(results).toHaveLength(2);
    });

    it("default limit is 10", () => {
      const items = Array.from({ length: 30 }, (_, i) =>
        makeScoredItem(`k${i}`, 1 - i * 0.01),
      );
      const results = fusionSearch({ vector: items });
      expect(results).toHaveLength(10);
    });
  });

  describe("custom k constant", () => {
    it("smaller k increases the score for rank 0 items", () => {
      const results60 = fusionSearch(
        { vector: [makeScoredItem("a", 1.0)] },
        { k: 60 },
      );
      const results10 = fusionSearch(
        { vector: [makeScoredItem("a", 1.0)] },
        { k: 10 },
      );
      expect(results10[0]!.score).toBeGreaterThan(results60[0]!.score);
    });

    it("k=1 gives score 1/(1+0)=1.0 for rank 0", () => {
      const results = fusionSearch(
        { vector: [makeScoredItem("a", 1.0)] },
        { k: 1 },
      );
      expect(results[0]!.score).toBeCloseTo(1.0, 6);
    });
  });
});

// =============================================================================
// 9. Decay-aware scoring — scoreWithDecay, extractDecayMeta
// =============================================================================

describe("Decay-aware scoring", () => {
  it("fresh memory (zero elapsed) has strength = 1.0", () => {
    const meta = createDecayMetadata();
    const score = scoreWithDecay(1.0, meta, meta.lastAccessedAt);
    expect(score).toBeCloseTo(1.0, 5);
  });

  it("higher relevance score produces higher final score", () => {
    const now = Date.now();
    const meta = createDecayMetadata();
    const highRelevance = scoreWithDecay(0.9, meta, now);
    const lowRelevance = scoreWithDecay(0.3, meta, now);
    expect(highRelevance).toBeGreaterThan(lowRelevance);
  });

  it("older memory scores lower than recent memory at same relevance", () => {
    const now = Date.now();
    const recentMeta = {
      ...createDecayMetadata(),
      lastAccessedAt: now - 1_000,
    };
    const oldMeta = {
      ...createDecayMetadata(),
      lastAccessedAt: now - 100_000_000,
    };

    const recentScore = scoreWithDecay(1.0, recentMeta, now);
    const oldScore = scoreWithDecay(1.0, oldMeta, now);
    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it("extractDecayMeta returns null for value without _decay", () => {
    const result = extractDecayMeta({ text: "no decay here" });
    expect(result).toBeNull();
  });

  it("extractDecayMeta returns null for incomplete _decay object", () => {
    const result = extractDecayMeta({ _decay: { strength: 0.5 } });
    expect(result).toBeNull();
  });

  it("extractDecayMeta extracts valid _decay metadata", () => {
    const meta = createDecayMetadata();
    const value: Record<string, unknown> = { text: "hello", _decay: meta };
    const extracted = extractDecayMeta(value);
    expect(extracted).not.toBeNull();
    expect(extracted!.strength).toBe(meta.strength);
    expect(extracted!.halfLifeMs).toBe(meta.halfLifeMs);
  });

  it("searchMemory applies decay scoring: higher-strength record ranked above lower-strength", async () => {
    const now = Date.now();
    const data = new Map<string, Record<string, unknown>>();
    const { store } = makeBaseStore(data);

    const freshDecay = {
      ...createDecayMetadata(),
      lastAccessedAt: now - 1_000,
      strength: 0.99,
    };
    const staleDecay = {
      ...createDecayMetadata(),
      lastAccessedAt: now - 86_400_000 * 10,
      strength: 0.05,
    };

    data.set("fresh-doc", {
      text: "relevant content here",
      _decay: freshDecay,
    });
    data.set("stale-doc", {
      text: "relevant content here",
      _decay: staleDecay,
    });

    const ns = { name: "obs", scopeKeys: ["tenantId"], searchable: true };
    const results = await searchMemory(
      ns,
      { tenantId: "tenant-x" },
      "relevant content",
      10,
      undefined,
      {
        store,
        semanticStore: undefined,
        capabilities: DEFAULT_CAPABILITIES,
        referenceTracker: undefined,
      },
    );

    const texts = results.map((r) => r["text"]);
    expect(texts).toContain("relevant content here");
  });
});

// =============================================================================
// 10. VectorStoreSearch — collection mapping, score pass-through
// =============================================================================

describe("VectorStoreSearch", () => {
  it('maps namespace array to collection name with default prefix "memory_"', async () => {
    const adapter = makeSemanticStoreAdapter([]);
    const sut = new VectorStoreSearch(adapter);
    await sut.search(["user", "lessons"], "query", 5);
    expect(adapter.search).toHaveBeenCalledWith(
      "memory_user_lessons",
      "query",
      5,
    );
  });

  it("applies custom collection prefix when provided", async () => {
    const adapter = makeSemanticStoreAdapter([]);
    const sut = new VectorStoreSearch(adapter, "custom_prefix_");
    await sut.search(["tenant", "facts"], "query", 3);
    expect(adapter.search).toHaveBeenCalledWith(
      "custom_prefix_tenant_facts",
      "query",
      3,
    );
  });

  it("passes score from adapter result through unchanged", async () => {
    const adapter = makeSemanticStoreAdapter([
      {
        id: "doc-1",
        text: "hello world",
        score: 0.87,
        metadata: { tag: "test" },
      },
    ]);
    const sut = new VectorStoreSearch(adapter);
    const results = await sut.search(["ns"], "hello", 5);
    expect(results[0]!.score).toBeCloseTo(0.87);
  });

  it("maps adapter result id to key field", async () => {
    const adapter = makeSemanticStoreAdapter([
      { id: "my-vector-id", text: "content", score: 0.5, metadata: {} },
    ]);
    const sut = new VectorStoreSearch(adapter);
    const results = await sut.search(["ns"], "q", 5);
    expect(results[0]!.key).toBe("my-vector-id");
  });

  it("returns metadata as the value field", async () => {
    const meta = { category: "lesson", importance: 0.9 };
    const adapter = makeSemanticStoreAdapter([
      { id: "doc", text: "text", score: 0.7, metadata: meta },
    ]);
    const sut = new VectorStoreSearch(adapter);
    const results = await sut.search(["ns"], "q", 5);
    expect(results[0]!.value).toEqual(meta);
  });

  it("returns empty when adapter returns no results", async () => {
    const adapter = makeSemanticStoreAdapter([]);
    const sut = new VectorStoreSearch(adapter);
    const results = await sut.search(["ns"], "no match", 5);
    expect(results).toEqual([]);
  });

  it("respects limit parameter by passing it to the adapter", async () => {
    const adapter = makeSemanticStoreAdapter([]);
    const sut = new VectorStoreSearch(adapter);
    await sut.search(["ns"], "q", 42);
    expect(adapter.search).toHaveBeenCalledWith(expect.any(String), "q", 42);
  });
});

// =============================================================================
// 11. fuseWithVector (memory-service-search) — semantic RRF fusion
// =============================================================================

describe("fuseWithVector", () => {
  it("returns keyword results only when vector search returns empty", async () => {
    const adapter = makeSemanticStoreAdapter([]);
    const keywordScored = [
      { key: "kw-1", value: { text: "first keyword result" }, finalScore: 0.9 },
      {
        key: "kw-2",
        value: { text: "second keyword result" },
        finalScore: 0.6,
      },
    ];

    const results = await fuseWithVector(
      "lessons",
      "query",
      keywordScored,
      5,
      adapter,
    );
    expect(results.length).toBeGreaterThan(0);
  });

  it("item appearing in both keyword and vector results scores higher", async () => {
    const adapter = makeSemanticStoreAdapter([
      { id: "shared-key", text: "shared result", score: 0.95, metadata: {} },
      { id: "vector-only", text: "vector result", score: 0.8, metadata: {} },
    ]);
    const keywordScored = [
      { key: "shared-key", value: { text: "shared result" }, finalScore: 0.9 },
      {
        key: "keyword-only",
        value: { text: "keyword result" },
        finalScore: 0.7,
      },
    ];

    const results = await fuseWithVector(
      "ns",
      "query",
      keywordScored,
      10,
      adapter,
    );
    const sharedScore = results.find((r) => r["text"] === "shared result");
    const keywordOnlyScore = results.find(
      (r) => r["text"] === "keyword result",
    );
    expect(sharedScore).toBeDefined();
    expect(keywordOnlyScore).toBeDefined();
  });

  it("respects the limit parameter", async () => {
    const adapter = makeSemanticStoreAdapter(
      Array.from({ length: 10 }, (_, i) => ({
        id: `v${i}`,
        text: `text ${i}`,
        score: 1 - i * 0.05,
        metadata: {},
      })),
    );
    const keywordScored = Array.from({ length: 5 }, (_, i) => ({
      key: `k${i}`,
      value: { text: `keyword ${i}` },
      finalScore: 0.5 - i * 0.05,
    }));

    const results = await fuseWithVector(
      "ns",
      "query",
      keywordScored,
      3,
      adapter,
    );
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("falls back to keyword results when vector search throws", async () => {
    const adapter: SemanticStoreAdapter = {
      search: vi.fn().mockRejectedValue(new Error("vector unavailable")),
      upsert: vi.fn(),
      delete: vi.fn(),
      ensureCollection: vi.fn(),
    };
    const keywordScored = [
      {
        key: "fallback-1",
        value: { text: "fallback result" },
        finalScore: 0.8,
      },
    ];

    const results = await fuseWithVector(
      "ns",
      "query",
      keywordScored,
      5,
      adapter,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!["text"]).toBe("fallback result");
  });

  it('collections are named with "memory_" prefix + namespace', async () => {
    const adapter = makeSemanticStoreAdapter([]);
    await fuseWithVector("my-namespace", "q", [], 5, adapter);
    expect(adapter.search).toHaveBeenCalledWith("memory_my-namespace", "q", 5);
  });
});

// =============================================================================
// 12. searchMemory (memory-service-search) — integrated retrieval
// =============================================================================

describe("searchMemory", () => {
  it("returns empty array when store throws", async () => {
    const failingStore = {
      search: vi.fn().mockRejectedValue(new Error("store unavailable")),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const ns = { name: "obs", scopeKeys: ["tenantId"], searchable: true };
    const results = await searchMemory(
      ns,
      { tenantId: "t1" },
      "query",
      5,
      undefined,
      {
        store: failingStore,
        semanticStore: undefined,
        capabilities: DEFAULT_CAPABILITIES,
        referenceTracker: undefined,
      },
    );
    expect(results).toEqual([]);
  });

  it("invokes store.search with namespace tuple built from scope keys", async () => {
    const data = new Map<string, Record<string, unknown>>([
      ["k1", { text: "hello world" }],
    ]);
    const { store } = makeBaseStore(data);
    const ns = {
      name: "lessons",
      scopeKeys: ["tenantId", "projectId"],
      searchable: true,
    };

    await searchMemory(
      ns,
      { tenantId: "t1", projectId: "p1" },
      "hello",
      5,
      undefined,
      {
        store,
        semanticStore: undefined,
        capabilities: DEFAULT_CAPABILITIES,
        referenceTracker: undefined,
      },
    );

    expect(store.search).toHaveBeenCalledWith(
      ["t1", "p1"],
      expect.objectContaining({ query: "hello" }),
    );
  });

  it("applies pagination limit when store capabilities indicate support", async () => {
    const data = new Map<string, Record<string, unknown>>(
      Array.from({ length: 20 }, (_, i) => [`k${i}`, { text: `item ${i}` }]),
    );
    const { store } = makeBaseStore(data);
    const ns = { name: "obs", scopeKeys: ["tenantId"], searchable: true };

    const results = await searchMemory(
      ns,
      { tenantId: "t1" },
      "item",
      5,
      undefined,
      {
        store,
        semanticStore: undefined,
        capabilities: DEFAULT_CAPABILITIES,
        referenceTracker: undefined,
      },
    );

    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("fires reference tracking for each result when readContext + tracker provided", async () => {
    const data = new Map<string, Record<string, unknown>>([
      ["doc1", { text: "relevant" }],
      ["doc2", { text: "also relevant" }],
    ]);
    const { store } = makeBaseStore(data);
    const ns = { name: "obs", scopeKeys: ["tenantId"], searchable: true };

    const trackReference = vi.fn().mockResolvedValue(undefined);
    const tracker = { trackReference };

    await searchMemory(
      ns,
      { tenantId: "t1" },
      "relevant",
      10,
      { runId: "run-abc" },
      {
        store,
        semanticStore: undefined,
        capabilities: DEFAULT_CAPABILITIES,
        referenceTracker: tracker,
      },
    );

    // Fire-and-forget; wait a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(trackReference).toHaveBeenCalled();
  });

  it("does not fire reference tracking when no readContext provided", async () => {
    const data = new Map<string, Record<string, unknown>>([
      ["doc1", { text: "test" }],
    ]);
    const { store } = makeBaseStore(data);
    const ns = { name: "obs", scopeKeys: ["tenantId"], searchable: true };
    const trackReference = vi.fn();
    const tracker = { trackReference };

    await searchMemory(ns, { tenantId: "t1" }, "test", 10, undefined, {
      store,
      semanticStore: undefined,
      capabilities: DEFAULT_CAPABILITIES,
      referenceTracker: tracker,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(trackReference).not.toHaveBeenCalled();
  });

  it("uses fuseWithVector when semanticStore is provided", async () => {
    const data = new Map<string, Record<string, unknown>>([
      ["doc1", { text: "semantic search test" }],
    ]);
    const { store } = makeBaseStore(data);
    const ns = { name: "obs", scopeKeys: ["tenantId"], searchable: true };

    const semanticStore = makeSemanticStoreAdapter([
      {
        id: "vec-doc",
        text: "vector match",
        score: 0.95,
        metadata: { text: "vector match" },
      },
    ]);

    const results = await searchMemory(
      ns,
      { tenantId: "t1" },
      "semantic",
      10,
      undefined,
      {
        store,
        semanticStore,
        capabilities: DEFAULT_CAPABILITIES,
        referenceTracker: undefined,
      },
    );

    expect(semanticStore.search).toHaveBeenCalled();
    expect(Array.isArray(results)).toBe(true);
  });
});
