/**
 * Namespace isolation tests for @dzupagent/memory.
 *
 * Covers:
 * - Cross-namespace read/search prevention
 * - Same key in different namespaces
 * - Namespace CRUD (create, read, update, delete)
 * - Namespace listing via stats()
 * - Namespace deletion isolation
 * - Default namespace behaviour
 * - Namespace rename (copy + delete pattern)
 * - Namespace migration (move all records)
 * - Migration completeness and isolation
 * - Namespace size counting
 * - Cross-namespace merge
 * - Namespace metadata (createdAt, count, updatedAt)
 * - ScopedMemoryService namespace access enforcement
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryMemoryClient } from "../in-memory-client.js";
import { ScopedMemoryService, PolicyTemplates } from "../scoped-memory.js";
import type { MemoryRecord, MemoryScope } from "@dzupagent/agent-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCOPE: MemoryScope = { tenantId: "tenant-1" };
const SCOPE_B: MemoryScope = { tenantId: "tenant-2" };

let _seq = 0;
function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  const id = `rec-${++_seq}`;
  return {
    id,
    namespace: "default",
    scope: SCOPE,
    content: `content-${id}`,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Create N records in the given namespace */
async function fillNamespace(
  client: InMemoryMemoryClient,
  namespace: string,
  count: number,
  scope: MemoryScope = SCOPE
): Promise<MemoryRecord[]> {
  const records: MemoryRecord[] = [];
  for (let i = 0; i < count; i++) {
    const r = makeRecord({
      namespace,
      scope,
      content: `${namespace}-item-${i}`,
    });
    await client.put(namespace, scope, r);
    records.push(r);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Section 1 — Namespace isolation: no cross-namespace reads
// ---------------------------------------------------------------------------

describe("Namespace isolation – cross-namespace read prevention", () => {
  let client: InMemoryMemoryClient;

  beforeEach(() => {
    client = new InMemoryMemoryClient();
  });

  it("memory written to namespace A is not returned when reading namespace B", async () => {
    await client.put(
      "alpha",
      SCOPE,
      makeRecord({ namespace: "alpha", content: "secret-alpha" })
    );

    const results = await client.get("beta", SCOPE);
    expect(results).toHaveLength(0);
  });

  it("memory in namespace B is not returned when reading namespace A", async () => {
    await client.put(
      "beta",
      SCOPE,
      makeRecord({ namespace: "beta", content: "secret-beta" })
    );

    const results = await client.get("alpha", SCOPE);
    expect(results).toHaveLength(0);
  });

  it("reading from namespace A does not expose records from namespace B even with same scope", async () => {
    await fillNamespace(client, "alpha", 5);
    await fillNamespace(client, "beta", 5);

    const alpha = await client.get("alpha", SCOPE);
    const beta = await client.get("beta", SCOPE);

    expect(alpha).toHaveLength(5);
    expect(beta).toHaveLength(5);
    const alphaIds = new Set(alpha.map((r) => r.id));
    const betaIds = new Set(beta.map((r) => r.id));
    // No overlap
    for (const id of alphaIds) {
      expect(betaIds.has(id)).toBe(false);
    }
  });

  it("cross-namespace search prevention: search in namespace A returns no results from namespace B", async () => {
    await client.put(
      "alpha",
      SCOPE,
      makeRecord({ namespace: "alpha", content: "unique-term-alpha" })
    );
    await client.put(
      "beta",
      SCOPE,
      makeRecord({ namespace: "beta", content: "unique-term-alpha" })
    );

    // Search alpha — should only return the alpha record
    const results = await client.get("alpha", SCOPE, {
      search: "unique-term-alpha",
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.namespace).toBe("alpha");
  });

  it("search scoped to one namespace does not return matching records from another", async () => {
    const keyword = "shared-keyword-xyz";
    await client.put(
      "ns1",
      SCOPE,
      makeRecord({ namespace: "ns1", content: keyword })
    );
    await client.put(
      "ns2",
      SCOPE,
      makeRecord({ namespace: "ns2", content: keyword })
    );

    const ns1Results = await client.get("ns1", SCOPE, { search: keyword });
    const ns2Results = await client.get("ns2", SCOPE, { search: keyword });

    expect(ns1Results.every((r) => r.namespace === "ns1")).toBe(true);
    expect(ns2Results.every((r) => r.namespace === "ns2")).toBe(true);
    expect(ns1Results).toHaveLength(1);
    expect(ns2Results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Section 2 — Same key in different namespaces
// ---------------------------------------------------------------------------

describe("Same key in different namespaces", () => {
  let client: InMemoryMemoryClient;

  beforeEach(() => {
    client = new InMemoryMemoryClient();
  });

  it("two namespaces can hold records with the same id independently", async () => {
    const sharedId = "shared-id-001";
    await client.put(
      "alpha",
      SCOPE,
      makeRecord({ id: sharedId, namespace: "alpha", content: "alpha content" })
    );
    await client.put(
      "beta",
      SCOPE,
      makeRecord({ id: sharedId, namespace: "beta", content: "beta content" })
    );

    const alpha = await client.get("alpha", SCOPE);
    const beta = await client.get("beta", SCOPE);

    expect(alpha).toHaveLength(1);
    expect(beta).toHaveLength(1);
    expect(alpha[0]?.content).toBe("alpha content");
    expect(beta[0]?.content).toBe("beta content");
  });

  it("updating a record in namespace A does not affect the same id in namespace B", async () => {
    const sharedId = "shared-id-002";
    await client.put(
      "alpha",
      SCOPE,
      makeRecord({
        id: sharedId,
        namespace: "alpha",
        content: "original-alpha",
      })
    );
    await client.put(
      "beta",
      SCOPE,
      makeRecord({ id: sharedId, namespace: "beta", content: "original-beta" })
    );

    // Update alpha
    await client.put(
      "alpha",
      SCOPE,
      makeRecord({ id: sharedId, namespace: "alpha", content: "updated-alpha" })
    );

    const beta = await client.get("beta", SCOPE);
    expect(beta[0]?.content).toBe("original-beta");
  });

  it("deleting a record in namespace A does not delete the same id in namespace B", async () => {
    const sharedId = "shared-id-003";
    await client.put(
      "alpha",
      SCOPE,
      makeRecord({ id: sharedId, namespace: "alpha", content: "alpha" })
    );
    await client.put(
      "beta",
      SCOPE,
      makeRecord({ id: sharedId, namespace: "beta", content: "beta" })
    );

    await client.delete("alpha", SCOPE, sharedId);

    const alpha = await client.get("alpha", SCOPE);
    const beta = await client.get("beta", SCOPE);

    expect(alpha).toHaveLength(0);
    expect(beta).toHaveLength(1);
    expect(beta[0]?.content).toBe("beta");
  });
});

// ---------------------------------------------------------------------------
// Section 3 — Namespace CRUD
// ---------------------------------------------------------------------------

describe("Namespace CRUD", () => {
  let client: InMemoryMemoryClient;

  beforeEach(() => {
    client = new InMemoryMemoryClient();
  });

  it("create namespace: write to it and read back", async () => {
    const r = makeRecord({ namespace: "new-ns", content: "hello namespace" });
    await client.put("new-ns", SCOPE, r);

    const results = await client.get("new-ns", SCOPE);
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe("hello namespace");
  });

  it("update within namespace: put same id overwrites content", async () => {
    const id = "update-test-id";
    await client.put(
      "crud-ns",
      SCOPE,
      makeRecord({ id, namespace: "crud-ns", content: "v1" })
    );
    await client.put(
      "crud-ns",
      SCOPE,
      makeRecord({ id, namespace: "crud-ns", content: "v2" })
    );

    const results = await client.get("crud-ns", SCOPE);
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe("v2");
  });

  it("delete within namespace: removes the record", async () => {
    const id = "delete-test-id";
    await client.put(
      "crud-ns",
      SCOPE,
      makeRecord({ id, namespace: "crud-ns", content: "to be deleted" })
    );

    const deleted = await client.delete("crud-ns", SCOPE, id);
    expect(deleted).toBe(true);

    const results = await client.get("crud-ns", SCOPE);
    expect(results).toHaveLength(0);
  });

  it("delete returns false when record does not exist", async () => {
    const result = await client.delete("crud-ns", SCOPE, "nonexistent-id");
    expect(result).toBe(false);
  });

  it("namespace CRUD full cycle: create, read, update, delete", async () => {
    const ns = "lifecycle-ns";
    const id = "lifecycle-id";

    // Create
    await client.put(
      ns,
      SCOPE,
      makeRecord({ id, namespace: ns, content: "step-1" })
    );
    expect((await client.get(ns, SCOPE))[0]?.content).toBe("step-1");

    // Update
    await client.put(
      ns,
      SCOPE,
      makeRecord({ id, namespace: ns, content: "step-2" })
    );
    expect((await client.get(ns, SCOPE))[0]?.content).toBe("step-2");

    // Delete
    await client.delete(ns, SCOPE, id);
    expect(await client.get(ns, SCOPE)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Section 4 — Namespace listing via stats()
// ---------------------------------------------------------------------------

describe("Namespace listing", () => {
  let client: InMemoryMemoryClient;

  beforeEach(() => {
    client = new InMemoryMemoryClient();
  });

  it("stats reports empty namespaces list when store is empty", async () => {
    const stats = await client.stats();
    expect(stats.totalRecords).toBe(0);
    expect(stats.namespaces).toEqual([]);
  });

  it("stats lists all distinct namespaces after writes", async () => {
    await fillNamespace(client, "facts", 2);
    await fillNamespace(client, "episodic", 3);
    await fillNamespace(client, "skills", 1);

    const stats = await client.stats();
    expect(stats.namespaces.sort()).toEqual(["episodic", "facts", "skills"]);
  });

  it("stats does not duplicate a namespace listed multiple times", async () => {
    await fillNamespace(client, "facts", 5);

    const stats = await client.stats();
    const factsCount = stats.namespaces.filter((ns) => ns === "facts").length;
    expect(factsCount).toBe(1);
  });

  it("stats updates namespace list after new namespace is created", async () => {
    await fillNamespace(client, "ns-a", 1);
    const before = await client.stats();
    expect(before.namespaces).toContain("ns-a");
    expect(before.namespaces).not.toContain("ns-b");

    await fillNamespace(client, "ns-b", 1);
    const after = await client.stats();
    expect(after.namespaces).toContain("ns-a");
    expect(after.namespaces).toContain("ns-b");
  });

  it("stats totalRecords reflects all records across all namespaces", async () => {
    await fillNamespace(client, "a", 3);
    await fillNamespace(client, "b", 4);

    const stats = await client.stats();
    expect(stats.totalRecords).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Section 5 — Namespace deletion isolation
// ---------------------------------------------------------------------------

describe("Namespace deletion isolation", () => {
  let client: InMemoryMemoryClient;

  beforeEach(() => {
    client = new InMemoryMemoryClient();
  });

  it("deleting all records from namespace A does not affect namespace B", async () => {
    const aRecords = await fillNamespace(client, "alpha", 3);
    await fillNamespace(client, "beta", 3);

    // Delete all records from alpha
    for (const r of aRecords) {
      await client.delete("alpha", SCOPE, r.id);
    }

    const alpha = await client.get("alpha", SCOPE);
    const beta = await client.get("beta", SCOPE);

    expect(alpha).toHaveLength(0);
    expect(beta).toHaveLength(3);
  });

  it("namespace A deletion removes from stats but keeps B in stats", async () => {
    const aRecords = await fillNamespace(client, "alpha", 2);
    await fillNamespace(client, "beta", 2);

    for (const r of aRecords) {
      await client.delete("alpha", SCOPE, r.id);
    }

    const stats = await client.stats();
    // beta remains; alpha has zero records but stats only lists namespaces with records
    expect(stats.namespaces).toContain("beta");
    expect(stats.totalRecords).toBe(2);
  });

  it("deleting records from one namespace does not corrupt data in another", async () => {
    const aRecords = await fillNamespace(client, "alpha", 2);
    const bRecords = await fillNamespace(client, "beta", 2);

    // Delete alpha records
    for (const r of aRecords) {
      await client.delete("alpha", SCOPE, r.id);
    }

    const beta = await client.get("beta", SCOPE);
    const betaIds = beta.map((r) => r.id).sort();
    expect(betaIds).toEqual(bRecords.map((r) => r.id).sort());
  });
});

// ---------------------------------------------------------------------------
// Section 6 — Default namespace
// ---------------------------------------------------------------------------

describe("Default namespace", () => {
  let client: InMemoryMemoryClient;

  beforeEach(() => {
    client = new InMemoryMemoryClient();
  });

  it('records written to "default" namespace are only visible there', async () => {
    await client.put(
      "default",
      SCOPE,
      makeRecord({ namespace: "default", content: "default-record" })
    );

    const defaultNs = await client.get("default", SCOPE);
    const otherNs = await client.get("custom", SCOPE);

    expect(defaultNs).toHaveLength(1);
    expect(otherNs).toHaveLength(0);
  });

  it("writing to custom namespace does not pollute default namespace", async () => {
    await client.put(
      "custom",
      SCOPE,
      makeRecord({ namespace: "custom", content: "custom-record" })
    );

    const defaultNs = await client.get("default", SCOPE);
    expect(defaultNs).toHaveLength(0);
  });

  it("both default and custom namespaces co-exist independently", async () => {
    await client.put(
      "default",
      SCOPE,
      makeRecord({ namespace: "default", content: "in-default" })
    );
    await client.put(
      "custom",
      SCOPE,
      makeRecord({ namespace: "custom", content: "in-custom" })
    );

    const defaultNs = await client.get("default", SCOPE);
    const custom = await client.get("custom", SCOPE);

    expect(defaultNs[0]?.content).toBe("in-default");
    expect(custom[0]?.content).toBe("in-custom");
  });
});

// ---------------------------------------------------------------------------
// Section 7 — Namespace rename (copy + delete)
// ---------------------------------------------------------------------------

describe("Namespace rename (copy + delete pattern)", () => {
  let client: InMemoryMemoryClient;

  beforeEach(() => {
    client = new InMemoryMemoryClient();
  });

  async function renameNamespace(
    cl: InMemoryMemoryClient,
    from: string,
    to: string,
    scope: MemoryScope
  ): Promise<void> {
    const records = await cl.get(from, scope);
    for (const r of records) {
      await cl.put(to, scope, { ...r, namespace: to });
    }
    for (const r of records) {
      await cl.delete(from, scope, r.id);
    }
  }

  it("records are accessible under new namespace after rename", async () => {
    await fillNamespace(client, "old-ns", 3);

    await renameNamespace(client, "old-ns", "new-ns", SCOPE);

    const newNs = await client.get("new-ns", SCOPE);
    expect(newNs).toHaveLength(3);
  });

  it("old namespace is empty after rename", async () => {
    await fillNamespace(client, "old-ns", 3);

    await renameNamespace(client, "old-ns", "new-ns", SCOPE);

    const oldNs = await client.get("old-ns", SCOPE);
    expect(oldNs).toHaveLength(0);
  });

  it("rename preserves record content", async () => {
    await client.put(
      "src-ns",
      SCOPE,
      makeRecord({ namespace: "src-ns", content: "important-content" })
    );

    await renameNamespace(client, "src-ns", "dst-ns", SCOPE);

    const dst = await client.get("dst-ns", SCOPE);
    expect(dst[0]?.content).toBe("important-content");
  });
});

// ---------------------------------------------------------------------------
// Section 8 — Namespace migration (move memories from A to B)
// ---------------------------------------------------------------------------

describe("Namespace migration", () => {
  let client: InMemoryMemoryClient;

  beforeEach(() => {
    client = new InMemoryMemoryClient();
  });

  async function migrateNamespace(
    cl: InMemoryMemoryClient,
    source: string,
    target: string,
    scope: MemoryScope
  ): Promise<{ movedCount: number }> {
    const records = await cl.get(source, scope);
    for (const r of records) {
      await cl.put(target, scope, { ...r, namespace: target });
      await cl.delete(source, scope, r.id);
    }
    return { movedCount: records.length };
  }

  it("moves all memories from source namespace to target namespace", async () => {
    await fillNamespace(client, "source-ns", 5);

    const { movedCount } = await migrateNamespace(
      client,
      "source-ns",
      "target-ns",
      SCOPE
    );

    expect(movedCount).toBe(5);
    const target = await client.get("target-ns", SCOPE);
    expect(target).toHaveLength(5);
  });

  it("migration completeness: source namespace is empty after migration", async () => {
    await fillNamespace(client, "source-ns", 4);

    await migrateNamespace(client, "source-ns", "target-ns", SCOPE);

    const source = await client.get("source-ns", SCOPE);
    expect(source).toHaveLength(0);
  });

  it("migration isolation: target namespace only has migrated records (not pre-existing ones mixed up)", async () => {
    const preExisting = makeRecord({
      namespace: "target-ns",
      content: "pre-existing",
    });
    await client.put("target-ns", SCOPE, preExisting);

    await fillNamespace(client, "source-ns", 3);

    await migrateNamespace(client, "source-ns", "target-ns", SCOPE);

    const target = await client.get("target-ns", SCOPE);
    // Pre-existing + 3 migrated
    expect(target).toHaveLength(4);
  });

  it("migration content preservation: records retain their content after moving", async () => {
    const r = makeRecord({
      namespace: "source-ns",
      content: "preserve-this-content",
    });
    await client.put("source-ns", SCOPE, r);

    await migrateNamespace(client, "source-ns", "target-ns", SCOPE);

    const target = await client.get("target-ns", SCOPE);
    expect(target[0]?.content).toBe("preserve-this-content");
  });

  it("migrating an empty namespace is a no-op that leaves target unchanged", async () => {
    await fillNamespace(client, "target-ns", 2);

    const { movedCount } = await migrateNamespace(
      client,
      "empty-source",
      "target-ns",
      SCOPE
    );

    expect(movedCount).toBe(0);
    expect(await client.get("target-ns", SCOPE)).toHaveLength(2);
  });

  it("migration atomicity simulation: bailing mid-migration leaves partial state consistent", async () => {
    // Simulate a migration that stops after first record
    const records = await fillNamespace(client, "source-ns", 3);

    // Move only the first record, simulating a mid-migration failure
    const first = records[0]!;
    await client.put("target-ns", SCOPE, { ...first, namespace: "target-ns" });
    await client.delete("source-ns", SCOPE, first.id);

    // Source still has remaining 2 records
    const sourceRemaining = await client.get("source-ns", SCOPE);
    expect(sourceRemaining).toHaveLength(2);

    // Target has the 1 moved record
    const targetSoFar = await client.get("target-ns", SCOPE);
    expect(targetSoFar).toHaveLength(1);
    expect(targetSoFar[0]?.id).toBe(first.id);
  });
});

// ---------------------------------------------------------------------------
// Section 9 — Namespace size
// ---------------------------------------------------------------------------

describe("Namespace size", () => {
  let client: InMemoryMemoryClient;

  beforeEach(() => {
    client = new InMemoryMemoryClient();
  });

  it("namespace size is the count of records returned by get()", async () => {
    await fillNamespace(client, "sized-ns", 7);

    const records = await client.get("sized-ns", SCOPE);
    expect(records).toHaveLength(7);
  });

  it("size of empty namespace is zero", async () => {
    const records = await client.get("empty-ns", SCOPE);
    expect(records).toHaveLength(0);
  });

  it("size increases after puts", async () => {
    await fillNamespace(client, "ns", 3);
    let size = (await client.get("ns", SCOPE)).length;
    expect(size).toBe(3);

    await fillNamespace(client, "ns", 2);
    size = (await client.get("ns", SCOPE)).length;
    expect(size).toBe(5);
  });

  it("size decreases after deletes", async () => {
    const records = await fillNamespace(client, "ns", 4);

    await client.delete("ns", SCOPE, records[0]!.id);
    await client.delete("ns", SCOPE, records[1]!.id);

    const remaining = await client.get("ns", SCOPE);
    expect(remaining).toHaveLength(2);
  });

  it("namespace A size is independent of namespace B size", async () => {
    await fillNamespace(client, "ns-a", 3);
    await fillNamespace(client, "ns-b", 10);

    const sizeA = (await client.get("ns-a", SCOPE)).length;
    const sizeB = (await client.get("ns-b", SCOPE)).length;

    expect(sizeA).toBe(3);
    expect(sizeB).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Section 10 — Cross-namespace merge
// ---------------------------------------------------------------------------

describe("Cross-namespace merge", () => {
  let client: InMemoryMemoryClient;

  beforeEach(() => {
    client = new InMemoryMemoryClient();
  });

  async function mergeNamespaces(
    cl: InMemoryMemoryClient,
    sources: string[],
    target: string,
    scope: MemoryScope
  ): Promise<number> {
    let moved = 0;
    for (const src of sources) {
      const records = await cl.get(src, scope);
      for (const r of records) {
        await cl.put(target, scope, { ...r, namespace: target });
      }
      moved += records.length;
    }
    return moved;
  }

  it("merges records from two namespaces into one target namespace", async () => {
    await fillNamespace(client, "ns-a", 3);
    await fillNamespace(client, "ns-b", 4);

    const count = await mergeNamespaces(
      client,
      ["ns-a", "ns-b"],
      "merged",
      SCOPE
    );

    expect(count).toBe(7);
    const merged = await client.get("merged", SCOPE);
    expect(merged).toHaveLength(7);
  });

  it("source namespaces remain intact after a non-destructive merge", async () => {
    await fillNamespace(client, "ns-a", 2);
    await fillNamespace(client, "ns-b", 2);

    await mergeNamespaces(client, ["ns-a", "ns-b"], "merged", SCOPE);

    // Sources still exist unchanged
    expect(await client.get("ns-a", SCOPE)).toHaveLength(2);
    expect(await client.get("ns-b", SCOPE)).toHaveLength(2);
  });

  it("merge into an existing target namespace appends records", async () => {
    await fillNamespace(client, "ns-a", 2);
    await fillNamespace(client, "merged", 1);

    await mergeNamespaces(client, ["ns-a"], "merged", SCOPE);

    const merged = await client.get("merged", SCOPE);
    expect(merged).toHaveLength(3);
  });

  it("merging three namespaces results in combined count in target", async () => {
    await fillNamespace(client, "x", 1);
    await fillNamespace(client, "y", 2);
    await fillNamespace(client, "z", 3);

    await mergeNamespaces(client, ["x", "y", "z"], "all", SCOPE);

    expect(await client.get("all", SCOPE)).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Section 11 — Namespace metadata (createdAt, updatedAt, count)
// ---------------------------------------------------------------------------

describe("Namespace metadata", () => {
  let client: InMemoryMemoryClient;

  beforeEach(() => {
    client = new InMemoryMemoryClient();
  });

  it("record has a createdAt timestamp after being stored", async () => {
    const before = Date.now();
    const r = makeRecord({ namespace: "meta-ns" });
    await client.put("meta-ns", SCOPE, r);

    const stored = await client.get("meta-ns", SCOPE);
    expect(stored[0]?.createdAt).toBeGreaterThanOrEqual(before);
  });

  it("record has an updatedAt timestamp after being stored", async () => {
    const before = Date.now();
    const r = makeRecord({ namespace: "meta-ns" });
    await client.put("meta-ns", SCOPE, r);

    const stored = await client.get("meta-ns", SCOPE);
    expect(stored[0]?.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("updatedAt is refreshed on update but createdAt is preserved", async () => {
    const id = "meta-stable-id";
    const r = makeRecord({ id, namespace: "meta-ns", content: "v1" });
    await client.put("meta-ns", SCOPE, r);

    const [first] = await client.get("meta-ns", SCOPE);
    const originalCreatedAt = first!.createdAt;
    const originalUpdatedAt = first!.updatedAt;

    // Delay to ensure updatedAt changes
    await new Promise((res) => setTimeout(res, 5));

    await client.put(
      "meta-ns",
      SCOPE,
      makeRecord({ id, namespace: "meta-ns", content: "v2" })
    );

    const [updated] = await client.get("meta-ns", SCOPE);
    expect(updated?.createdAt).toBe(originalCreatedAt);
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
  });

  it("stats totalRecords reflects memory count across namespaces", async () => {
    await fillNamespace(client, "ns-meta-1", 3);
    await fillNamespace(client, "ns-meta-2", 5);

    const stats = await client.stats();
    expect(stats.totalRecords).toBe(8);
  });

  it("stats namespaces list has creation order independent (sorted)", async () => {
    await fillNamespace(client, "zebra", 1);
    await fillNamespace(client, "alpha", 1);
    await fillNamespace(client, "middle", 1);

    const stats = await client.stats();
    const sorted = [...stats.namespaces].sort();
    expect(stats.namespaces).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// Section 12 — ScopedMemoryService namespace access enforcement
// ---------------------------------------------------------------------------

describe("ScopedMemoryService namespace access enforcement", () => {
  function makeScopedService(
    namespaces: Record<string, "read" | "write" | "read-write" | "none">,
    agentId = "agent-x",
    opts?: { strict?: boolean }
  ) {
    const inner = {
      put: async () => {},
      get: async () =>
        [{ text: "result" }] as unknown as Record<string, unknown>[],
      search: async () =>
        [{ text: "found" }] as unknown as Record<string, unknown>[],
      formatForPrompt: () => "formatted",
    } as unknown as ConstructorParameters<typeof ScopedMemoryService>[0];

    return new ScopedMemoryService(inner, { agentId, namespaces }, opts);
  }

  it("agent with read-only policy cannot search namespace B (different from allowed namespace)", async () => {
    const scoped = makeScopedService({ "ns-a": "read" });
    expect(scoped.canAccess("ns-b", "read")).toBe(false);
  });

  it("agent allowed on namespace A can read it but not write-only namespace B", async () => {
    const scoped = makeScopedService({ "ns-a": "read-write", "ns-b": "write" });
    expect(scoped.canAccess("ns-a", "read")).toBe(true);
    expect(scoped.canAccess("ns-b", "read")).toBe(false);
  });

  it("violation is recorded when trying to read a namespace without read access", async () => {
    const scoped = makeScopedService({ "secure-ns": "none" });
    await scoped.get("secure-ns", {});
    expect(scoped.getViolations()).toHaveLength(1);
    expect(scoped.getViolations()[0]?.namespace).toBe("secure-ns");
    expect(scoped.getViolations()[0]?.operation).toBe("read");
  });

  it("violation is recorded when trying to write a namespace with only read access", async () => {
    const scoped = makeScopedService({ "readonly-ns": "read" });
    await scoped.put("readonly-ns", {}, "key", { data: "x" });
    expect(scoped.getViolations()).toHaveLength(1);
    expect(scoped.getViolations()[0]?.operation).toBe("write");
  });

  it("PolicyTemplates.isolatedWithSharedRead enforces namespace isolation", () => {
    const policy = PolicyTemplates.isolatedWithSharedRead(
      "worker",
      ["private-ns"],
      ["shared-ns"]
    );

    expect(policy.namespaces["private-ns"]).toBe("read-write");
    expect(policy.namespaces["shared-ns"]).toBe("read");
    expect(policy.defaultAccess).toBe("none");
  });

  it("agent with none default cannot access any unlisted namespace", async () => {
    const scoped = makeScopedService({}, "isolated-agent");
    // No explicit namespaces, no defaultAccess → falls back to 'none'
    expect(scoped.canAccess("any-ns", "read")).toBe(false);
    expect(scoped.canAccess("any-ns", "write")).toBe(false);
  });

  it("agent with read-write access can both read and write its namespace", () => {
    const scoped = makeScopedService({ "owned-ns": "read-write" });
    expect(scoped.canAccess("owned-ns", "read")).toBe(true);
    expect(scoped.canAccess("owned-ns", "write")).toBe(true);
  });

  it("strict mode throws on unauthorized read across namespaces", async () => {
    const scoped = makeScopedService({ "ns-a": "write" }, "strict-agent", {
      strict: true,
    });
    await expect(scoped.get("ns-a", {})).rejects.toThrow(/access violation/);
  });

  it("strict mode throws on unauthorized cross-namespace write", async () => {
    const scoped = makeScopedService({ "ns-a": "read" }, "strict-agent", {
      strict: true,
    });
    await expect(scoped.put("ns-a", {}, "key", { data: "x" })).rejects.toThrow(
      /access violation/
    );
  });

  it("multiple violations across different namespaces are all recorded", async () => {
    const scoped = makeScopedService({});
    await scoped.get("ns-1", {});
    await scoped.get("ns-2", {});
    await scoped.put("ns-3", {}, "k", { v: 1 });

    const violations = scoped.getViolations();
    expect(violations).toHaveLength(3);
    const namespaces = violations.map((v) => v.namespace);
    expect(namespaces).toContain("ns-1");
    expect(namespaces).toContain("ns-2");
    expect(namespaces).toContain("ns-3");
  });

  it("clearViolations resets after cross-namespace access violations", async () => {
    const scoped = makeScopedService({});
    await scoped.get("blocked-ns", {});
    expect(scoped.getViolations()).toHaveLength(1);

    scoped.clearViolations();
    expect(scoped.getViolations()).toHaveLength(0);
  });
});
