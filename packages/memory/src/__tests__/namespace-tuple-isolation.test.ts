/**
 * Regression tests for the memory storage tuple.
 *
 * SHARED-KIT-AGENT-C-02: `buildNamespaceTuple` omitted the namespace name, so
 * two namespaces declared with the same `scopeKeys` — the common case,
 * `["tenantId"]` — shared one storage tuple and identical keys silently
 * destroyed each other across namespace boundaries.
 *
 * SHARED-KIT-AGENT-C-01 (write side): vector doc ids were the bare store key
 * inside a per-namespace collection, so one tenant's write overwrote another's
 * document under the same key.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "@langchain/langgraph";
import { MemoryService } from "../memory-service.js";
import {
  buildNamespaceTuple,
  buildVectorDocId,
  buildVectorMetadata,
  VECTOR_KEY_META_KEY,
  VECTOR_NAMESPACE_META_KEY,
} from "../memory-service-store.js";
import { buildVectorScopeFilter } from "../memory-service-search.js";
import type { NamespaceConfig, SemanticStoreAdapter } from "../memory-types.js";

const FACTS: NamespaceConfig = {
  name: "facts",
  scopeKeys: ["tenantId"],
  searchable: true,
};
const PREFS: NamespaceConfig = {
  name: "prefs",
  scopeKeys: ["tenantId"],
  searchable: true,
};

function recordingSemanticStore(): SemanticStoreAdapter & {
  search: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  ensureCollection: ReturnType<typeof vi.fn>;
} {
  return {
    search: vi.fn(async () => []),
    upsert: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    ensureCollection: vi.fn(async () => undefined),
  };
}

describe("buildNamespaceTuple", () => {
  it("puts the namespace name first so same-scopeKeys namespaces cannot collide", () => {
    expect(buildNamespaceTuple(FACTS, { tenantId: "t1" })).toEqual([
      "facts",
      "t1",
    ]);
    expect(buildNamespaceTuple(PREFS, { tenantId: "t1" })).toEqual([
      "prefs",
      "t1",
    ]);
  });

  it("still rejects a missing scope key", () => {
    expect(() => buildNamespaceTuple(FACTS, {})).toThrow(
      /Missing scope key "tenantId" for namespace "facts"/,
    );
  });
});

describe("namespace collision (C-02)", () => {
  it("keeps the same key alive in two namespaces sharing one scopeKeys list", async () => {
    const svc = new MemoryService(new InMemoryStore(), [FACTS, PREFS]);
    const scope = { tenantId: "t1" };

    await svc.put("facts", scope, "k1", { text: "fact one" });
    await svc.put("prefs", scope, "k1", { text: "pref one" });

    const facts = await svc.get("facts", scope);
    const prefs = await svc.get("prefs", scope);

    expect(facts).toHaveLength(1);
    expect(prefs).toHaveLength(1);
    expect(facts[0]?.["text"]).toBe("fact one");
    expect(prefs[0]?.["text"]).toBe("pref one");
  });

  it("keeps tenants separated within one namespace", async () => {
    const svc = new MemoryService(new InMemoryStore(), [FACTS]);
    await svc.put("facts", { tenantId: "a" }, "k1", { text: "tenant a" });
    await svc.put("facts", { tenantId: "b" }, "k1", { text: "tenant b" });

    expect(await svc.get("facts", { tenantId: "a" })).toEqual([
      expect.objectContaining({ text: "tenant a" }),
    ]);
    expect(await svc.get("facts", { tenantId: "b" })).toEqual([
      expect.objectContaining({ text: "tenant b" }),
    ]);
  });
});

describe("vector document identity (C-01 write side)", () => {
  it("qualifies the doc id with the namespace and scope", () => {
    expect(buildVectorDocId(FACTS, { tenantId: "t1" }, "k1")).toBe(
      "facts/t1/k1",
    );
    expect(buildVectorDocId(FACTS, { tenantId: "t2" }, "k1")).toBe(
      "facts/t2/k1",
    );
    expect(buildVectorDocId(PREFS, { tenantId: "t1" }, "k1")).toBe(
      "prefs/t1/k1",
    );
  });

  it("stamps the namespace under a key a caller scope cannot shadow", () => {
    // memory-kit's own `tenantScope()` produces a scope with a `namespace`
    // key; it must not overwrite the indexing marker.
    const meta = buildVectorMetadata(
      FACTS,
      { tenantId: "t1", namespace: "caller-supplied" },
      "k1",
    );
    expect(meta[VECTOR_NAMESPACE_META_KEY]).toBe("facts");
    expect(meta[VECTOR_KEY_META_KEY]).toBe("k1");
    expect(meta["namespace"]).toBe("caller-supplied");
  });

  it("writes distinct vector ids for the same key in two tenants", async () => {
    const semanticStore = recordingSemanticStore();
    const svc = new MemoryService(new InMemoryStore(), [FACTS], {
      semanticStore,
    });

    await svc.put("facts", { tenantId: "a" }, "k1", { text: "tenant a" });
    await svc.put("facts", { tenantId: "b" }, "k1", { text: "tenant b" });

    const ids = semanticStore.upsert.mock.calls.map(
      (call) => (call[1] as Array<{ id: string }>)[0]?.id,
    );
    expect(new Set(ids).size).toBe(2);
  });
});

describe("vector collection lifecycle (H-17)", () => {
  it("ensures the collection before the first upsert", async () => {
    const semanticStore = recordingSemanticStore();
    const svc = new MemoryService(new InMemoryStore(), [FACTS], {
      semanticStore,
    });

    await svc.put("facts", { tenantId: "t1" }, "k1", { text: "one" });

    expect(semanticStore.ensureCollection).toHaveBeenCalledWith("memory_facts");
    expect(
      semanticStore.ensureCollection.mock.invocationCallOrder[0]!,
    ).toBeLessThan(semanticStore.upsert.mock.invocationCallOrder[0]!);
  });

  it("ensures each collection only once per service instance", async () => {
    const semanticStore = recordingSemanticStore();
    const svc = new MemoryService(new InMemoryStore(), [FACTS], {
      semanticStore,
    });

    await svc.put("facts", { tenantId: "t1" }, "k1", { text: "one" });
    await svc.put("facts", { tenantId: "t1" }, "k2", { text: "two" });
    await svc.put("facts", { tenantId: "t2" }, "k3", { text: "three" });

    expect(semanticStore.ensureCollection).toHaveBeenCalledTimes(1);
    expect(semanticStore.upsert).toHaveBeenCalledTimes(3);
  });
});

describe("buildVectorScopeFilter (C-01 read side)", () => {
  it("binds the vector channel to the namespace and every declared scope key", () => {
    const ns: NamespaceConfig = {
      name: "notes",
      scopeKeys: ["tenantId", "projectId"],
      searchable: true,
    };
    expect(buildVectorScopeFilter(ns, { tenantId: "t1", projectId: "p1" })).toEqual(
      {
        and: [
          { field: VECTOR_NAMESPACE_META_KEY, op: "eq", value: "notes" },
          { field: "tenantId", op: "eq", value: "t1" },
          { field: "projectId", op: "eq", value: "p1" },
        ],
      },
    );
  });

  it("passes the scope filter into the adapter search call", async () => {
    const semanticStore = recordingSemanticStore();
    const svc = new MemoryService(new InMemoryStore(), [FACTS], {
      semanticStore,
    });
    await svc.put("facts", { tenantId: "t1" }, "k1", { text: "one" });
    await svc.search("facts", { tenantId: "t1" }, "one");

    expect(semanticStore.search).toHaveBeenCalledWith(
      "memory_facts",
      "one",
      expect.any(Number),
      {
        and: [
          { field: VECTOR_NAMESPACE_META_KEY, op: "eq", value: "facts" },
          { field: "tenantId", op: "eq", value: "t1" },
        ],
      },
    );
  });

  it("strips the internal indexing markers from a vector-only hit", async () => {
    const semanticStore = recordingSemanticStore();
    semanticStore.search.mockResolvedValue([
      {
        id: "facts/t1/vec-1",
        text: "vector-only recollection",
        score: 0.9,
        metadata: {
          tenantId: "t1",
          [VECTOR_NAMESPACE_META_KEY]: "facts",
          [VECTOR_KEY_META_KEY]: "vec-1",
        },
      },
    ]);
    const svc = new MemoryService(new InMemoryStore(), [FACTS], {
      semanticStore,
    });

    const results = await svc.search("facts", { tenantId: "t1" }, "anything");
    expect(results).toEqual([
      { text: "vector-only recollection", tenantId: "t1" },
    ]);
  });
});
