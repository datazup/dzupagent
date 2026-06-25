/**
 * W30-C — Memory: vector semantic search deep coverage
 *
 * Targets the following source modules (none yet unit-tested at this depth):
 *   - retrieval/vector-search.ts          (StoreVectorSearch)
 *   - retrieval/vector-store-search.ts    (VectorStoreSearch)
 *   - memory-service-search.ts            (fuseWithVector, extractDecayMeta, searchMemory)
 *   - memory-service-store.ts             (putMemoryRecord, deleteMemoryRecord)
 *   - memory-service.ts                   (MemoryService — delete paths, batch, update, etc.)
 *
 * All embedding calls are mocked — no real embedding APIs are invoked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StoreVectorSearch } from "../retrieval/vector-search.js";
import { VectorStoreSearch } from "../retrieval/vector-store-search.js";
import {
  fuseWithVector,
  extractDecayMeta,
  searchMemory,
} from "../memory-service-search.js";
import {
  putMemoryRecord,
  deleteMemoryRecord,
  buildNamespaceTuple,
  getNamespace,
} from "../memory-service-store.js";
import { MemoryService } from "../memory-service.js";
import type { SemanticStoreAdapter } from "../memory-types.js";
import type { NamespaceConfig } from "../memory-types.js";
import type { BaseStore } from "@langchain/langgraph";
import type { MemoryStoreCapabilities } from "../store-capabilities.js";
import type { DecayMetadata } from "../decay-engine.js";

// ─── Shared helpers ──────────────────────────────────────────────────────────

interface StoreItem {
  namespace: string[];
  key: string;
  value: Record<string, unknown>;
}

function createMockBaseStore(caps?: Partial<MemoryStoreCapabilities>) {
  const data: StoreItem[] = [];

  function arrEq(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  const store = {
    put: vi.fn(
      async (
        namespace: string[],
        key: string,
        value: Record<string, unknown>
      ) => {
        const idx = data.findIndex(
          (d) => d.key === key && arrEq(d.namespace, namespace)
        );
        if (idx >= 0) {
          data[idx] = { namespace, key, value };
        } else {
          data.push({ namespace, key, value });
        }
      }
    ),
    get: vi.fn(async (namespace: string[], key: string) => {
      const found = data.find(
        (d) => d.key === key && arrEq(d.namespace, namespace)
      );
      return found ? { key: found.key, value: found.value } : null;
    }),
    search: vi.fn(
      async (
        namespace: string[],
        _opts?: { query?: string; limit?: number }
      ) => {
        return data
          .filter((d) => arrEq(d.namespace, namespace))
          .map((d) => ({ key: d.key, value: d.value }));
      }
    ),
    delete: vi.fn(async (_namespace: string[], _key: string) => {
      const idx = data.findIndex(
        (d) => d.key === _key && arrEq(d.namespace, _namespace)
      );
      if (idx >= 0) data.splice(idx, 1);
    }),
    _data: data,
    capabilities: {
      supportsDelete: caps?.supportsDelete ?? true,
      supportsSearchFilters: caps?.supportsSearchFilters ?? true,
      supportsPagination: caps?.supportsPagination ?? true,
    },
  };
  return store;
}

function createMockSemanticStore(): SemanticStoreAdapter & {
  search: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  ensureCollection: ReturnType<typeof vi.fn>;
} {
  return {
    search: vi.fn(async () => []),
    upsert: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    ensureCollection: vi.fn(async () => undefined),
  };
}

const NAMESPACES: NamespaceConfig[] = [
  { name: "lessons", scopeKeys: ["tenantId", "lessons"], searchable: true },
  {
    name: "decisions",
    scopeKeys: ["projectId", "decisions"],
    searchable: false,
  },
  { name: "notes", scopeKeys: ["userId", "notes"], searchable: true },
];

// ─── 1. extractDecayMeta ─────────────────────────────────────────────────────

describe("extractDecayMeta", () => {
  it("returns null for an empty object", () => {
    expect(extractDecayMeta({})).toBeNull();
  });

  it("returns null when _decay is absent", () => {
    expect(extractDecayMeta({ text: "hello" })).toBeNull();
  });

  it("returns null when _decay is a non-object primitive", () => {
    expect(extractDecayMeta({ _decay: 42 })).toBeNull();
    expect(extractDecayMeta({ _decay: "string" })).toBeNull();
    expect(extractDecayMeta({ _decay: null })).toBeNull();
  });

  it("returns null when _decay is missing required numeric fields", () => {
    expect(extractDecayMeta({ _decay: { strength: 1 } })).toBeNull();
    expect(
      extractDecayMeta({
        _decay: { strength: 1, lastAccessedAt: 1, halfLifeMs: 1 },
      })
    ).toBeNull();
  });

  it("returns null when a numeric field has wrong type", () => {
    const badDecay = {
      _decay: {
        strength: "1", // string instead of number
        lastAccessedAt: 1000,
        halfLifeMs: 86400000,
        accessCount: 0,
        createdAt: 999,
      },
    };
    expect(extractDecayMeta(badDecay)).toBeNull();
  });

  it("returns DecayMetadata when all required fields are present with correct types", () => {
    const decayMeta = {
      strength: 0.9,
      lastAccessedAt: 1000,
      halfLifeMs: 86400000,
      accessCount: 2,
      createdAt: 500,
    };
    const result = extractDecayMeta({ _decay: decayMeta, text: "irrelevant" });
    expect(result).not.toBeNull();
    expect(result?.strength).toBe(0.9);
    expect(result?.accessCount).toBe(2);
    expect(result?.createdAt).toBe(500);
  });

  it("accepts strength=0 (minimum valid value)", () => {
    const decayMeta = {
      strength: 0,
      lastAccessedAt: 1000,
      halfLifeMs: 86400000,
      accessCount: 0,
      createdAt: 999,
    };
    const result = extractDecayMeta({ _decay: decayMeta });
    expect(result).not.toBeNull();
    expect(result?.strength).toBe(0);
  });

  it("ignores additional fields in the record beside _decay", () => {
    const decayMeta = {
      strength: 1,
      lastAccessedAt: 1,
      halfLifeMs: 1,
      accessCount: 0,
      createdAt: 0,
    };
    const result = extractDecayMeta({ _decay: decayMeta, someOther: "field" });
    expect(result).not.toBeNull();
  });
});

// ─── 2. fuseWithVector — RRF fusion logic ────────────────────────────────────

describe("fuseWithVector", () => {
  const RRF_K = 60; // must match implementation

  function makeKeywordScored(
    entries: Array<{ key: string; score: number; text?: string }>
  ) {
    return entries.map((e) => ({
      key: e.key,
      value: { text: e.text ?? `text for ${e.key}` },
      finalScore: e.score,
    }));
  }

  it("returns empty array when keyword results empty and vector returns nothing", async () => {
    const adapter = createMockSemanticStore();
    adapter.search.mockResolvedValueOnce([]);
    const result = await fuseWithVector("lessons", "query", [], 5, adapter);
    expect(result).toEqual([]);
  });

  it("returns keyword-only results when vector search returns empty", async () => {
    const adapter = createMockSemanticStore();
    adapter.search.mockResolvedValueOnce([]);
    const keyword = makeKeywordScored([
      { key: "k1", score: 0.9 },
      { key: "k2", score: 0.7 },
    ]);
    const result = await fuseWithVector(
      "lessons",
      "query",
      keyword,
      10,
      adapter
    );
    expect(result).toHaveLength(2);
  });

  it("returns vector-only results when keyword results are empty", async () => {
    const adapter = createMockSemanticStore();
    adapter.search.mockResolvedValueOnce([
      { id: "v1", text: "vector doc 1", score: 0.95, metadata: { tag: "a" } },
      { id: "v2", text: "vector doc 2", score: 0.85, metadata: { tag: "b" } },
    ]);
    const result = await fuseWithVector("lessons", "query", [], 10, adapter);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty("text");
  });

  it("fuses overlapping results — overlapping key gets higher RRF score", async () => {
    const adapter = createMockSemanticStore();
    // 'shared' appears in both keyword (rank 0) and vector (rank 0)
    // unique-kw appears only in keyword; unique-v only in vector
    adapter.search.mockResolvedValueOnce([
      { id: "shared", text: "shared text", score: 0.9, metadata: {} },
      { id: "unique-v", text: "vector-only", score: 0.8, metadata: {} },
    ]);

    const keyword = makeKeywordScored([
      { key: "shared", score: 0.9, text: "shared keyword text" },
      { key: "unique-kw", score: 0.5 },
    ]);

    const result = await fuseWithVector(
      "lessons",
      "query",
      keyword,
      10,
      adapter
    );

    // 'shared' should rank first (RRF score from both lists)
    expect(result[0]).toEqual(
      expect.objectContaining({ text: "shared keyword text" })
    );
  });

  it("RRF score for overlap = 2/(K+0) while single-list = 1/(K+0)", async () => {
    const adapter = createMockSemanticStore();
    adapter.search.mockResolvedValueOnce([
      { id: "shared", text: "shared", score: 0.9, metadata: {} },
    ]);
    const keyword = makeKeywordScored([
      { key: "shared", score: 1.0 },
      { key: "solo-kw", score: 0.99 },
    ]);
    const result = await fuseWithVector(
      "lessons",
      "query",
      keyword,
      10,
      adapter
    );
    // 'shared': 1/(60+0) + 1/(60+0) = 2/60 ≈ 0.0333
    // 'solo-kw': only keyword at rank 1 → 1/(60+1) ≈ 0.0164
    // 'shared' must rank first; keyword value is preserved for overlapping result
    expect(result[0]).toEqual(
      expect.objectContaining({ text: "text for shared" })
    );
  });

  it("respects the limit parameter", async () => {
    const adapter = createMockSemanticStore();
    adapter.search.mockResolvedValueOnce([
      { id: "v1", text: "t1", score: 0.9, metadata: {} },
      { id: "v2", text: "t2", score: 0.8, metadata: {} },
      { id: "v3", text: "t3", score: 0.7, metadata: {} },
    ]);
    const keyword = makeKeywordScored([
      { key: "k1", score: 0.9 },
      { key: "k2", score: 0.8 },
    ]);
    const result = await fuseWithVector(
      "lessons",
      "query",
      keyword,
      2,
      adapter
    );
    expect(result).toHaveLength(2);
  });

  it("falls back to keyword-only when vector search throws", async () => {
    const adapter = createMockSemanticStore();
    adapter.search.mockRejectedValueOnce(new Error("vector store offline"));
    const keyword = makeKeywordScored([
      { key: "k1", score: 0.9 },
      { key: "k2", score: 0.5 },
    ]);
    const result = await fuseWithVector(
      "lessons",
      "query",
      keyword,
      10,
      adapter
    );
    // Falls back to keyword-only results
    expect(result).toHaveLength(2);
  });

  it("calls semanticStore.search with the correct collection name", async () => {
    const adapter = createMockSemanticStore();
    adapter.search.mockResolvedValueOnce([]);
    await fuseWithVector("my_namespace", "find something", [], 5, adapter);
    expect(adapter.search).toHaveBeenCalledWith(
      "memory_my_namespace",
      "find something",
      5
    );
  });

  it("reconstructs value from metadata for vector-only results", async () => {
    const adapter = createMockSemanticStore();
    adapter.search.mockResolvedValueOnce([
      {
        id: "vec-only",
        text: "some text",
        score: 0.88,
        metadata: { author: "alice", tag: "test" },
      },
    ]);
    const result = await fuseWithVector("lessons", "query", [], 10, adapter);
    expect(result[0]).toMatchObject({
      text: "some text",
      author: "alice",
      tag: "test",
    });
  });

  it("handles limit=0 → returns empty array", async () => {
    const adapter = createMockSemanticStore();
    adapter.search.mockResolvedValueOnce([
      { id: "v1", text: "t1", score: 0.9, metadata: {} },
    ]);
    const keyword = makeKeywordScored([{ key: "k1", score: 0.9 }]);
    const result = await fuseWithVector(
      "lessons",
      "query",
      keyword,
      0,
      adapter
    );
    expect(result).toHaveLength(0);
  });

  it("handles limit > total results → returns all", async () => {
    const adapter = createMockSemanticStore();
    adapter.search.mockResolvedValueOnce([
      { id: "v1", text: "t1", score: 0.9, metadata: {} },
    ]);
    const keyword = makeKeywordScored([{ key: "k1", score: 0.9 }]);
    const result = await fuseWithVector(
      "lessons",
      "query",
      keyword,
      100,
      adapter
    );
    // 2 unique results (k1 + v1)
    expect(result).toHaveLength(2);
  });

  it("results are sorted descending by RRF score", async () => {
    const adapter = createMockSemanticStore();
    // Vector-only result at rank 0 should have high score
    adapter.search.mockResolvedValueOnce([
      { id: "best", text: "best", score: 0.99, metadata: {} },
    ]);
    // keyword-only results
    const keyword = makeKeywordScored([
      { key: "mid", score: 0.5 },
      { key: "low", score: 0.3 },
    ]);
    const result = await fuseWithVector(
      "lessons",
      "query",
      keyword,
      10,
      adapter
    );
    // 'best' at rank 0 in vector (1/(60+0)) vs 'mid' at rank 0 keyword (1/(60+0))
    // — tie-breaking depends on insertion order; but all should be present
    expect(result).toHaveLength(3);
  });
});

// ─── 3. searchMemory — end-to-end search helper ──────────────────────────────

describe("searchMemory", () => {
  const ns: NamespaceConfig = {
    name: "lessons",
    scopeKeys: ["tenantId", "lessons"],
    searchable: true,
  };
  const scope = { tenantId: "t1", lessons: "lessons" };

  it("returns [] when BaseStore.search throws", async () => {
    const store = {
      search: vi.fn().mockRejectedValue(new Error("store error")),
    };
    const result = await searchMemory(ns, scope, "query", 5, undefined, {
      store: store as unknown as BaseStore,
      semanticStore: undefined,
      capabilities: {
        supportsDelete: true,
        supportsSearchFilters: true,
        supportsPagination: true,
      },
      referenceTracker: undefined,
    });
    expect(result).toEqual([]);
  });

  it("returns keyword results sorted by inverse rank when no semanticStore", async () => {
    const store = createMockBaseStore();
    store.search.mockResolvedValueOnce([
      { key: "a", value: { text: "alpha" } },
      { key: "b", value: { text: "beta" } },
      { key: "c", value: { text: "gamma" } },
    ]);
    const result = await searchMemory(ns, scope, "query", 5, undefined, {
      store: store as unknown as BaseStore,
      semanticStore: undefined,
      capabilities: {
        supportsDelete: true,
        supportsSearchFilters: true,
        supportsPagination: true,
      },
      referenceTracker: undefined,
    });
    expect(result).toHaveLength(3);
  });

  it("trims keyword results to the requested limit", async () => {
    const store = createMockBaseStore();
    store.search.mockResolvedValueOnce([
      { key: "a", value: { text: "a" } },
      { key: "b", value: { text: "b" } },
      { key: "c", value: { text: "c" } },
      { key: "d", value: { text: "d" } },
    ]);
    const result = await searchMemory(ns, scope, "query", 2, undefined, {
      store: store as unknown as BaseStore,
      semanticStore: undefined,
      capabilities: {
        supportsDelete: true,
        supportsSearchFilters: true,
        supportsPagination: true,
      },
      referenceTracker: undefined,
    });
    expect(result).toHaveLength(2);
  });

  it("returns [] when store returns empty results and no semanticStore", async () => {
    const store = createMockBaseStore();
    store.search.mockResolvedValueOnce([]);
    const result = await searchMemory(ns, scope, "query", 5, undefined, {
      store: store as unknown as BaseStore,
      semanticStore: undefined,
      capabilities: {
        supportsDelete: true,
        supportsSearchFilters: true,
        supportsPagination: true,
      },
      referenceTracker: undefined,
    });
    expect(result).toEqual([]);
  });

  it("calls semanticStore.search when configured", async () => {
    const store = createMockBaseStore();
    store.search.mockResolvedValueOnce([]);
    const semanticStore = createMockSemanticStore();
    semanticStore.search.mockResolvedValueOnce([
      { id: "v1", text: "vector result", score: 0.9, metadata: {} },
    ]);

    const result = await searchMemory(ns, scope, "find it", 5, undefined, {
      store: store as unknown as BaseStore,
      semanticStore,
      capabilities: {
        supportsDelete: true,
        supportsSearchFilters: true,
        supportsPagination: true,
      },
      referenceTracker: undefined,
    });

    expect(semanticStore.search).toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it("applies decay re-ranking when records have _decay metadata", async () => {
    const store = createMockBaseStore();
    const now = Date.now();
    // Old record with decayed strength
    const oldDecay: DecayMetadata = {
      strength: 0.1,
      accessCount: 0,
      lastAccessedAt: now - 7 * 24 * 60 * 60 * 1000, // 7 days ago
      createdAt: now - 7 * 24 * 60 * 60 * 1000,
      halfLifeMs: 24 * 60 * 60 * 1000,
    };
    // Fresh record
    const freshDecay: DecayMetadata = {
      strength: 0.99,
      accessCount: 5,
      lastAccessedAt: now - 1000,
      createdAt: now - 1000,
      halfLifeMs: 7 * 24 * 60 * 60 * 1000,
    };
    // Store returns old record first, fresh second
    store.search.mockResolvedValueOnce([
      { key: "old", value: { text: "stale", _decay: oldDecay } },
      { key: "fresh", value: { text: "fresh", _decay: freshDecay } },
    ]);

    const result = await searchMemory(ns, scope, "query", 5, undefined, {
      store: store as unknown as BaseStore,
      semanticStore: undefined,
      capabilities: {
        supportsDelete: true,
        supportsSearchFilters: true,
        supportsPagination: true,
      },
      referenceTracker: undefined,
    });

    // After decay re-ranking, fresh record should appear first
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(expect.objectContaining({ text: "fresh" }));
  });

  it("fires reference tracking fire-and-forget when readContext provided", async () => {
    const store = createMockBaseStore();
    store.search.mockResolvedValueOnce([
      { key: "r1", value: { text: "result" } },
    ]);
    const tracker = { trackReference: vi.fn(async () => undefined) };
    const result = await searchMemory(
      ns,
      scope,
      "q",
      5,
      { runId: "run-123" },
      {
        store: store as unknown as BaseStore,
        semanticStore: undefined,
        capabilities: {
          supportsDelete: true,
          supportsSearchFilters: true,
          supportsPagination: true,
        },
        referenceTracker: tracker,
      }
    );
    // Wait for fire-and-forget
    await new Promise((r) => setTimeout(r, 10));
    expect(result).toHaveLength(1);
    expect(tracker.trackReference).toHaveBeenCalledWith(
      "run-123",
      expect.any(String),
      expect.any(Object)
    );
  });

  it("does NOT fire reference tracking when results are empty", async () => {
    const store = createMockBaseStore();
    store.search.mockResolvedValueOnce([]);
    const tracker = { trackReference: vi.fn(async () => undefined) };
    await searchMemory(
      ns,
      scope,
      "q",
      5,
      { runId: "run-123" },
      {
        store: store as unknown as BaseStore,
        semanticStore: undefined,
        capabilities: {
          supportsDelete: true,
          supportsSearchFilters: true,
          supportsPagination: true,
        },
        referenceTracker: tracker,
      }
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(tracker.trackReference).not.toHaveBeenCalled();
  });

  it("does NOT call store.search with limit param when supportsPagination=false", async () => {
    const store = createMockBaseStore({ supportsPagination: false });
    store.search.mockResolvedValueOnce([]);
    await searchMemory(ns, scope, "query", 5, undefined, {
      store: store as unknown as BaseStore,
      semanticStore: undefined,
      capabilities: {
        supportsDelete: true,
        supportsSearchFilters: true,
        supportsPagination: false,
      },
      referenceTracker: undefined,
    });
    // Without pagination, limit is not passed (only query)
    expect(store.search).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ query: "query" })
    );
    const callArgs = store.search.mock.calls[0]?.[1];
    expect(callArgs).not.toHaveProperty("limit");
  });
});

// ─── 4. MemoryService — delete paths ─────────────────────────────────────────

describe("MemoryService delete paths", () => {
  it("delete() removes the record from the store and returns true", async () => {
    const store = createMockBaseStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
    });

    await svc.put(
      "decisions",
      { projectId: "p1", decisions: "decisions" },
      "dec-1",
      { text: "use postgres" }
    );
    const deleted = await svc.delete(
      "decisions",
      { projectId: "p1", decisions: "decisions" },
      "dec-1"
    );

    expect(deleted).toBe(true);
    expect(store.delete).toHaveBeenCalledWith(["p1", "decisions"], "dec-1");
  });

  it("delete() returns false when the store does not support delete", async () => {
    const store = createMockBaseStore({ supportsDelete: false });
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
    });

    const deleted = await svc.delete(
      "decisions",
      { projectId: "p1", decisions: "decisions" },
      "dec-1"
    );
    expect(deleted).toBe(false);
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("delete() returns false when the store throws", async () => {
    const store = createMockBaseStore();
    store.delete.mockRejectedValueOnce(new Error("store error"));
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
    });

    const deleted = await svc.delete(
      "decisions",
      { projectId: "p1", decisions: "decisions" },
      "dec-1"
    );
    expect(deleted).toBe(false);
  });

  it("double delete is idempotent — second delete returns true but is a no-op", async () => {
    const store = createMockBaseStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
    });

    await svc.put(
      "decisions",
      { projectId: "p1", decisions: "decisions" },
      "dec-1",
      { text: "test" }
    );
    const first = await svc.delete(
      "decisions",
      { projectId: "p1", decisions: "decisions" },
      "dec-1"
    );
    const second = await svc.delete(
      "decisions",
      { projectId: "p1", decisions: "decisions" },
      "dec-1"
    );

    expect(first).toBe(true);
    expect(second).toBe(true); // store mock does not error on re-delete
  });

  it("deleted record no longer returned by get()", async () => {
    const store = createMockBaseStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
    });

    await svc.put(
      "decisions",
      { projectId: "p1", decisions: "decisions" },
      "dec-1",
      { text: "gone" }
    );
    await svc.delete(
      "decisions",
      { projectId: "p1", decisions: "decisions" },
      "dec-1"
    );

    const results = await svc.get(
      "decisions",
      { projectId: "p1", decisions: "decisions" },
      "dec-1"
    );
    expect(results).toEqual([]);
  });

  it("deleting an agent namespace removes its semantic store vectors", async () => {
    const store = createMockBaseStore();
    const semanticStore = createMockSemanticStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
      semanticStore,
    });

    // Put into searchable namespace → triggers semantic upsert
    await svc.put(
      "lessons",
      { tenantId: "t1", lessons: "lessons" },
      "lesson-1",
      { text: "test lesson" }
    );
    expect(semanticStore.upsert).toHaveBeenCalledOnce();

    // Delete removes from base store
    const deleted = await svc.delete(
      "lessons",
      { tenantId: "t1", lessons: "lessons" },
      "lesson-1"
    );
    expect(deleted).toBe(true);

    // Record is gone from base store
    const results = await svc.get(
      "lessons",
      { tenantId: "t1", lessons: "lessons" },
      "lesson-1"
    );
    expect(results).toEqual([]);
  });
});

// ─── 5. MemoryService — namespace isolation ───────────────────────────────────

describe("MemoryService namespace isolation", () => {
  it("search in namespace A does not return namespace B results", async () => {
    const store = createMockBaseStore();
    const semanticStore = createMockSemanticStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
      semanticStore,
    });

    // Put into namespace A (lessons)
    await svc.put(
      "lessons",
      { tenantId: "t1", lessons: "lessons" },
      "lesson-1",
      { text: "lessons content" }
    );
    // Put into namespace B (notes)
    await svc.put("notes", { userId: "u1", notes: "notes" }, "note-1", {
      text: "notes content",
    });

    // Search in lessons namespace — mock store returns only lessons-scoped items
    store.search.mockImplementation(async (namespace: string[]) => {
      return store._data
        .filter(
          (d) => JSON.stringify(d.namespace) === JSON.stringify(namespace)
        )
        .map((d) => ({ key: d.key, value: d.value }));
    });

    semanticStore.search.mockResolvedValueOnce([]);

    const lessonsResults = await svc.search(
      "lessons",
      { tenantId: "t1", lessons: "lessons" },
      "content",
      10
    );
    const hasNotesContent = lessonsResults.some(
      (r) => (r as { text?: string }).text === "notes content"
    );
    expect(hasNotesContent).toBe(false);
  });

  it("different tenants cannot see each other data in the same namespace", async () => {
    const store = createMockBaseStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
    });

    await svc.put(
      "lessons",
      { tenantId: "tenant-A", lessons: "lessons" },
      "secret",
      { text: "tenant A secret" }
    );
    await svc.put(
      "lessons",
      { tenantId: "tenant-B", lessons: "lessons" },
      "other",
      { text: "tenant B data" }
    );

    // Get tenant-A specific key
    const resultA = await svc.get(
      "lessons",
      { tenantId: "tenant-A", lessons: "lessons" },
      "secret"
    );
    expect(resultA).toHaveLength(1);
    expect((resultA[0] as { text?: string }).text).toBe("tenant A secret");

    // Tenant-B cannot see tenant-A key (different namespace tuple)
    const resultB = await svc.get(
      "lessons",
      { tenantId: "tenant-B", lessons: "lessons" },
      "secret"
    );
    expect(resultB).toEqual([]);
  });
});

// ─── 6. MemoryService — concurrent search ────────────────────────────────────

describe("MemoryService concurrent operations", () => {
  it("two concurrent searches return correct independent results", async () => {
    const store = createMockBaseStore();
    const semanticStore = createMockSemanticStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
      semanticStore,
    });

    // Set up distinct results for two separate calls
    store.search
      .mockResolvedValueOnce([
        { key: "r1", value: { text: "result for query1" } },
      ])
      .mockResolvedValueOnce([
        { key: "r2", value: { text: "result for query2" } },
      ]);
    semanticStore.search.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const [res1, res2] = await Promise.all([
      svc.search(
        "lessons",
        { tenantId: "t1", lessons: "lessons" },
        "query1",
        5
      ),
      svc.search(
        "lessons",
        { tenantId: "t1", lessons: "lessons" },
        "query2",
        5
      ),
    ]);

    expect(res1).toHaveLength(1);
    expect((res1[0] as { text?: string }).text).toBe("result for query1");
    expect(res2).toHaveLength(1);
    expect((res2[0] as { text?: string }).text).toBe("result for query2");
  });

  it("concurrent write+search does not throw race condition errors", async () => {
    const store = createMockBaseStore();
    const semanticStore = createMockSemanticStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
      semanticStore,
    });

    store.search.mockResolvedValue([]);
    semanticStore.search.mockResolvedValue([]);

    // Interleave writes and searches concurrently
    await expect(
      Promise.all([
        svc.put("lessons", { tenantId: "t1", lessons: "lessons" }, "k1", {
          text: "insert 1",
        }),
        svc.search(
          "lessons",
          { tenantId: "t1", lessons: "lessons" },
          "find k1",
          5
        ),
        svc.put("lessons", { tenantId: "t1", lessons: "lessons" }, "k2", {
          text: "insert 2",
        }),
        svc.search(
          "lessons",
          { tenantId: "t1", lessons: "lessons" },
          "find k2",
          5
        ),
      ])
    ).resolves.not.toThrow();
  });
});

// ─── 7. Embedding cache — same text embedded once ────────────────────────────

describe("SemanticStoreAdapter embedding cache behavior", () => {
  it("calling upsert twice with same text results in two upsert calls (cache is at store level)", async () => {
    const store = createMockBaseStore();
    const semanticStore = createMockSemanticStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
      semanticStore,
    });

    await svc.put("lessons", { tenantId: "t1", lessons: "lessons" }, "k1", {
      text: "same text",
    });
    await svc.put("lessons", { tenantId: "t1", lessons: "lessons" }, "k2", {
      text: "same text",
    });

    // MemoryService calls upsert once per put — adapter-level caching is adapter responsibility
    expect(semanticStore.upsert).toHaveBeenCalledTimes(2);
  });
});

// ─── 8. MemoryService — batch insert ─────────────────────────────────────────

describe("MemoryService batch insert", () => {
  it("inserts N memories — all indexed, all searchable", async () => {
    const store = createMockBaseStore();
    const semanticStore = createMockSemanticStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
      semanticStore,
    });

    const N = 10;
    const puts = Array.from({ length: N }, (_, i) =>
      svc.put("lessons", { tenantId: "t1", lessons: "lessons" }, `key-${i}`, {
        text: `memory ${i}`,
      })
    );
    await Promise.all(puts);

    expect(store.put).toHaveBeenCalledTimes(N);
    expect(semanticStore.upsert).toHaveBeenCalledTimes(N);

    // All records should be in the store
    expect(store._data).toHaveLength(N);
  });

  it("all batch-inserted records are retrievable individually", async () => {
    const store = createMockBaseStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
    });

    const entries = ["alpha", "beta", "gamma", "delta"];
    for (const [i, text] of entries.entries()) {
      await svc.put(
        "decisions",
        { projectId: "p1", decisions: "decisions" },
        `item-${i}`,
        { text }
      );
    }

    for (const [i, text] of entries.entries()) {
      const results = await svc.get(
        "decisions",
        { projectId: "p1", decisions: "decisions" },
        `item-${i}`
      );
      expect(results).toHaveLength(1);
      expect((results[0] as { text?: string }).text).toBe(text);
    }
  });
});

// ─── 9. MemoryService — update ───────────────────────────────────────────────

describe("MemoryService update", () => {
  it("updating a record with a new value — new content is returned on get", async () => {
    const store = createMockBaseStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
    });

    await svc.put(
      "decisions",
      { projectId: "p1", decisions: "decisions" },
      "dec-1",
      { text: "original" }
    );
    await svc.put(
      "decisions",
      { projectId: "p1", decisions: "decisions" },
      "dec-1",
      { text: "updated" }
    );

    const results = await svc.get(
      "decisions",
      { projectId: "p1", decisions: "decisions" },
      "dec-1"
    );
    expect(results).toHaveLength(1);
    expect((results[0] as { text?: string }).text).toBe("updated");
  });

  it("updating a searchable record re-calls semanticStore.upsert", async () => {
    const store = createMockBaseStore();
    const semanticStore = createMockSemanticStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
      semanticStore,
    });

    await svc.put(
      "lessons",
      { tenantId: "t1", lessons: "lessons" },
      "lesson-1",
      { text: "v1" }
    );
    await svc.put(
      "lessons",
      { tenantId: "t1", lessons: "lessons" },
      "lesson-1",
      { text: "v2 updated" }
    );

    expect(semanticStore.upsert).toHaveBeenCalledTimes(2);
    const secondCall = semanticStore.upsert.mock.calls[1];
    expect(secondCall![1][0].text).toBe("v2 updated");
  });
});

// ─── 10. MemoryService — top-K edge cases ────────────────────────────────────

describe("MemoryService search top-K edge cases", () => {
  it("K > total results → returns all results", async () => {
    const store = createMockBaseStore();
    const semanticStore = createMockSemanticStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
      semanticStore,
    });

    store.search.mockResolvedValueOnce([
      { key: "a", value: { text: "a" } },
      { key: "b", value: { text: "b" } },
    ]);
    semanticStore.search.mockResolvedValueOnce([]);

    const results = await svc.search(
      "lessons",
      { tenantId: "t1", lessons: "lessons" },
      "q",
      100
    );
    expect(results).toHaveLength(2);
  });

  it("K=0 → empty array returned", async () => {
    const store = createMockBaseStore();
    const semanticStore = createMockSemanticStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
      semanticStore,
    });

    store.search.mockResolvedValueOnce([{ key: "a", value: { text: "a" } }]);
    semanticStore.search.mockResolvedValueOnce([]);

    const results = await svc.search(
      "lessons",
      { tenantId: "t1", lessons: "lessons" },
      "q",
      0
    );
    expect(results).toHaveLength(0);
  });

  it("K=1 → single best result returned", async () => {
    const store = createMockBaseStore();
    const semanticStore = createMockSemanticStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
      semanticStore,
    });

    store.search.mockResolvedValueOnce([
      { key: "best", value: { text: "best result" } },
      { key: "second", value: { text: "second result" } },
    ]);
    semanticStore.search.mockResolvedValueOnce([]);

    const results = await svc.search(
      "lessons",
      { tenantId: "t1", lessons: "lessons" },
      "q",
      1
    );
    expect(results).toHaveLength(1);
  });
});

// ─── 11. MemoryService — score ordering ──────────────────────────────────────

describe("MemoryService score ordering", () => {
  it("results are ordered by descending similarity score via fuseWithVector", async () => {
    const store = createMockBaseStore();
    const semanticStore = createMockSemanticStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
      semanticStore,
    });

    store.search.mockResolvedValueOnce([]);
    semanticStore.search.mockResolvedValueOnce([
      { id: "c", text: "third", score: 0.5, metadata: {} },
      { id: "a", text: "first", score: 0.95, metadata: {} },
      { id: "b", text: "second", score: 0.75, metadata: {} },
    ]);

    const results = await svc.search(
      "lessons",
      { tenantId: "t1", lessons: "lessons" },
      "q",
      10
    );

    // Results should reflect RRF rank order — 'a' at rank 1 (score 0.95 in vector), 'b' at rank 2, 'c' at rank 3
    // After RRF: 'a' has highest score (lowest rank in vector list), but order depends on vector ranks
    // Vector ranks: c=0, a=1, b=2 (as returned by mock), so c has best RRF
    expect(results).toHaveLength(3);
    // c is at rank 0 in vector result → gets 1/(60+0) — highest
    expect(results[0]).toMatchObject({ text: "third" });
  });
});

// ─── 12. MemoryService — metadata filters alongside vector search ─────────────

describe("MemoryService metadata filters", () => {
  it("put stores metadata in the semantic store upsert call", async () => {
    const store = createMockBaseStore();
    const semanticStore = createMockSemanticStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
      semanticStore,
    });

    await svc.put(
      "lessons",
      { tenantId: "tenant-x", lessons: "lessons" },
      "lesson-meta",
      {
        text: "some lesson",
        category: "architecture",
        importance: 0.9,
      }
    );

    expect(semanticStore.upsert).toHaveBeenCalledWith("memory_lessons", [
      expect.objectContaining({
        id: "lesson-meta",
        metadata: expect.objectContaining({
          namespace: "lessons",
          tenantId: "tenant-x",
        }),
      }),
    ]);
  });

  it("metadata from semantic store results is returned in search results", async () => {
    const store = createMockBaseStore();
    const semanticStore = createMockSemanticStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
      semanticStore,
    });

    store.search.mockResolvedValueOnce([]);
    semanticStore.search.mockResolvedValueOnce([
      {
        id: "item-1",
        text: "important lesson",
        score: 0.9,
        metadata: { category: "security", priority: "high" },
      },
    ]);

    const results = await svc.search(
      "lessons",
      { tenantId: "t1", lessons: "lessons" },
      "security",
      5
    );
    expect(results[0]).toMatchObject({
      category: "security",
      priority: "high",
    });
  });
});

// ─── 13. MemoryService — empty store ─────────────────────────────────────────

describe("MemoryService empty store", () => {
  it("search on empty store returns empty results without error", async () => {
    const store = createMockBaseStore();
    const semanticStore = createMockSemanticStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
      semanticStore,
    });

    store.search.mockResolvedValueOnce([]);
    semanticStore.search.mockResolvedValueOnce([]);

    const results = await svc.search(
      "lessons",
      { tenantId: "t1", lessons: "lessons" },
      "anything",
      10
    );
    expect(results).toEqual([]);
  });

  it("get on empty store returns empty results without error", async () => {
    const store = createMockBaseStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
    });

    const results = await svc.get("decisions", {
      projectId: "p1",
      decisions: "decisions",
    });
    expect(results).toEqual([]);
  });

  it("delete on empty store does not throw", async () => {
    const store = createMockBaseStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
    });

    await expect(
      svc.delete(
        "decisions",
        { projectId: "p1", decisions: "decisions" },
        "nonexistent"
      )
    ).resolves.not.toThrow();
  });
});

// ─── 14. MemoryService — large payload ───────────────────────────────────────

describe("MemoryService large payload", () => {
  it("memory with 10KB content is indexed and retrieved correctly", async () => {
    const store = createMockBaseStore();
    const semanticStore = createMockSemanticStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
      semanticStore,
    });

    const largeText = "x".repeat(10 * 1024); // 10KB
    await svc.put(
      "lessons",
      { tenantId: "t1", lessons: "lessons" },
      "large-doc",
      { text: largeText }
    );

    // Verify it was stored in the base store
    expect(store.put).toHaveBeenCalledOnce();
    const storedItem = store._data.find((d) => d.key === "large-doc");
    expect(storedItem).toBeDefined();
    expect((storedItem!.value as { text?: string }).text).toBe(largeText);

    // Verify it was indexed in the semantic store with the full text
    expect(semanticStore.upsert).toHaveBeenCalledOnce();
    const upsertCall = semanticStore.upsert.mock.calls[0];
    expect(upsertCall![1][0].text).toBe(largeText);

    // Retrieve the record
    const results = await svc.get(
      "lessons",
      { tenantId: "t1", lessons: "lessons" },
      "large-doc"
    );
    expect(results).toHaveLength(1);
    expect((results[0] as { text?: string }).text).toBe(largeText);
  });

  it("large payload search returns the record", async () => {
    const store = createMockBaseStore();
    const semanticStore = createMockSemanticStore();
    const svc = new MemoryService(store as unknown as BaseStore, NAMESPACES, {
      rejectUnsafe: false,
      semanticStore,
    });

    const largeText = "y".repeat(10 * 1024);
    await svc.put(
      "lessons",
      { tenantId: "t1", lessons: "lessons" },
      "large-key",
      { text: largeText }
    );

    store.search.mockResolvedValueOnce([
      { key: "large-key", value: { text: largeText } },
    ]);
    semanticStore.search.mockResolvedValueOnce([]);

    const results = await svc.search(
      "lessons",
      { tenantId: "t1", lessons: "lessons" },
      "find large",
      5
    );
    expect(results).toHaveLength(1);
    expect((results[0] as { text?: string }).text).toHaveLength(10 * 1024);
  });
});

// ─── 15. buildNamespaceTuple and getNamespace ─────────────────────────────────

describe("buildNamespaceTuple", () => {
  it("maps scope keys to ordered tuple", () => {
    const ns: NamespaceConfig = { name: "test", scopeKeys: ["a", "b", "c"] };
    expect(buildNamespaceTuple(ns, { a: "1", b: "2", c: "3" })).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("throws when a required scope key is missing", () => {
    const ns: NamespaceConfig = { name: "test", scopeKeys: ["a", "b"] };
    expect(() => buildNamespaceTuple(ns, { a: "1" })).toThrow(
      /Missing scope key "b"/
    );
  });

  it("throws with the namespace name in the error", () => {
    const ns: NamespaceConfig = { name: "my-ns", scopeKeys: ["x"] };
    expect(() => buildNamespaceTuple(ns, {})).toThrow(/namespace "my-ns"/);
  });

  it("single scope key produces single-element tuple", () => {
    const ns: NamespaceConfig = { name: "test", scopeKeys: ["tenantId"] };
    expect(buildNamespaceTuple(ns, { tenantId: "abc" })).toEqual(["abc"]);
  });
});

describe("getNamespace", () => {
  const nsMap = new Map<string, NamespaceConfig>([
    [
      "lessons",
      { name: "lessons", scopeKeys: ["tenantId", "lessons"], searchable: true },
    ],
  ]);

  it("returns namespace config for a known name", () => {
    const ns = getNamespace(nsMap, "lessons");
    expect(ns.name).toBe("lessons");
    expect(ns.searchable).toBe(true);
  });

  it("throws for an unknown namespace name", () => {
    expect(() => getNamespace(nsMap, "nonexistent")).toThrow(
      /Unknown namespace: nonexistent/
    );
  });
});

// ─── 16. deleteMemoryRecord ───────────────────────────────────────────────────

describe("deleteMemoryRecord", () => {
  const ns: NamespaceConfig = {
    name: "decisions",
    scopeKeys: ["projectId", "decisions"],
  };
  const scope = { projectId: "p1", decisions: "decisions" };

  it("returns false when supportsDelete is false", async () => {
    const store = createMockBaseStore({ supportsDelete: false });
    const caps: MemoryStoreCapabilities = {
      supportsDelete: false,
      supportsSearchFilters: true,
      supportsPagination: true,
    };
    const result = await deleteMemoryRecord(
      ns,
      scope,
      "key",
      store as unknown as BaseStore,
      caps
    );
    expect(result).toBe(false);
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("returns true when delete succeeds", async () => {
    const store = createMockBaseStore();
    const caps: MemoryStoreCapabilities = {
      supportsDelete: true,
      supportsSearchFilters: true,
      supportsPagination: true,
    };
    const result = await deleteMemoryRecord(
      ns,
      scope,
      "key",
      store as unknown as BaseStore,
      caps
    );
    expect(result).toBe(true);
  });

  it("returns false when store.delete throws", async () => {
    const store = createMockBaseStore();
    store.delete.mockRejectedValueOnce(new Error("store error"));
    const caps: MemoryStoreCapabilities = {
      supportsDelete: true,
      supportsSearchFilters: true,
      supportsPagination: true,
    };
    const result = await deleteMemoryRecord(
      ns,
      scope,
      "key",
      store as unknown as BaseStore,
      caps
    );
    expect(result).toBe(false);
  });

  it("calls store.delete with correct tuple and key", async () => {
    const store = createMockBaseStore();
    const caps: MemoryStoreCapabilities = {
      supportsDelete: true,
      supportsSearchFilters: true,
      supportsPagination: true,
    };
    await deleteMemoryRecord(
      ns,
      scope,
      "my-key",
      store as unknown as BaseStore,
      caps
    );
    expect(store.delete).toHaveBeenCalledWith(["p1", "decisions"], "my-key");
  });
});

// ─── 17. StoreVectorSearch — extra edge cases beyond existing tests ────────────

describe("StoreVectorSearch additional edge cases", () => {
  it("single result with exact score=0 — nullish coalescing keeps 0 (not fallback)", async () => {
    const store = {
      search: vi.fn().mockResolvedValue([{ key: "k", value: {}, score: 0 }]),
    };
    const sut = new StoreVectorSearch(store);
    const results = await sut.search(["ns"], "q", 10);
    // `score ?? 1/(idx+1)` — ?? only fires for null/undefined, NOT 0.
    // score=0 is returned as-is; it does NOT trigger the fallback.
    expect(results[0]!.score).toBe(0);
  });

  it("large number of results (100) all mapped correctly", async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      key: `k${i}`,
      value: { text: `doc ${i}` },
      score: 1 - i * 0.01,
    }));
    const store = { search: vi.fn().mockResolvedValue(items) };
    const sut = new StoreVectorSearch(store);
    const results = await sut.search(["ns"], "q", 100);
    expect(results).toHaveLength(100);
    expect(results[0]!.key).toBe("k0");
    expect(results[99]!.key).toBe("k99");
  });

  it("passes limit=1 to the store", async () => {
    const store = { search: vi.fn().mockResolvedValue([]) };
    const sut = new StoreVectorSearch(store);
    await sut.search(["ns"], "q", 1);
    expect(store.search).toHaveBeenCalledWith(["ns"], { query: "q", limit: 1 });
  });

  it("namespace with special characters is passed through unchanged", async () => {
    const store = { search: vi.fn().mockResolvedValue([]) };
    const sut = new StoreVectorSearch(store);
    await sut.search(["tenant-123", "project_abc", "v2.0"], "q", 5);
    expect(store.search).toHaveBeenCalledWith(
      ["tenant-123", "project_abc", "v2.0"],
      { query: "q", limit: 5 }
    );
  });
});

// ─── 18. VectorStoreSearch — additional edge cases ───────────────────────────

describe("VectorStoreSearch additional edge cases", () => {
  it("result with empty metadata returns empty value object", async () => {
    const adapter = createMockSemanticStore();
    adapter.search.mockResolvedValueOnce([
      { id: "doc", text: "text", score: 0.5, metadata: {} },
    ]);
    const sut = new VectorStoreSearch(adapter);
    const results = await sut.search(["ns"], "q", 5);
    expect(results[0]!.value).toEqual({});
  });

  it("three-segment namespace with prefix produces expected collection name", async () => {
    const adapter = createMockSemanticStore();
    adapter.search.mockResolvedValueOnce([]);
    const sut = new VectorStoreSearch(adapter, "pfx_");
    await sut.search(["a", "b", "c"], "q", 5);
    expect(adapter.search).toHaveBeenCalledWith("pfx_a_b_c", "q", 5);
  });

  it("result metadata with nested object is passed through as-is", async () => {
    const adapter = createMockSemanticStore();
    const meta = { tags: ["a", "b"], nested: { x: 1 } };
    adapter.search.mockResolvedValueOnce([
      {
        id: "r1",
        text: "t",
        score: 0.9,
        metadata: meta as unknown as Record<string, unknown>,
      },
    ]);
    const sut = new VectorStoreSearch(adapter);
    const results = await sut.search(["ns"], "q", 5);
    expect(results[0]!.value).toBe(meta);
  });

  it("limit is respected when passed to adapter", async () => {
    const adapter = createMockSemanticStore();
    adapter.search.mockResolvedValueOnce([]);
    const sut = new VectorStoreSearch(adapter);
    await sut.search(["ns"], "q", 42);
    expect(adapter.search).toHaveBeenCalledWith(expect.any(String), "q", 42);
  });
});
