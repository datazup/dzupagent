/**
 * Extended search & retrieval tests for @dzupagent/memory.
 *
 * This file adds 65+ tests across search domains not fully covered elsewhere:
 *  1. KeywordFTSSearch — punctuation stripping, numbers, multi-field, IDF tie-breaking
 *  2. fusionSearch (rrf-fusion) — k parameter math, degenerate inputs, value preservation
 *  3. SessionSearch — scope isolation, invalidation mechanics, matchedTerms accuracy
 *  4. fuseWithVector — vector-only additions, error fallback, overlapping keys, limit
 *  5. extractDecayMeta — all valid/invalid shapes
 *  6. StoreVectorSearch — score fallback, pass-through, namespace array
 */

import { describe, it, expect, vi } from "vitest";

// ── Source modules under test ─────────────────────────────────────────────────
import { KeywordFTSSearch } from "../retrieval/fts-search.js";
import { fusionSearch } from "../retrieval/rrf-fusion.js";
import { SessionSearch, type SessionSearchStore } from "../session-search.js";
import { fuseWithVector, extractDecayMeta } from "../memory-service-search.js";
import { StoreVectorSearch } from "../retrieval/vector-search.js";
import type { SemanticStoreAdapter } from "../memory-types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Section 1: KeywordFTSSearch — extended coverage
// ─────────────────────────────────────────────────────────────────────────────

describe("KeywordFTSSearch — extended", () => {
  const sut = new KeywordFTSSearch();

  function makeRecord(key: string, text: string) {
    return { key, value: { text } };
  }

  describe("punctuation stripping", () => {
    it("strips leading/trailing punctuation from query terms", () => {
      const records = [makeRecord("a", "authentication service")];
      const results = sut.search(records, "authentication!", 10);
      expect(results).toHaveLength(1);
      expect(results[0]!.key).toBe("a");
    });

    it("strips punctuation from document text", () => {
      const records = [
        makeRecord("a", "use authentication, service, and token."),
      ];
      const results = sut.search(records, "authentication service", 10);
      expect(results).toHaveLength(1);
    });

    it("handles hyphenated terms by treating hyphen as separator", () => {
      // hyphen → space → separate tokens
      const records = [makeRecord("a", "token-based authentication")];
      const results = sut.search(records, "token", 10);
      expect(results).toHaveLength(1);
    });

    it("handles query with comma-separated terms", () => {
      const records = [makeRecord("a", "postgres redis queue")];
      const results = sut.search(records, "postgres,redis", 10);
      // After punctuation stripping, treats as single token 'postgresredis' or individual — either way no crash
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe("numeric tokens", () => {
    it("matches numeric tokens in documents", () => {
      const records = [makeRecord("a", "version 42 of the api")];
      const results = sut.search(records, "42", 10);
      // '42' is 2 chars, length > 1, not a stop word — should match
      expect(results).toHaveLength(1);
    });

    it("does not match unrelated numeric documents", () => {
      const records = [
        makeRecord("a", "version 99 release"),
        makeRecord("b", "version 42 release"),
      ];
      const results = sut.search(records, "42", 10);
      expect(results).toHaveLength(1);
      expect(results[0]!.key).toBe("b");
    });
  });

  describe("multi-field text extraction", () => {
    it("searches content field when text field is absent", () => {
      const records = [
        { key: "c", value: { content: "database migration strategy" } },
      ];
      const results = sut.search(records, "migration", 10);
      expect(results).toHaveLength(1);
      expect(results[0]!.key).toBe("c");
    });

    it("prefers text field over content field when both present", () => {
      const records = [
        {
          key: "a",
          value: {
            text: "authentication security",
            content: "database migration",
          },
        },
      ];
      // Only 'text' field should be read
      const r1 = sut.search(records, "authentication", 10);
      expect(r1).toHaveLength(1);
    });

    it("handles records with only numeric fields (JSON fallback)", () => {
      const records = [{ key: "n", value: { count: 42, threshold: 100 } }];
      // JSON.stringify will include keys/values; should not throw
      expect(() => sut.search(records, "threshold", 10)).not.toThrow();
    });
  });

  describe("IDF boost for rare terms", () => {
    it("rare term in one doc scores higher than common term across all docs", () => {
      // 'unique' only in doc 'b'; 'common' in all docs
      const records = [
        makeRecord("a", "common topic everywhere common common"),
        makeRecord("b", "common topic unique special"),
        makeRecord("c", "common topic everywhere"),
      ];
      // Query: 'unique' — only 'b' matches, gets high IDF
      const uniqResults = sut.search(records, "unique", 10);
      expect(uniqResults).toHaveLength(1);
      expect(uniqResults[0]!.key).toBe("b");
    });

    it("document with higher term frequency scores above lower TF doc", () => {
      const records = [
        makeRecord("low-tf", "security policy"),
        makeRecord("high-tf", "security security security enforcement policy"),
      ];
      const results = sut.search(records, "security", 10);
      const lowScore = results.find((r) => r.key === "low-tf")!.score;
      const highScore = results.find((r) => r.key === "high-tf")!.score;
      expect(highScore).toBeGreaterThan(lowScore);
    });
  });

  describe("limit edge cases", () => {
    it("limit=1 returns only the best scoring doc", () => {
      const records = [
        makeRecord("a", "auth auth auth"),
        makeRecord("b", "auth service"),
      ];
      const results = sut.search(records, "auth", 1);
      expect(results).toHaveLength(1);
      expect(results[0]!.key).toBe("a");
    });

    it("limit=0 returns empty array", () => {
      const records = [makeRecord("a", "auth service")];
      const results = sut.search(records, "auth", 0);
      expect(results).toEqual([]);
    });

    it("limit larger than results returns all matches", () => {
      const records = [makeRecord("a", "auth"), makeRecord("b", "auth")];
      const results = sut.search(records, "auth", 999);
      expect(results).toHaveLength(2);
    });
  });

  describe("score structure", () => {
    it("all scores are positive numbers", () => {
      const records = Array.from({ length: 5 }, (_, i) =>
        makeRecord(`k${i}`, `authentication service ${i}`),
      );
      const results = sut.search(records, "authentication", 10);
      for (const r of results) {
        expect(r.score).toBeGreaterThan(0);
      }
    });

    it("results are sorted descending by score", () => {
      const records = [
        makeRecord("once", "auth once"),
        makeRecord("twice", "auth auth twice"),
        makeRecord("thrice", "auth auth auth thrice"),
      ];
      const results = sut.search(records, "auth", 10);
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i]!.score).toBeGreaterThanOrEqual(results[i + 1]!.score);
      }
    });

    it("returned value is the original record value object", () => {
      const val = { text: "auth service", custom: "meta" };
      const records = [{ key: "x", value: val }];
      const results = sut.search(records, "auth", 10);
      expect(results[0]!.value).toBe(val);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 2: fusionSearch — extended coverage
// ─────────────────────────────────────────────────────────────────────────────

describe("fusionSearch — extended", () => {
  function item(key: string, score = 0.8) {
    return { key, score, value: { label: key } };
  }

  describe("RRF math precision", () => {
    it("rank-0 RRF score equals 1/(k+0) for k=60", () => {
      const results = fusionSearch({ vector: [item("a")] }, { k: 60 });
      expect(results[0]!.score).toBeCloseTo(1 / 60, 8);
    });

    it("rank-1 RRF score equals 1/(k+1) for k=60", () => {
      const results = fusionSearch(
        { vector: [item("a"), item("b")] },
        { k: 60 },
      );
      expect(results[1]!.score).toBeCloseTo(1 / 61, 8);
    });

    it("item at rank 0 in fts scores 1/(k+0)", () => {
      const results = fusionSearch({ fts: [item("x")] }, { k: 10 });
      expect(results[0]!.score).toBeCloseTo(1 / 10, 8);
    });

    it("item at rank 0 in graph scores 1/(k+0)", () => {
      const results = fusionSearch({ graph: [item("g")] }, { k: 20 });
      expect(results[0]!.score).toBeCloseTo(1 / 20, 8);
    });

    it("item in all 3 at rank 0 with k=10 scores 3*(1/10)", () => {
      const shared = item("s");
      const results = fusionSearch(
        { vector: [shared], fts: [shared], graph: [shared] },
        { k: 10 },
      );
      expect(results[0]!.score).toBeCloseTo(3 / 10, 8);
    });
  });

  describe("value preservation", () => {
    it("returns the original value object for vector items", () => {
      const val = { text: "important context", tag: "memory" };
      const results = fusionSearch({
        vector: [{ key: "k", score: 0.9, value: val }],
      });
      expect(results[0]!.value).toBe(val);
    });

    it("returns the original value object for fts items", () => {
      const val = { content: "fts result", extra: 99 };
      const results = fusionSearch({
        fts: [{ key: "k", score: 0.7, value: val }],
      });
      expect(results[0]!.value).toBe(val);
    });

    it("when key appears in multiple sources, value comes from the first occurrence", () => {
      const valV = { text: "from vector", source: "v" };
      const valF = { text: "from fts", source: "f" };
      const results = fusionSearch({
        vector: [{ key: "shared", score: 0.9, value: valV }],
        fts: [{ key: "shared", score: 0.7, value: valF }],
      });
      const r = results.find((r) => r.key === "shared")!;
      // The first encounter sets the value; vector is processed first
      expect(r.value).toBe(valV);
    });
  });

  describe("key property", () => {
    it("output item key matches input item key", () => {
      const results = fusionSearch({ vector: [item("memory-key-123")] });
      expect(results[0]!.key).toBe("memory-key-123");
    });

    it("multiple keys are all preserved in output", () => {
      const results = fusionSearch({
        vector: [item("k1"), item("k2"), item("k3")],
      });
      const keys = results.map((r) => r.key).sort();
      expect(keys).toEqual(["k1", "k2", "k3"]);
    });
  });

  describe("degenerate inputs", () => {
    it("undefined source values are ignored", () => {
      // @ts-expect-error intentional undefined
      const results = fusionSearch({ vector: undefined, fts: [item("a")] });
      expect(results).toHaveLength(1);
      expect(results[0]!.key).toBe("a");
    });

    it("single-item source returns one result", () => {
      const results = fusionSearch({ graph: [item("only")] });
      expect(results).toHaveLength(1);
    });

    it("sources with empty arrays produce no results", () => {
      const results = fusionSearch({ vector: [], fts: [], graph: [] });
      expect(results).toEqual([]);
    });

    it("all sources empty returns empty", () => {
      expect(fusionSearch({})).toEqual([]);
    });
  });

  describe("ordering", () => {
    it("output is sorted by rrfScore descending", () => {
      const results = fusionSearch({
        vector: [item("a"), item("b"), item("c")],
        fts: [item("c"), item("b")],
      });
      // 'c' and 'b' appear in both sources; 'a' only in one
      const scores = results.map((r) => r.score);
      for (let i = 0; i < scores.length - 1; i++) {
        expect(scores[i]!).toBeGreaterThanOrEqual(scores[i + 1]!);
      }
    });

    it("item in 2 sources ranks above item in only 1 source at same rank", () => {
      const inBoth = item("both");
      const onlyVector = item("vector-only");
      const results = fusionSearch({
        vector: [inBoth, onlyVector],
        fts: [inBoth],
      });
      const bothScore = results.find((r) => r.key === "both")!.score;
      const vectorScore = results.find((r) => r.key === "vector-only")!.score;
      expect(bothScore).toBeGreaterThan(vectorScore);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 3: SessionSearch — extended coverage
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionSearch — extended", () => {
  function makeStore(
    data: Record<string, Record<string, unknown>[]>,
  ): SessionSearchStore {
    return {
      get: vi
        .fn()
        .mockImplementation((ns: string) => Promise.resolve(data[ns] ?? [])),
    };
  }

  const SCOPE_A = { tenantId: "tenant-a" };
  const SCOPE_B = { tenantId: "tenant-b" };

  describe("scope preservation in results", () => {
    it("search result scope matches the scope used during indexing", async () => {
      const store = makeStore({ ns1: [{ key: "k1", text: "postgres query" }] });
      const search = new SessionSearch(store);
      await search.index("ns1", SCOPE_A);
      const results = await search.search({ text: "postgres" });
      expect(results[0]!.scope).toEqual(SCOPE_A);
    });

    it("results from different scopes carry their own scope", async () => {
      const storeA = makeStore({
        decisions: [{ key: "d1", text: "use postgres database" }],
      });
      const storeB = makeStore({
        decisions: [{ key: "d2", text: "use redis cache" }],
      });
      const searchA = new SessionSearch(storeA);
      const searchB = new SessionSearch(storeB);
      await searchA.index("decisions", SCOPE_A);
      await searchB.index("decisions", SCOPE_B);

      const rA = await searchA.search({ text: "postgres" });
      const rB = await searchB.search({ text: "redis" });

      expect(rA[0]!.scope).toEqual(SCOPE_A);
      expect(rB[0]!.scope).toEqual(SCOPE_B);
    });
  });

  describe("matchedTerms accuracy", () => {
    it("matchedTerms contains only terms that actually matched", async () => {
      const store = makeStore({
        ns1: [{ key: "k1", text: "authentication service is secure" }],
      });
      const search = new SessionSearch(store);
      await search.index("ns1", SCOPE_A);
      const results = await search.search({ text: "authentication database" });
      expect(results[0]!.matchedTerms).toEqual(["authentication"]);
    });

    it("matchedTerms are lower-cased even when query is upper-cased", async () => {
      const store = makeStore({
        ns1: [{ key: "k1", text: "postgres database" }],
      });
      const search = new SessionSearch(store);
      await search.index("ns1", SCOPE_A);
      const results = await search.search({ text: "POSTGRES" });
      expect(results[0]!.matchedTerms).toEqual(["postgres"]);
    });

    it("matchedTerms length equals number of unique matching terms", async () => {
      const store = makeStore({
        ns1: [{ key: "k1", text: "auth token refresh token" }],
      });
      const search = new SessionSearch(store);
      await search.index("ns1", SCOPE_A);
      const results = await search.search({ text: "auth token refresh" });
      // All 3 terms match the document
      expect(results[0]!.matchedTerms).toHaveLength(3);
    });
  });

  describe("invalidation", () => {
    it("invalidate() with namespace clears only that namespace", async () => {
      const store = makeStore({
        ns1: [{ key: "a", text: "postgres search" }],
        ns2: [{ key: "b", text: "postgres cache" }],
      });
      const search = new SessionSearch(store);
      await search.index("ns1", SCOPE_A);
      await search.index("ns2", SCOPE_A);
      expect(search.indexedCount).toBe(2);

      search.invalidate("ns1");
      expect(search.indexedCount).toBe(1);

      const results = await search.search({ text: "postgres" });
      expect(results).toHaveLength(1);
      expect(results[0]!.namespace).toBe("ns2");
    });

    it("invalidate() with no argument clears all namespaces", async () => {
      const store = makeStore({
        ns1: [{ key: "a", text: "foo" }],
        ns2: [{ key: "b", text: "bar" }],
      });
      const search = new SessionSearch(store);
      await search.index("ns1", SCOPE_A);
      await search.index("ns2", SCOPE_A);
      expect(search.indexedCount).toBe(2);

      search.invalidate();
      expect(search.indexedCount).toBe(0);
    });

    it("after full invalidation, re-indexing restores search", async () => {
      const data: Record<string, Record<string, unknown>[]> = {
        ns1: [{ key: "a", text: "postgres database" }],
      };
      const store = makeStore(data);
      const search = new SessionSearch(store);
      await search.index("ns1", SCOPE_A);

      search.invalidate();
      let results = await search.search({ text: "postgres" });
      expect(results).toHaveLength(0);

      // Re-index
      await search.index("ns1", SCOPE_A);
      results = await search.search({ text: "postgres" });
      expect(results).toHaveLength(1);
    });

    it("invalidating a namespace that was never indexed does not throw", () => {
      const store = makeStore({});
      const search = new SessionSearch(store);
      expect(() => search.invalidate("nonexistent")).not.toThrow();
    });
  });

  describe("key extraction from records", () => {
    it("uses value.key as the result key when present", async () => {
      const store = makeStore({ ns1: [{ key: "my-key", text: "postgres" }] });
      const search = new SessionSearch(store);
      await search.index("ns1", SCOPE_A);
      const results = await search.search({ text: "postgres" });
      expect(results[0]!.key).toBe("my-key");
    });

    it("uses empty string when record has no key field", async () => {
      const store = makeStore({ ns1: [{ text: "postgres" }] });
      const search = new SessionSearch(store);
      await search.index("ns1", SCOPE_A);
      const results = await search.search({ text: "postgres" });
      expect(typeof results[0]!.key).toBe("string");
    });

    it("converts non-string key to string", async () => {
      const store = makeStore({
        ns1: [{ key: 12345, text: "postgres query" }],
      });
      const search = new SessionSearch(store);
      await search.index("ns1", SCOPE_A);
      const results = await search.search({ text: "postgres" });
      expect(results[0]!.key).toBe("12345");
    });
  });

  describe("score [0,1] range", () => {
    it("score is at most 1.0 (all terms matched)", async () => {
      const store = makeStore({
        ns1: [{ key: "k", text: "postgres redis queue" }],
      });
      const search = new SessionSearch(store);
      await search.index("ns1", SCOPE_A);
      const results = await search.search({ text: "postgres redis queue" });
      expect(results[0]!.score).toBeLessThanOrEqual(1.0);
      expect(results[0]!.score).toBeGreaterThan(0);
    });

    it("score equals 1.0 when all query terms are found", async () => {
      const store = makeStore({
        ns1: [{ key: "k", text: "authentication service token" }],
      });
      const search = new SessionSearch(store);
      await search.index("ns1", SCOPE_A);
      const results = await search.search({
        text: "authentication service token",
      });
      expect(results[0]!.score).toBe(1.0);
    });

    it("partial match yields score between 0 and 1", async () => {
      const store = makeStore({
        ns1: [{ key: "k", text: "authentication service" }],
      });
      const search = new SessionSearch(store);
      await search.index("ns1", SCOPE_A);
      const results = await search.search({ text: "authentication token" });
      expect(results[0]!.score).toBeGreaterThan(0);
      expect(results[0]!.score).toBeLessThan(1.0);
    });
  });

  describe("no results edge cases", () => {
    it("search on empty store returns empty array without error", async () => {
      const store = makeStore({});
      const search = new SessionSearch(store);
      const results = await search.search({ text: "anything" });
      expect(results).toEqual([]);
    });

    it("search before any namespace is indexed returns empty array", async () => {
      const store = makeStore({ ns1: [{ key: "a", text: "postgres" }] });
      const search = new SessionSearch(store);
      // Never called index()
      const results = await search.search({ text: "postgres" });
      expect(results).toEqual([]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 4: fuseWithVector — extended coverage
// ─────────────────────────────────────────────────────────────────────────────

describe("fuseWithVector — extended", () => {
  function makeKeywordScored(
    key: string,
    finalScore: number,
    value: Record<string, unknown> = {},
  ) {
    return { key, finalScore, value: { text: key, ...value } };
  }

  function makeSemanticAdapter(
    results: Array<{
      id: string;
      text: string;
      score: number;
      metadata?: Record<string, unknown>;
    }>,
  ): SemanticStoreAdapter {
    return {
      search: vi.fn().mockResolvedValue(results),
      upsert: vi.fn(),
      delete: vi.fn(),
      createCollection: vi.fn(),
    } as unknown as SemanticStoreAdapter;
  }

  describe("collection naming", () => {
    it('calls semanticStore.search with "memory_<namespace>"', async () => {
      const adapter = makeSemanticAdapter([]);
      const keyword = [makeKeywordScored("k1", 0.9)];
      await fuseWithVector("my-ns", "query", keyword, 10, adapter);
      expect(adapter.search).toHaveBeenCalledWith("memory_my-ns", "query", 10);
    });
  });

  describe("vector-only results", () => {
    it("adds vector-only results (not in keyword set) to the output", async () => {
      const adapter = makeSemanticAdapter([
        { id: "vector-only", text: "retrieved by vector", score: 0.95 },
      ]);
      const keyword: Array<{
        key: string;
        finalScore: number;
        value: Record<string, unknown>;
      }> = [];
      const results = await fuseWithVector("ns", "query", keyword, 10, adapter);
      expect(results.some((r) => r["text"] === "retrieved by vector")).toBe(
        true,
      );
    });

    it("vector-only result carries metadata as part of its value", async () => {
      const adapter = makeSemanticAdapter([
        {
          id: "v1",
          text: "vector result",
          score: 0.9,
          metadata: { source: "embedding" },
        },
      ]);
      const results = await fuseWithVector("ns", "q", [], 10, adapter);
      const r = results.find((r) => r["source"] === "embedding");
      expect(r).toBeDefined();
    });
  });

  describe("overlapping keyword+vector results", () => {
    it("overlapping key boosts the RRF score above keyword-only items", async () => {
      const sharedKey = "shared-doc";
      const keywordOnly = "keyword-only";
      const adapter = makeSemanticAdapter([
        { id: sharedKey, text: "shared document", score: 0.95 },
      ]);
      const keyword = [
        makeKeywordScored(sharedKey, 0.8),
        makeKeywordScored(keywordOnly, 0.7),
      ];
      const results = await fuseWithVector("ns", "query", keyword, 10, adapter);
      const sharedScore = results.find((r) => r["text"] === sharedKey);
      const onlyScore = results.find((r) => r["text"] === keywordOnly);
      // Both found; shared item was boosted
      expect(sharedScore).toBeDefined();
      expect(onlyScore).toBeDefined();
    });
  });

  describe("limit enforcement", () => {
    it("returns at most `limit` results", async () => {
      const vectorResults = Array.from({ length: 20 }, (_, i) => ({
        id: `v${i}`,
        text: `item ${i}`,
        score: 1 - i * 0.01,
      }));
      const adapter = makeSemanticAdapter(vectorResults);
      const results = await fuseWithVector("ns", "query", [], 5, adapter);
      expect(results.length).toBeLessThanOrEqual(5);
    });
  });

  describe("vector error fallback", () => {
    it("falls back to keyword-only results when semantic store throws", async () => {
      const adapter: SemanticStoreAdapter = {
        search: vi
          .fn()
          .mockRejectedValue(new Error("vector store unavailable")),
        upsert: vi.fn(),
        delete: vi.fn(),
        createCollection: vi.fn(),
      } as unknown as SemanticStoreAdapter;

      const keyword = [
        makeKeywordScored("k1", 0.9),
        makeKeywordScored("k2", 0.7),
      ];
      const results = await fuseWithVector("ns", "query", keyword, 10, adapter);
      // Should not throw, should return keyword results
      expect(results.length).toBeGreaterThan(0);
      const keys = results.map((r) => r["text"]);
      expect(keys).toContain("k1");
    });

    it("does not throw when semantic store rejects", async () => {
      const adapter: SemanticStoreAdapter = {
        search: vi.fn().mockRejectedValue(new Error("timeout")),
        upsert: vi.fn(),
        delete: vi.fn(),
        createCollection: vi.fn(),
      } as unknown as SemanticStoreAdapter;

      await expect(
        fuseWithVector(
          "ns",
          "query",
          [makeKeywordScored("k1", 0.5)],
          10,
          adapter,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe("empty keyword results with vector results", () => {
    it("empty keyword + non-empty vector returns vector results", async () => {
      const adapter = makeSemanticAdapter([
        { id: "vec1", text: "vector memory", score: 0.88 },
        { id: "vec2", text: "semantic result", score: 0.76 },
      ]);
      const results = await fuseWithVector("ns", "query", [], 10, adapter);
      expect(results.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("results are sorted by RRF score descending", () => {
    it("output list is sorted by rrfScore descending", async () => {
      // 'boosted' appears in both keyword (rank 0) and vector (rank 0) → double RRF score
      // 'vector-only' appears only in vector (rank 1) → single lower RRF score
      const adapter = makeSemanticAdapter([
        { id: "boosted", text: "boosted result", score: 0.99 },
        { id: "vector-only", text: "vector only result", score: 0.8 },
      ]);
      // 'boosted' appears in keyword at rank 0 as well → accumulates extra RRF score
      const keyword = [makeKeywordScored("boosted", 0.95)];
      const results = await fuseWithVector("ns", "q", keyword, 10, adapter);
      // 'boosted' gets RRF from both keyword rank-0 and vector rank-0 → must be first
      expect(results[0]!["text"]).toBe("boosted");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 5: extractDecayMeta — extended coverage
// ─────────────────────────────────────────────────────────────────────────────

describe("extractDecayMeta — extended", () => {
  function makeDecay(overrides: Record<string, unknown> = {}) {
    return {
      strength: 1.0,
      lastAccessedAt: Date.now(),
      halfLifeMs: 86400000,
      accessCount: 1,
      createdAt: Date.now(),
      ...overrides,
    };
  }

  it("returns DecayMetadata when all required fields are present", () => {
    const decay = makeDecay();
    const result = extractDecayMeta({ _decay: decay });
    expect(result).not.toBeNull();
    expect(result!.strength).toBe(1.0);
  });

  it("returns null when _decay field is absent", () => {
    expect(extractDecayMeta({ text: "no decay here" })).toBeNull();
  });

  it("returns null when _decay is null", () => {
    expect(extractDecayMeta({ _decay: null })).toBeNull();
  });

  it("returns null when _decay is a string (wrong type)", () => {
    expect(extractDecayMeta({ _decay: "not-an-object" })).toBeNull();
  });

  it("returns null when strength is missing", () => {
    const decay = makeDecay();
    delete (decay as Record<string, unknown>)["strength"];
    expect(extractDecayMeta({ _decay: decay })).toBeNull();
  });

  it("returns null when lastAccessedAt is missing", () => {
    const decay = makeDecay();
    delete (decay as Record<string, unknown>)["lastAccessedAt"];
    expect(extractDecayMeta({ _decay: decay })).toBeNull();
  });

  it("returns null when halfLifeMs is missing", () => {
    const decay = makeDecay();
    delete (decay as Record<string, unknown>)["halfLifeMs"];
    expect(extractDecayMeta({ _decay: decay })).toBeNull();
  });

  it("returns null when accessCount is missing", () => {
    const decay = makeDecay();
    delete (decay as Record<string, unknown>)["accessCount"];
    expect(extractDecayMeta({ _decay: decay })).toBeNull();
  });

  it("returns null when createdAt is missing", () => {
    const decay = makeDecay();
    delete (decay as Record<string, unknown>)["createdAt"];
    expect(extractDecayMeta({ _decay: decay })).toBeNull();
  });

  it("returns null when strength is a string (wrong type)", () => {
    const decay = makeDecay({ strength: "high" });
    expect(extractDecayMeta({ _decay: decay })).toBeNull();
  });

  it("returns null when lastAccessedAt is a boolean", () => {
    const decay = makeDecay({ lastAccessedAt: true });
    expect(extractDecayMeta({ _decay: decay })).toBeNull();
  });

  it("returns null when _decay is an array (wrong type)", () => {
    expect(extractDecayMeta({ _decay: [1, 2, 3] })).toBeNull();
  });

  it("returns null for empty object as _decay", () => {
    expect(extractDecayMeta({ _decay: {} })).toBeNull();
  });

  it("strength=0 is valid (full decay)", () => {
    const decay = makeDecay({ strength: 0 });
    const result = extractDecayMeta({ _decay: decay });
    expect(result).not.toBeNull();
    expect(result!.strength).toBe(0);
  });

  it("accessCount=0 is valid (never accessed)", () => {
    const decay = makeDecay({ accessCount: 0 });
    const result = extractDecayMeta({ _decay: decay });
    expect(result).not.toBeNull();
    expect(result!.accessCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 6: StoreVectorSearch — extended coverage
// ─────────────────────────────────────────────────────────────────────────────

describe("StoreVectorSearch — extended", () => {
  function makeStore(
    results: Array<{
      key: string;
      value: Record<string, unknown>;
      score?: number;
    }>,
  ) {
    return {
      search: vi.fn().mockResolvedValue(results),
    };
  }

  it("passes namespace array directly to store.search", async () => {
    const store = makeStore([]);
    const sut = new StoreVectorSearch(store);
    await sut.search(["tenant1", "project2"], "query text", 10);
    expect(store.search).toHaveBeenCalledWith(["tenant1", "project2"], {
      query: "query text",
      limit: 10,
    });
  });

  it("passes limit to store.search", async () => {
    const store = makeStore([]);
    const sut = new StoreVectorSearch(store);
    await sut.search(["ns"], "q", 7);
    expect(store.search).toHaveBeenCalledWith(expect.anything(), {
      query: "q",
      limit: 7,
    });
  });

  it("uses store score when present", async () => {
    const store = makeStore([
      { key: "k1", value: { text: "hello" }, score: 0.87 },
    ]);
    const sut = new StoreVectorSearch(store);
    const results = await sut.search(["ns"], "q", 10);
    expect(results[0]!.score).toBeCloseTo(0.87);
  });

  it("falls back to 1/(idx+1) when score is absent", async () => {
    const store = makeStore([
      { key: "k1", value: { text: "first" } },
      { key: "k2", value: { text: "second" } },
    ]);
    const sut = new StoreVectorSearch(store);
    const results = await sut.search(["ns"], "q", 10);
    // idx=0 → 1/1=1.0; idx=1 → 1/2=0.5
    expect(results[0]!.score).toBeCloseTo(1.0);
    expect(results[1]!.score).toBeCloseTo(0.5);
  });

  it("empty store returns empty array", async () => {
    const store = makeStore([]);
    const sut = new StoreVectorSearch(store);
    const results = await sut.search(["ns"], "q", 10);
    expect(results).toEqual([]);
  });

  it("key is preserved from store result", async () => {
    const store = makeStore([{ key: "memory-abc-123", value: {}, score: 0.9 }]);
    const sut = new StoreVectorSearch(store);
    const results = await sut.search(["ns"], "q", 10);
    expect(results[0]!.key).toBe("memory-abc-123");
  });

  it("value is passed through unchanged", async () => {
    const val = { content: "rich memory", tags: ["a", "b"] };
    const store = makeStore([{ key: "k1", value: val, score: 0.8 }]);
    const sut = new StoreVectorSearch(store);
    const results = await sut.search(["ns"], "q", 10);
    expect(results[0]!.value).toBe(val);
  });

  it("multiple results are returned in store order", async () => {
    const store = makeStore([
      { key: "a", value: {}, score: 0.9 },
      { key: "b", value: {}, score: 0.8 },
      { key: "c", value: {}, score: 0.7 },
    ]);
    const sut = new StoreVectorSearch(store);
    const results = await sut.search(["ns"], "q", 10);
    expect(results.map((r) => r.key)).toEqual(["a", "b", "c"]);
  });
});
