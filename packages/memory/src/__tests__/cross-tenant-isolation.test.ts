/**
 * Cross-tenant isolation tests for @dzupagent/memory
 *
 * Covers:
 *  - Namespace boundaries: tenant A writes not visible to tenant B
 *  - Read isolation: tenant B cannot read tenant A entries by id or search
 *  - Write isolation: tenant B cannot overwrite or delete tenant A entries
 *  - ACL enforcement: ScopedMemoryService policy enforcement between tenants
 *  - Concurrent access: simultaneous writes from two tenants do not interleave data
 *  - Namespace enumeration: tenant cannot list namespaces belonging to other tenants
 *  - Wildcard isolation: wildcard queries scoped to requesting tenant only
 *  - Cross-tenant share: explicit sharing grants access to specific other tenant
 *  - Edge cases: same key in different tenant namespaces, empty tenantId, tenant with no entries
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TenantScopedStore } from "../tenant-scoped-store.js";
import {
  ScopedMemoryService,
  createAgentMemories,
  PolicyTemplates,
} from "../scoped-memory.js";
import { SharedMemoryNamespace } from "../shared-namespace.js";
import { InMemoryMemoryClient } from "../in-memory-client.js";
import type { BaseStore } from "@langchain/langgraph";
import type { MemoryStoreCapabilities } from "../store-capabilities.js";
import type { MemoryService } from "../memory-service.js";

// ---------------------------------------------------------------------------
// Shared fixture: a Map-backed BaseStore that correctly partitions by namespace
// ---------------------------------------------------------------------------

function createSharedStore(
  capabilities: MemoryStoreCapabilities = {
    supportsDelete: true,
    supportsSearchFilters: true,
    supportsPagination: true,
  },
) {
  // Key: "ns-path|item-key"  → value
  const data = new Map<string, Record<string, unknown>>();

  function ck(ns: string[], key: string) {
    return `${ns.join("/")}|${key}`;
  }

  const store = {
    put: vi
      .fn()
      .mockImplementation(
        (ns: string[], key: string, value: Record<string, unknown>) => {
          data.set(ck(ns, key), { ...value });
          return Promise.resolve();
        },
      ),
    get: vi.fn().mockImplementation((ns: string[], key: string) => {
      const value = data.get(ck(ns, key));
      return Promise.resolve(value !== undefined ? { key, value } : undefined);
    }),
    delete: vi.fn().mockImplementation((ns: string[], key: string) => {
      data.delete(ck(ns, key));
      return Promise.resolve();
    }),
    search: vi
      .fn()
      .mockImplementation(
        (ns: string[], opts?: { query?: string; limit?: number }) => {
          const prefix = ns.join("/") + "|";
          const items: Array<{
            key: string;
            value: Record<string, unknown>;
            namespace: string[];
          }> = [];
          for (const [compositeKey, value] of data.entries()) {
            if (compositeKey.startsWith(prefix)) {
              items.push({
                key: compositeKey.slice(prefix.length),
                value,
                namespace: ns,
              });
            }
          }
          const slice =
            opts?.limit !== undefined ? items.slice(0, opts.limit) : items;
          return Promise.resolve(slice);
        },
      ),
    list: vi.fn().mockImplementation((ns: string[]) => {
      const prefix = ns.join("/") + "|";
      const keys: string[] = [];
      for (const compositeKey of data.keys()) {
        if (compositeKey.startsWith(prefix))
          keys.push(compositeKey.slice(prefix.length));
      }
      return Promise.resolve(keys);
    }),
    capabilities,
    _data: data,
  };

  return store as unknown as BaseStore & {
    capabilities: MemoryStoreCapabilities;
    _data: Map<string, Record<string, unknown>>;
    put: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
}

// ---------------------------------------------------------------------------
// Shared fixture: mock MemoryService
// ---------------------------------------------------------------------------

interface StoredRecord {
  ns: string;
  scope: Record<string, string>;
  key: string;
  value: Record<string, unknown>;
}

function createMockMemoryService() {
  const records: StoredRecord[] = [];

  const service = {
    put: vi
      .fn()
      .mockImplementation(
        async (
          ns: string,
          scope: Record<string, string>,
          key: string,
          value: Record<string, unknown>,
        ) => {
          records.push({ ns, scope, key, value });
        },
      ),
    get: vi
      .fn()
      .mockImplementation(
        async (ns: string, scope: Record<string, string>, key?: string) => {
          return records
            .filter(
              (r) =>
                r.ns === ns &&
                JSON.stringify(r.scope) === JSON.stringify(scope),
            )
            .filter((r) => key === undefined || r.key === key)
            .map((r) => r.value);
        },
      ),
    search: vi
      .fn()
      .mockImplementation(
        async (ns: string, scope: Record<string, string>, query: string) => {
          const q = query.toLowerCase();
          return records
            .filter(
              (r) =>
                r.ns === ns &&
                JSON.stringify(r.scope) === JSON.stringify(scope),
            )
            .filter((r) => JSON.stringify(r.value).toLowerCase().includes(q))
            .map((r) => r.value);
        },
      ),
    formatForPrompt: vi.fn().mockReturnValue("formatted"),
    _records: records,
  } as unknown as MemoryService & { _records: StoredRecord[] };

  return service;
}

// ===========================================================================
// 1. TenantScopedStore — Namespace Boundaries
// ===========================================================================

describe("TenantScopedStore — namespace boundaries", () => {
  let underlying: ReturnType<typeof createSharedStore>;
  let tenantA: TenantScopedStore;
  let tenantB: TenantScopedStore;

  beforeEach(() => {
    underlying = createSharedStore();
    tenantA = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-alpha",
    });
    tenantB = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-beta",
    });
  });

  it("stores data under tenant-specific namespace prefix", async () => {
    await tenantA.put(["lessons"], "l1", { text: "alpha lesson" });
    expect(underlying.put).toHaveBeenCalledWith(
      ["tenant-alpha", "lessons"],
      "l1",
      { text: "alpha lesson" },
    );
  });

  it("two tenants with same key in same sub-namespace do not share storage slot", async () => {
    await tenantA.put(["facts"], "f1", { data: "A data" });
    await tenantB.put(["facts"], "f1", { data: "B data" });

    const underlying_data = underlying._data;
    const keyA = "tenant-alpha/facts|f1";
    const keyB = "tenant-beta/facts|f1";
    expect(underlying_data.get(keyA)).toEqual({ data: "A data" });
    expect(underlying_data.get(keyB)).toEqual({ data: "B data" });
  });

  it("deeply nested namespaces remain isolated per tenant", async () => {
    await tenantA.put(["a", "b", "c"], "deep", { depth: "A" });
    await tenantB.put(["a", "b", "c"], "deep", { depth: "B" });

    const dataA = await tenantA.get(["a", "b", "c"], "deep");
    const dataB = await tenantB.get(["a", "b", "c"], "deep");
    expect(dataA).toEqual({ depth: "A" });
    expect(dataB).toEqual({ depth: "B" });
  });

  it("tenant prefix is always the first namespace segment", async () => {
    await tenantA.put(["ns1", "ns2"], "k", { v: 1 });
    expect(underlying.put).toHaveBeenCalledWith(
      ["tenant-alpha", "ns1", "ns2"],
      "k",
      { v: 1 },
    );
  });

  it("root-level (empty sub-namespace) is still isolated", async () => {
    await tenantA.put([], "root", { owner: "A" });
    await tenantB.put([], "root", { owner: "B" });

    expect(await tenantA.get([], "root")).toEqual({ owner: "A" });
    expect(await tenantB.get([], "root")).toEqual({ owner: "B" });
  });
});

// ===========================================================================
// 2. TenantScopedStore — Read Isolation
// ===========================================================================

describe("TenantScopedStore — read isolation", () => {
  let underlying: ReturnType<typeof createSharedStore>;
  let tenantA: TenantScopedStore;
  let tenantB: TenantScopedStore;

  beforeEach(async () => {
    underlying = createSharedStore();
    tenantA = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-A",
    });
    tenantB = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-B",
    });

    // Seed tenant A data
    await tenantA.put(["rules"], "rule-1", { content: "A rule one" });
    await tenantA.put(["rules"], "rule-2", { content: "A rule two" });
    await tenantA.put(["skills"], "skill-1", { name: "A skill" });
  });

  it("tenant B cannot read tenant A entry by explicit key", async () => {
    const result = await tenantB.get(["rules"], "rule-1");
    expect(result).toBeUndefined();
  });

  it("tenant B search returns empty when tenant A has data", async () => {
    const results = await tenantB.search(["rules"]);
    expect(results).toHaveLength(0);
  });

  it("tenant B list returns empty when only tenant A has entries", async () => {
    const keys = await tenantB.list(["rules"]);
    expect(keys).toHaveLength(0);
  });

  it("tenant A can read its own data by key", async () => {
    const result = await tenantA.get(["rules"], "rule-1");
    expect(result).toEqual({ content: "A rule one" });
  });

  it("tenant A search returns only its own entries", async () => {
    const results = await tenantA.search(["rules"]);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect((r.value as Record<string, unknown>)["content"]).toMatch(/^A /);
    }
  });

  it("search results have tenant-local namespaces (prefix stripped)", async () => {
    const results = await tenantA.search(["rules"]);
    for (const r of results) {
      expect(r.namespace).toEqual(["rules"]);
      expect(r.namespace[0]).not.toBe("tenant-A");
    }
  });

  it("tenant B cannot see tenant A skills via list", async () => {
    const keys = await tenantB.list(["skills"]);
    expect(keys).toHaveLength(0);
  });

  it("multiple tenants all read their own isolated entries", async () => {
    const tenantC = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-C",
    });
    await tenantC.put(["rules"], "rule-1", { content: "C rule" });

    const fromA = await tenantA.search(["rules"]);
    const fromB = await tenantB.search(["rules"]);
    const fromC = await tenantC.search(["rules"]);

    expect(fromA.map((r) => r.value["content"])).toEqual(
      expect.arrayContaining(["A rule one", "A rule two"]),
    );
    expect(fromB).toHaveLength(0);
    expect(fromC).toHaveLength(1);
    expect(fromC[0]!.value["content"]).toBe("C rule");
  });
});

// ===========================================================================
// 3. TenantScopedStore — Write Isolation
// ===========================================================================

describe("TenantScopedStore — write isolation", () => {
  let underlying: ReturnType<typeof createSharedStore>;
  let tenantA: TenantScopedStore;
  let tenantB: TenantScopedStore;

  beforeEach(async () => {
    underlying = createSharedStore();
    tenantA = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-A",
    });
    tenantB = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-B",
    });
    await tenantA.put(["data"], "k1", { value: "original" });
  });

  it("tenant B write with same key does not overwrite tenant A", async () => {
    await tenantB.put(["data"], "k1", { value: "hijacked" });

    expect(await tenantA.get(["data"], "k1")).toEqual({ value: "original" });
    expect(await tenantB.get(["data"], "k1")).toEqual({ value: "hijacked" });
  });

  it("tenant B delete of tenant A key has no effect on tenant A", async () => {
    await tenantB.delete(["data"], "k1");

    // Tenant A's entry should still exist
    const result = await tenantA.get(["data"], "k1");
    expect(result).toEqual({ value: "original" });
  });

  it("tenant A delete only removes its own entry", async () => {
    await tenantB.put(["data"], "k1", { value: "B entry" });
    await tenantA.delete(["data"], "k1");

    expect(await tenantA.get(["data"], "k1")).toBeUndefined();
    expect(await tenantB.get(["data"], "k1")).toEqual({ value: "B entry" });
  });

  it("underlying delete is called with tenant-prefixed namespace", async () => {
    await tenantA.delete(["data"], "k1");
    expect(underlying.delete).toHaveBeenCalledWith(["tenant-A", "data"], "k1");
  });

  it("soft-delete (no delete capability) does not expose tombstone to other tenant", async () => {
    const softUnderlying = createSharedStore({
      supportsDelete: false,
      supportsSearchFilters: true,
      supportsPagination: true,
    });
    const softA = new TenantScopedStore({
      store: softUnderlying,
      tenantId: "tenant-SA",
    });
    const softB = new TenantScopedStore({
      store: softUnderlying,
      tenantId: "tenant-SB",
    });

    await softA.put(["items"], "item-1", { text: "hello" });
    await softB.put(["items"], "item-1", { text: "world" });

    // Delete from A
    await softA.delete(["items"], "item-1");

    // A should see nothing (tombstone filtered)
    expect(await softA.get(["items"], "item-1")).toBeUndefined();
    const aResults = await softA.search(["items"]);
    expect(aResults).toHaveLength(0);

    // B should still see its entry
    expect(await softB.get(["items"], "item-1")).toEqual({ text: "world" });
    const bResults = await softB.search(["items"]);
    expect(bResults).toHaveLength(1);
  });

  it("concurrent writes from both tenants do not corrupt either store", async () => {
    const writes = Array.from({ length: 10 }, (_, i) =>
      Promise.all([
        tenantA.put(["concurrent"], `key-${i}`, { tenant: "A", idx: i }),
        tenantB.put(["concurrent"], `key-${i}`, { tenant: "B", idx: i }),
      ]),
    );
    await Promise.all(writes);

    const aList = await tenantA.list(["concurrent"]);
    const bList = await tenantB.list(["concurrent"]);
    expect(aList).toHaveLength(10);
    expect(bList).toHaveLength(10);

    for (let i = 0; i < 10; i++) {
      expect(await tenantA.get(["concurrent"], `key-${i}`)).toMatchObject({
        tenant: "A",
        idx: i,
      });
      expect(await tenantB.get(["concurrent"], `key-${i}`)).toMatchObject({
        tenant: "B",
        idx: i,
      });
    }
  });
});

// ===========================================================================
// 4. TenantScopedStore — Namespace Enumeration
// ===========================================================================

describe("TenantScopedStore — namespace enumeration isolation", () => {
  let underlying: ReturnType<typeof createSharedStore>;

  beforeEach(() => {
    underlying = createSharedStore();
  });

  it("list is scoped: tenant B list does not return keys from tenant A namespace", async () => {
    const tA = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-A",
    });
    const tB = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-B",
    });

    await tA.put(["docs"], "doc-1", { text: "A document" });
    await tA.put(["docs"], "doc-2", { text: "Another A document" });

    expect(await tB.list(["docs"])).toHaveLength(0);
    expect(await tA.list(["docs"])).toHaveLength(2);
  });

  it("search does not expose other tenants regardless of query wildcard", async () => {
    const tA = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-A",
    });
    const tB = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-B",
    });

    await tA.put(["secrets"], "password", { secret: "A-secret-value" });
    await tB.put(["public"], "info", { text: "B public info" });

    // B searching across multiple sub-namespaces should not leak A's secrets
    const secretsFromB = await tB.search(["secrets"]);
    expect(secretsFromB).toHaveLength(0);
  });

  it("scoped sub-store is isolated from sibling scopes of same tenant", async () => {
    const tA = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-A",
    });
    const proj1 = tA.scope("project-1");
    const proj2 = tA.scope("project-2");

    await proj1.put(["tasks"], "t1", { title: "Task P1" });
    await proj2.put(["tasks"], "t1", { title: "Task P2" });

    expect(await proj1.get(["tasks"], "t1")).toEqual({ title: "Task P1" });
    expect(await proj2.get(["tasks"], "t1")).toEqual({ title: "Task P2" });

    // Listing from proj1 does not include proj2 tasks
    expect(await proj1.list(["tasks"])).toHaveLength(1);
    expect(await proj2.list(["tasks"])).toHaveLength(1);
  });

  it("projectId-scoped store does not leak across project boundaries", async () => {
    const store1 = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-X",
      projectId: "proj-1",
    });
    const store2 = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-X",
      projectId: "proj-2",
    });

    await store1.put(["ns"], "key", { source: "proj-1" });
    expect(await store2.get(["ns"], "key")).toBeUndefined();
    expect(await store2.list(["ns"])).toHaveLength(0);
  });
});

// ===========================================================================
// 5. TenantScopedStore — Wildcard / Filter Isolation
// ===========================================================================

describe("TenantScopedStore — wildcard and filter isolation", () => {
  let underlying: ReturnType<typeof createSharedStore>;

  beforeEach(() => {
    underlying = createSharedStore();
  });

  it("search with a broad query does not cross tenant boundaries", async () => {
    const tA = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-A",
    });
    const tB = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-B",
    });

    for (let i = 0; i < 5; i++) {
      await tA.put(["items"], `item-${i}`, { data: `value-${i}` });
    }

    // B searching with an unbounded query should find nothing
    const results = await tB.search(["items"]);
    expect(results).toHaveLength(0);
  });

  it("local filter application does not expose cross-tenant data", async () => {
    const noFilterUnderlying = createSharedStore({
      supportsDelete: true,
      supportsSearchFilters: false,
      supportsPagination: false,
    });
    const tA = new TenantScopedStore({
      store: noFilterUnderlying,
      tenantId: "tenant-A",
    });
    const tB = new TenantScopedStore({
      store: noFilterUnderlying,
      tenantId: "tenant-B",
    });

    await tA.put(["ns"], "k1", { category: "X", text: "A entry" });
    await tB.put(["ns"], "k1", { category: "X", text: "B entry" });

    // Even applying a filter, B should only see its own category-X entry
    const resultsB = await tB.search(["ns"], { filter: { category: "X" } });
    expect(resultsB).toHaveLength(1);
    expect(resultsB[0]!.value["text"]).toBe("B entry");
  });

  it("pagination limit applies per tenant, not across all tenants", async () => {
    const tA = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-A",
    });
    const tB = new TenantScopedStore({
      store: underlying,
      tenantId: "tenant-B",
    });

    for (let i = 0; i < 5; i++) {
      await tA.put(["items"], `a-item-${i}`, { idx: i });
      await tB.put(["items"], `b-item-${i}`, { idx: i });
    }

    // A with limit 3 should only return 3 of A's own entries
    const resultsA = await tA.search(["items"], { limit: 3 });
    expect(resultsA).toHaveLength(3);
    for (const r of resultsA) {
      expect(r.key).toMatch(/^a-item-/);
    }
  });
});

// ===========================================================================
// 6. TenantScopedStore — Concurrent Access
// ===========================================================================

describe("TenantScopedStore — concurrent access", () => {
  it("concurrent reads from different tenants do not interfere", async () => {
    const underlying = createSharedStore();
    const tA = new TenantScopedStore({
      store: underlying,
      tenantId: "concurrent-A",
    });
    const tB = new TenantScopedStore({
      store: underlying,
      tenantId: "concurrent-B",
    });

    await tA.put(["data"], "shared-key", { owner: "A" });
    await tB.put(["data"], "shared-key", { owner: "B" });

    // Concurrent reads
    const [resultA, resultB] = await Promise.all([
      tA.get(["data"], "shared-key"),
      tB.get(["data"], "shared-key"),
    ]);

    expect(resultA).toEqual({ owner: "A" });
    expect(resultB).toEqual({ owner: "B" });
  });

  it("burst writes from two tenants maintain independent counts", async () => {
    const underlying = createSharedStore();
    const tA = new TenantScopedStore({
      store: underlying,
      tenantId: "burst-A",
    });
    const tB = new TenantScopedStore({
      store: underlying,
      tenantId: "burst-B",
    });

    const N = 20;
    await Promise.all([
      ...Array.from({ length: N }, (_, i) => tA.put(["ns"], `key-${i}`, { i })),
      ...Array.from({ length: N }, (_, i) => tB.put(["ns"], `key-${i}`, { i })),
    ]);

    const aKeys = await tA.list(["ns"]);
    const bKeys = await tB.list(["ns"]);
    expect(aKeys).toHaveLength(N);
    expect(bKeys).toHaveLength(N);
  });

  it("interleaved read-write cycles do not corrupt tenant data", async () => {
    const underlying = createSharedStore();
    const tA = new TenantScopedStore({ store: underlying, tenantId: "rw-A" });
    const tB = new TenantScopedStore({ store: underlying, tenantId: "rw-B" });

    // Round 1: both write
    await Promise.all([
      tA.put(["log"], "entry", { round: 1, who: "A" }),
      tB.put(["log"], "entry", { round: 1, who: "B" }),
    ]);

    // Round 2: both read and overwrite
    const [r1A, r1B] = await Promise.all([
      tA.get(["log"], "entry"),
      tB.get(["log"], "entry"),
    ]);
    expect(r1A?.["who"]).toBe("A");
    expect(r1B?.["who"]).toBe("B");

    await Promise.all([
      tA.put(["log"], "entry", { round: 2, who: "A" }),
      tB.put(["log"], "entry", { round: 2, who: "B" }),
    ]);

    const [r2A, r2B] = await Promise.all([
      tA.get(["log"], "entry"),
      tB.get(["log"], "entry"),
    ]);
    expect(r2A?.["round"]).toBe(2);
    expect(r2A?.["who"]).toBe("A");
    expect(r2B?.["round"]).toBe(2);
    expect(r2B?.["who"]).toBe("B");
  });
});

// ===========================================================================
// 7. ScopedMemoryService — ACL Enforcement (tenant-level agent isolation)
// ===========================================================================

describe("ScopedMemoryService — ACL enforcement between tenants", () => {
  let sharedMemory: ReturnType<typeof createMockMemoryService>;

  beforeEach(() => {
    sharedMemory = createMockMemoryService();
  });

  const SCOPE_A = { tenantId: "tenant-A", projectId: "p1" };
  const SCOPE_B = { tenantId: "tenant-B", projectId: "p1" };

  it("agent for tenant A with write-access can write its own namespace", async () => {
    const svc = new ScopedMemoryService(sharedMemory, {
      agentId: "agent-A",
      namespaces: { "tenant-A-data": "read-write" },
    });

    await svc.put("tenant-A-data", SCOPE_A, "k1", { text: "A data" });
    expect(sharedMemory.put).toHaveBeenCalledTimes(1);
  });

  it("agent for tenant A cannot write into tenant B namespace", async () => {
    const svc = new ScopedMemoryService(sharedMemory, {
      agentId: "agent-A",
      namespaces: { "tenant-A-data": "read-write" },
      // defaultAccess is 'none' -- cannot write to tenant-B-data
    });

    await svc.put("tenant-B-data", SCOPE_B, "k1", { text: "Leaking!" });
    expect(sharedMemory.put).not.toHaveBeenCalled();
    expect(svc.getViolations()).toHaveLength(1);
    expect(svc.getViolations()[0]).toMatchObject({
      agentId: "agent-A",
      namespace: "tenant-B-data",
      operation: "write",
    });
  });

  it("agent for tenant A cannot read from tenant B namespace", async () => {
    const svc = new ScopedMemoryService(sharedMemory, {
      agentId: "agent-A",
      namespaces: { "tenant-A-data": "read-write" },
    });

    const result = await svc.get("tenant-B-data", SCOPE_B);
    expect(result).toEqual([]);
    expect(sharedMemory.get).not.toHaveBeenCalled();
  });

  it("agent for tenant A cannot search in tenant B namespace", async () => {
    const svc = new ScopedMemoryService(sharedMemory, {
      agentId: "agent-A",
      namespaces: { "tenant-A-data": "read" },
    });

    const results = await svc.search("tenant-B-data", SCOPE_B, "any query");
    expect(results).toEqual([]);
    expect(sharedMemory.search).not.toHaveBeenCalled();
  });

  it("strict mode throws on cross-tenant write attempt", async () => {
    const svc = new ScopedMemoryService(
      sharedMemory,
      { agentId: "agent-A", namespaces: { "tenant-A-ns": "read-write" } },
      { strict: true },
    );

    await expect(
      svc.put("tenant-B-ns", SCOPE_B, "k", { text: "steal" }),
    ).rejects.toThrow(/access violation/);
  });

  it("strict mode throws on cross-tenant read attempt", async () => {
    const svc = new ScopedMemoryService(
      sharedMemory,
      { agentId: "agent-A", namespaces: { "tenant-A-ns": "write" } },
      { strict: true },
    );

    await expect(svc.get("tenant-B-ns", SCOPE_B)).rejects.toThrow(
      /access violation/,
    );
  });

  it("two separate ScopedMemoryService instances share the same underlying service but respect separate policies", async () => {
    const svcA = new ScopedMemoryService(sharedMemory, {
      agentId: "agent-A",
      namespaces: { "ns-A": "read-write", "shared-ns": "read" },
    });
    const svcB = new ScopedMemoryService(sharedMemory, {
      agentId: "agent-B",
      namespaces: { "ns-B": "read-write", "shared-ns": "read" },
    });

    // A can write ns-A, B cannot
    expect(svcA.canAccess("ns-A", "write")).toBe(true);
    expect(svcB.canAccess("ns-A", "write")).toBe(false);

    // B can write ns-B, A cannot
    expect(svcB.canAccess("ns-B", "write")).toBe(true);
    expect(svcA.canAccess("ns-B", "write")).toBe(false);

    // Both can read shared-ns
    expect(svcA.canAccess("shared-ns", "read")).toBe(true);
    expect(svcB.canAccess("shared-ns", "read")).toBe(true);

    // Neither can write to shared-ns
    expect(svcA.canAccess("shared-ns", "write")).toBe(false);
    expect(svcB.canAccess("shared-ns", "write")).toBe(false);
  });

  it("violations from one tenant service do not appear in another tenant service", async () => {
    const svcA = new ScopedMemoryService(sharedMemory, {
      agentId: "agent-A",
      namespaces: {},
    });
    const svcB = new ScopedMemoryService(sharedMemory, {
      agentId: "agent-B",
      namespaces: {},
    });

    await svcA.put("blocked-ns", SCOPE_A, "k", { data: "x" });
    expect(svcA.getViolations()).toHaveLength(1);
    expect(svcB.getViolations()).toHaveLength(0);
  });

  it("write tags include agent identity for cross-tenant audit", async () => {
    const svc = new ScopedMemoryService(sharedMemory, {
      agentId: "agent-A",
      namespaces: { "allowed-ns": "write" },
      writeTags: { tenant: "tenant-A", environment: "test" },
    });

    await svc.put("allowed-ns", SCOPE_A, "key", { text: "hello" });

    expect(sharedMemory.put).toHaveBeenCalledTimes(1);
    const [, , , written] = (sharedMemory.put as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect((written as Record<string, unknown>)["_agent"]).toBe("agent-A");
    expect((written as Record<string, unknown>)["_tag_tenant"]).toBe(
      "tenant-A",
    );
  });
});

// ===========================================================================
// 8. createAgentMemories — Multi-tenant isolation factory
// ===========================================================================

describe("createAgentMemories — cross-tenant factory isolation", () => {
  it("creates isolated scoped services from a single shared memory", () => {
    const shared = createMockMemoryService();
    const agents = createAgentMemories(shared, [
      { agentId: "tenant-A-agent", namespaces: { "tenant-A": "read-write" } },
      { agentId: "tenant-B-agent", namespaces: { "tenant-B": "read-write" } },
    ]);

    const agentA = agents.get("tenant-A-agent")!;
    const agentB = agents.get("tenant-B-agent")!;

    expect(agentA.canAccess("tenant-A", "write")).toBe(true);
    expect(agentA.canAccess("tenant-B", "write")).toBe(false);
    expect(agentB.canAccess("tenant-B", "write")).toBe(true);
    expect(agentB.canAccess("tenant-A", "write")).toBe(false);
  });

  it("strict mode applies to all agents in factory output", async () => {
    const shared = createMockMemoryService();
    const agents = createAgentMemories(
      shared,
      [{ agentId: "a1", namespaces: { "ns-a1": "read-write" } }],
      { strict: true },
    );

    const svc = agents.get("a1")!;
    await expect(svc.put("ns-other", {}, "k", { v: 1 })).rejects.toThrow(
      /access violation/,
    );
  });

  it("PolicyTemplates.isolatedWithSharedRead creates correct cross-tenant boundaries", () => {
    const shared = createMockMemoryService();
    const policyA = PolicyTemplates.isolatedWithSharedRead(
      "agent-A",
      ["private-A"],
      ["shared-workspace"],
    );
    const policyB = PolicyTemplates.isolatedWithSharedRead(
      "agent-B",
      ["private-B"],
      ["shared-workspace"],
    );
    const agents = createAgentMemories(shared, [policyA, policyB]);

    const svcA = agents.get("agent-A")!;
    const svcB = agents.get("agent-B")!;

    // Each can only write to its own private namespace
    expect(svcA.canAccess("private-A", "write")).toBe(true);
    expect(svcA.canAccess("private-B", "write")).toBe(false);
    expect(svcB.canAccess("private-B", "write")).toBe(true);
    expect(svcB.canAccess("private-A", "write")).toBe(false);

    // Both can read shared workspace, neither can write
    expect(svcA.canAccess("shared-workspace", "read")).toBe(true);
    expect(svcB.canAccess("shared-workspace", "read")).toBe(true);
    expect(svcA.canAccess("shared-workspace", "write")).toBe(false);
    expect(svcB.canAccess("shared-workspace", "write")).toBe(false);
  });
});

// ===========================================================================
// 9. SharedMemoryNamespace — ACL enforcement (allowedWriters)
// ===========================================================================

describe("SharedMemoryNamespace — ACL enforcement", () => {
  it("throws when a non-permitted tenant attempts a write", () => {
    const ns = new SharedMemoryNamespace({
      namespace: ["shared"],
      allowedWriters: ["tenant-A"],
    });

    expect(() => ns.put("tenant-B", "key", { data: "leak" })).toThrow(
      /not allowed to write/,
    );
  });

  it("only permitted tenant can write", () => {
    const ns = new SharedMemoryNamespace({
      namespace: ["shared"],
      allowedWriters: ["tenant-A", "tenant-B"],
    });

    const entry = ns.put("tenant-A", "k1", { text: "A wrote this" });
    expect(entry.writtenBy).toBe("tenant-A");
  });

  it("unpermitted tenant cannot delete entries", () => {
    const ns = new SharedMemoryNamespace({
      namespace: ["shared"],
      allowedWriters: ["tenant-A"],
    });
    ns.put("tenant-A", "key", { data: "value" });

    expect(() => ns.delete("tenant-B", "key")).toThrow(/not allowed to write/);
  });

  it("permitted tenant can delete its own entry", () => {
    const ns = new SharedMemoryNamespace({
      namespace: ["shared"],
      allowedWriters: ["tenant-A"],
    });
    ns.put("tenant-A", "key", { data: "temp" });
    const deleted = ns.delete("tenant-A", "key");
    expect(deleted).toBe(true);
    expect(ns.get("key")).toBeNull();
  });

  it("canWrite correctly identifies permitted and denied tenants", () => {
    const ns = new SharedMemoryNamespace({
      namespace: ["ns"],
      allowedWriters: ["tenant-A"],
    });

    expect(ns.canWrite("tenant-A")).toBe(true);
    expect(ns.canWrite("tenant-B")).toBe(false);
    expect(ns.canWrite("tenant-C")).toBe(false);
  });

  it("empty allowedWriters means all tenants can write", () => {
    const ns = new SharedMemoryNamespace({ namespace: ["ns"] });
    expect(ns.canWrite("any-tenant")).toBe(true);
    expect(ns.canWrite("another-tenant")).toBe(true);
  });

  it("ACL-protected namespace: multiple tenants each write their own entry", () => {
    const ns = new SharedMemoryNamespace({
      namespace: ["shared"],
      allowedWriters: ["tenant-A", "tenant-B"],
    });

    ns.put("tenant-A", "entry-A", { text: "A content" });
    ns.put("tenant-B", "entry-B", { text: "B content" });

    expect(ns.get("entry-A")?.writtenBy).toBe("tenant-A");
    expect(ns.get("entry-B")?.writtenBy).toBe("tenant-B");
    expect(ns.list()).toHaveLength(2);
  });
});

// ===========================================================================
// 10. Cross-tenant explicit sharing (SharedMemoryNamespace)
// ===========================================================================

describe("SharedMemoryNamespace — explicit cross-tenant share", () => {
  it("shared namespace allows authorized tenants to see each others entries", () => {
    const shared = new SharedMemoryNamespace({
      namespace: ["cross-tenant-share"],
      allowedWriters: ["tenant-A", "tenant-B"],
    });

    shared.put("tenant-A", "a-entry", { secret: "A shared data" });
    shared.put("tenant-B", "b-entry", { secret: "B shared data" });

    // Both entries are visible to any reader
    expect(shared.get("a-entry")?.value["secret"]).toBe("A shared data");
    expect(shared.get("b-entry")?.value["secret"]).toBe("B shared data");
  });

  it("tenant can overwrite another tenants entry in open shared namespace", () => {
    const shared = new SharedMemoryNamespace({ namespace: ["ns"] });
    shared.put("tenant-A", "shared-key", { value: "A original" });
    shared.put("tenant-B", "shared-key", { value: "B overwrote" });

    const entry = shared.get("shared-key");
    expect(entry?.writtenBy).toBe("tenant-B");
    expect(entry?.value["value"]).toBe("B overwrote");
  });

  it("search in shared namespace returns all entries regardless of tenant", () => {
    const shared = new SharedMemoryNamespace({
      namespace: ["shared"],
      allowedWriters: ["tenant-A", "tenant-B"],
    });

    shared.put("tenant-A", "k1", { text: "alpha search term" });
    shared.put("tenant-B", "k2", { text: "alpha search term" });

    const results = shared.search("alpha search term");
    expect(results).toHaveLength(2);
  });

  it("shared namespace audit records which tenant made each write", () => {
    const shared = new SharedMemoryNamespace({
      namespace: ["audit-test"],
      allowedWriters: ["tenant-A", "tenant-B"],
      enableAudit: true,
    });

    shared.put("tenant-A", "k1", { data: "a" });
    shared.put("tenant-B", "k2", { data: "b" });

    const audit = shared.getAudit();
    expect(audit).toHaveLength(2);
    expect(audit[0]!.agentId).toBe("tenant-A");
    expect(audit[1]!.agentId).toBe("tenant-B");
  });
});

// ===========================================================================
// 11. InMemoryMemoryClient — cross-tenant isolation via scope
// ===========================================================================

describe("InMemoryMemoryClient — cross-tenant scope isolation", () => {
  let client: InMemoryMemoryClient;

  beforeEach(() => {
    client = new InMemoryMemoryClient();
  });

  it("records stored under tenant A scope are not returned for tenant B scope", async () => {
    await client.put(
      "docs",
      { tenantId: "tenant-A" },
      {
        id: "doc-1",
        namespace: "docs",
        scope: { tenantId: "tenant-A" },
        content: "A content",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    );

    const resultsB = await client.get("docs", { tenantId: "tenant-B" });
    expect(resultsB).toHaveLength(0);
  });

  it("records stored under tenant A are returned for tenant A scope query", async () => {
    const now = Date.now();
    await client.put(
      "docs",
      { tenantId: "tenant-A" },
      {
        id: "doc-A",
        namespace: "docs",
        scope: { tenantId: "tenant-A" },
        content: "A content",
        createdAt: now,
        updatedAt: now,
      },
    );

    const results = await client.get("docs", { tenantId: "tenant-A" });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("doc-A");
  });

  it("tenant B delete does not remove tenant A record with same id", async () => {
    const now = Date.now();
    await client.put(
      "docs",
      { tenantId: "tenant-A" },
      {
        id: "shared-id",
        namespace: "docs",
        scope: { tenantId: "tenant-A" },
        content: "A content",
        createdAt: now,
        updatedAt: now,
      },
    );

    const deleted = await client.delete(
      "docs",
      { tenantId: "tenant-B" },
      "shared-id",
    );
    expect(deleted).toBe(false); // record belongs to A scope, not B

    const remaining = await client.get("docs", { tenantId: "tenant-A" });
    expect(remaining).toHaveLength(1);
  });

  it("stats show combined namespace count without revealing per-tenant boundaries", async () => {
    const now = Date.now();
    await client.put(
      "docs",
      { tenantId: "tenant-A" },
      {
        id: "a1",
        namespace: "docs",
        scope: { tenantId: "tenant-A" },
        content: "A",
        createdAt: now,
        updatedAt: now,
      },
    );
    await client.put(
      "logs",
      { tenantId: "tenant-B" },
      {
        id: "b1",
        namespace: "logs",
        scope: { tenantId: "tenant-B" },
        content: "B",
        createdAt: now,
        updatedAt: now,
      },
    );

    const s = await client.stats();
    expect(s.totalRecords).toBe(2);
    expect(s.namespaces).toContain("docs");
    expect(s.namespaces).toContain("logs");
  });

  it("workspace-scoped query does not return records scoped to a different workspace", async () => {
    const now = Date.now();
    await client.put(
      "items",
      { tenantId: "T1", workspaceId: "ws-1" },
      {
        id: "item-1",
        namespace: "items",
        scope: { tenantId: "T1", workspaceId: "ws-1" },
        content: "ws1 item",
        createdAt: now,
        updatedAt: now,
      },
    );

    const results = await client.get("items", {
      tenantId: "T1",
      workspaceId: "ws-2",
    });
    expect(results).toHaveLength(0);
  });

  it("subscribers for tenant A are not notified about tenant B events", async () => {
    const eventsForA: unknown[] = [];
    client.subscribe("docs", { tenantId: "tenant-A" }, (e) =>
      eventsForA.push(e),
    );

    const now = Date.now();
    await client.put(
      "docs",
      { tenantId: "tenant-B" },
      {
        id: "b-doc",
        namespace: "docs",
        scope: { tenantId: "tenant-B" },
        content: "B doc",
        createdAt: now,
        updatedAt: now,
      },
    );

    expect(eventsForA).toHaveLength(0);
  });

  it("subscribers for tenant A are notified when tenant A writes", async () => {
    const eventsForA: unknown[] = [];
    client.subscribe("docs", { tenantId: "tenant-A" }, (e) =>
      eventsForA.push(e),
    );

    const now = Date.now();
    await client.put(
      "docs",
      { tenantId: "tenant-A" },
      {
        id: "a-doc",
        namespace: "docs",
        scope: { tenantId: "tenant-A" },
        content: "A doc",
        createdAt: now,
        updatedAt: now,
      },
    );

    expect(eventsForA).toHaveLength(1);
  });
});

// ===========================================================================
// 12. Edge cases
// ===========================================================================

describe("edge cases — cross-tenant isolation", () => {
  it("same key under different tenant namespaces are independent", async () => {
    const underlying = createSharedStore();
    const tA = new TenantScopedStore({ store: underlying, tenantId: "edge-A" });
    const tB = new TenantScopedStore({ store: underlying, tenantId: "edge-B" });

    await tA.put(["shared-ns"], "same-key", { who: "A" });
    await tB.put(["shared-ns"], "same-key", { who: "B" });

    expect(await tA.get(["shared-ns"], "same-key")).toEqual({ who: "A" });
    expect(await tB.get(["shared-ns"], "same-key")).toEqual({ who: "B" });
  });

  it("tenant with no entries returns empty list and search results", async () => {
    const underlying = createSharedStore();
    const empty = new TenantScopedStore({
      store: underlying,
      tenantId: "ghost-tenant",
    });

    expect(await empty.list(["ns"])).toEqual([]);
    expect(await empty.search(["ns"])).toEqual([]);
    expect(await empty.get(["ns"], "any-key")).toBeUndefined();
  });

  it("all three operations on an empty store are non-throwing for any tenant", async () => {
    const underlying = createSharedStore();
    const t = new TenantScopedStore({
      store: underlying,
      tenantId: "new-tenant",
    });

    await expect(t.get(["ns"], "missing")).resolves.toBeUndefined();
    await expect(t.list(["ns"])).resolves.toEqual([]);
    await expect(t.search(["ns"])).resolves.toEqual([]);
    await expect(t.delete(["ns"], "missing")).resolves.toBeUndefined();
  });

  it("tenant A data persists after tenant B performs many writes", async () => {
    const underlying = createSharedStore();
    const tA = new TenantScopedStore({
      store: underlying,
      tenantId: "persist-A",
    });
    const tB = new TenantScopedStore({
      store: underlying,
      tenantId: "persist-B",
    });

    await tA.put(["stable"], "anchor", { value: "must survive" });

    // Tenant B floods with writes in the same sub-namespace
    for (let i = 0; i < 50; i++) {
      await tB.put(["stable"], `b-key-${i}`, { i });
    }

    expect(await tA.get(["stable"], "anchor")).toEqual({
      value: "must survive",
    });
  });

  it("scoped store created after flood does not inherit other tenant data", async () => {
    const underlying = createSharedStore();
    const tA = new TenantScopedStore({
      store: underlying,
      tenantId: "flood-A",
    });

    for (let i = 0; i < 10; i++) {
      await tA.put(["ns"], `k${i}`, { i });
    }

    // New tenant B is created AFTER A's data is present
    const tB = new TenantScopedStore({
      store: underlying,
      tenantId: "flood-B",
    });
    expect(await tB.list(["ns"])).toHaveLength(0);
    expect(await tB.search(["ns"])).toHaveLength(0);
  });

  it("scope() isolation: child scopes of different tenants remain isolated", async () => {
    const underlying = createSharedStore();
    const tA = new TenantScopedStore({
      store: underlying,
      tenantId: "scope-A",
    });
    const tB = new TenantScopedStore({
      store: underlying,
      tenantId: "scope-B",
    });

    const childA = tA.scope("project-X");
    const childB = tB.scope("project-X");

    await childA.put(["tasks"], "task-1", { owner: "A" });
    await childB.put(["tasks"], "task-1", { owner: "B" });

    expect(await childA.get(["tasks"], "task-1")).toEqual({ owner: "A" });
    expect(await childB.get(["tasks"], "task-1")).toEqual({ owner: "B" });

    // B cannot list A's tasks
    expect(await childB.list(["tasks"])).toHaveLength(1);
    const bTasks = await childB.list(["tasks"]);
    expect(bTasks[0]).not.toBeUndefined();

    // A list should show only A's task
    const aTasks = await childA.list(["tasks"]);
    expect(aTasks).toHaveLength(1);
  });

  it("ScopedMemoryService with none default access treats all namespaces as locked", async () => {
    const shared = createMockMemoryService();
    const locked = new ScopedMemoryService(shared, {
      agentId: "locked-agent",
      namespaces: {},
      defaultAccess: "none",
    });

    await locked.put("any-ns", {}, "k", { v: 1 });
    const reads = await locked.get("any-ns", {});
    const searches = await locked.search("any-ns", {}, "q");

    expect(shared.put).not.toHaveBeenCalled();
    expect(shared.get).not.toHaveBeenCalled();
    expect(shared.search).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
    expect(searches).toEqual([]);
    expect(locked.getViolations()).toHaveLength(3);
  });
});
