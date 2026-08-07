/**
 * Tests for the in-process embedding provider (SHARED-KIT-SEC-M-36 support).
 *
 * The load-bearing property is negative: this provider must never touch the
 * network. It is the only thing an `auto`-style convenience path can safely
 * resolve to without an explicit egress opt-in, so a regression that made it
 * call out would silently reopen the finding.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createLocalEmbedding,
  isLocalEmbedding,
  LOCAL_EMBEDDING_DEFAULT_DIMENSIONS,
  LOCAL_EMBEDDING_MODEL_ID,
} from "../embeddings/local-embedding.js";
import { InMemoryVectorStore } from "../in-memory-vector-store.js";
import { SemanticStore } from "../semantic-store.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createLocalEmbedding", () => {
  it("never calls fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const embedding = createLocalEmbedding();
    await embedding.embed(["hello world", "second document"]);
    await embedding.embedQuery("hello");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a stable model id and default dimensions", async () => {
    const embedding = createLocalEmbedding();
    expect(embedding.modelId).toBe(LOCAL_EMBEDDING_MODEL_ID);
    expect(embedding.dimensions).toBe(LOCAL_EMBEDDING_DEFAULT_DIMENSIONS);
    expect(isLocalEmbedding(embedding)).toBe(true);
    expect((await embedding.embedQuery("x")).length).toBe(
      LOCAL_EMBEDDING_DEFAULT_DIMENSIONS,
    );
  });

  it("honours a custom dimension and rejects an invalid one", async () => {
    const embedding = createLocalEmbedding({ dimensions: 16 });
    expect((await embedding.embedQuery("abc")).length).toBe(16);
    expect(() => createLocalEmbedding({ dimensions: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => createLocalEmbedding({ dimensions: 2.5 })).toThrow(
      /positive integer/,
    );
  });

  it("is deterministic across instances", async () => {
    const a = await createLocalEmbedding().embedQuery("retry budget is three");
    const b = await createLocalEmbedding().embedQuery("retry budget is three");
    expect(a).toEqual(b);
  });

  it("produces L2-normalized vectors for non-empty text", async () => {
    const vec = await createLocalEmbedding().embedQuery("alpha beta gamma");
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it("returns a zero vector for text with no tokens instead of NaN", async () => {
    const vec = await createLocalEmbedding({ dimensions: 8 }).embedQuery("   ...  ");
    expect(vec).toEqual(new Array(8).fill(0));
    expect(vec.some((v) => Number.isNaN(v))).toBe(false);
  });

  it("separates unrelated texts — not a constant-vector stub", async () => {
    const embedding = createLocalEmbedding();
    const [a, b] = await embedding.embed([
      "the retry budget is three attempts",
      "quantum entanglement of distant particles",
    ]);
    expect(a).not.toEqual(b);
  });

  it("ranks lexically overlapping documents above unrelated ones", async () => {
    // The point of a real (if shallow) signal: a constant stub would tie.
    const store = new SemanticStore({
      embedding: createLocalEmbedding(),
      vectorStore: new InMemoryVectorStore(),
    });
    await store.ensureCollection("docs");
    await store.upsert("docs", [
      { id: "1", text: "the retry budget is three attempts" },
      { id: "2", text: "bananas ripen faster in a paper bag" },
    ]);

    const results = await store.search("docs", "retry budget", 2);
    expect(results[0]?.id).toBe("1");
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });
});
