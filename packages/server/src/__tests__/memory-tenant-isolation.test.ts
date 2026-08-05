/**
 * Denial tests for MJ-SEC-04 — memory routes must be tenant-scoped by
 * server-authenticated metadata, not by caller-supplied namespace/scope.
 *
 * These tests assert that:
 *   1. Browse with a spoofed scope cannot read another tenant's memory.
 *   2. Export with a spoofed scope cannot export another tenant's memory.
 *   3. Import with a spoofed scope cannot write into another tenant's namespace.
 *   4. Single-tenant deployments (auth disabled) continue to work.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createForgeApp, type ForgeServerConfig } from "../app.js";
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
} from "@dzupagent/core";
import type { MemoryServiceLike } from "@dzupagent/memory-ipc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CallRecord {
  op: "get" | "getKeyed" | "search" | "put";
  namespace: string;
  scope: Record<string, string>;
  args: unknown[];
}

function createTrackingMemoryService(): MemoryServiceLike & {
  calls: CallRecord[];
} {
  const store = new Map<string, Record<string, unknown>[]>();
  const calls: CallRecord[] = [];

  function storeKey(ns: string, scope: Record<string, string>): string {
    const sorted = Object.entries(scope).sort(([a], [b]) => a.localeCompare(b));
    return `${ns}:${JSON.stringify(sorted)}`;
  }

  return {
    calls,
    async get(namespace: string, scope: Record<string, string>, key?: string) {
      calls.push({ op: "get", namespace, scope: { ...scope }, args: [key] });
      const sk = storeKey(namespace, scope);
      const records = store.get(sk) ?? [];
      if (key) return records.filter((r) => r["key"] === key);
      return records;
    },
    async getKeyed(namespace: string, scope: Record<string, string>) {
      // Tracked like the others: export reads keyed, so scope-rewrite
      // assertions must be able to see this call.
      calls.push({ op: "getKeyed", namespace, scope: { ...scope }, args: [] });
      const sk = storeKey(namespace, scope);
      return (store.get(sk) ?? []).map((r) => {
        const { key, ...value } = r;
        return { key: String(key), value };
      });
    },
    async search(
      namespace: string,
      scope: Record<string, string>,
      query: string,
      limit?: number
    ) {
      calls.push({
        op: "search",
        namespace,
        scope: { ...scope },
        args: [query, limit],
      });
      const sk = storeKey(namespace, scope);
      const records = store.get(sk) ?? [];
      return records.slice(0, limit ?? 100);
    },
    async put(
      namespace: string,
      scope: Record<string, string>,
      key: string,
      value: Record<string, unknown>
    ) {
      calls.push({ op: "put", namespace, scope: { ...scope }, args: [key] });
      const sk = storeKey(namespace, scope);
      const records = store.get(sk) ?? [];
      const idx = records.findIndex((r) => r["key"] === key);
      const record = { ...value, key };
      if (idx >= 0) records[idx] = record;
      else records.push(record);
      store.set(sk, records);
    },
  };
}

interface AuthOpts {
  // Map token → key metadata
  keys: Record<string, Record<string, unknown>>;
}

function createAuthedConfig(
  memoryService: MemoryServiceLike,
  auth?: AuthOpts
): ForgeServerConfig {
  const config: ForgeServerConfig = {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    memoryService,
  };
  if (auth) {
    config.auth = {
      mode: "api-key",
      validateKey: async (token: string) => auth.keys[token] ?? null,
    };
  }
  return config;
}

async function reqAuthed(
  app: ReturnType<typeof createForgeApp>,
  method: string,
  path: string,
  token: string,
  body?: unknown
) {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  };
  if (body) init.body = JSON.stringify(body);
  return app.request(path, init);
}

// ---------------------------------------------------------------------------
// Browse: spoofed scope cannot read another tenant's memory
// ---------------------------------------------------------------------------

describe("Memory browse — tenant isolation (MJ-SEC-04)", () => {
  let memoryService: ReturnType<typeof createTrackingMemoryService>;

  beforeEach(async () => {
    memoryService = createTrackingMemoryService();
    // Tenant A's data is keyed under tenantId=tenant-a
    await memoryService.put("lessons", { tenantId: "tenant-a" }, "a-secret", {
      text: "Tenant A secret",
    });
    // Tenant B's data is keyed under tenantId=tenant-b
    await memoryService.put("lessons", { tenantId: "tenant-b" }, "b-secret", {
      text: "Tenant B secret",
    });
  });

  it("forces authenticated tenantId over caller-supplied scope (browse)", async () => {
    const app = createForgeApp(
      createAuthedConfig(memoryService, {
        keys: {
          "token-a": { id: "k-a", tenantId: "tenant-a", role: "operator" },
          "token-b": { id: "k-b", tenantId: "tenant-b", role: "operator" },
        },
      })
    );

    // Tenant A presents tenant-b's scope to try to read tenant-b's data.
    const spoofed = encodeURIComponent(
      JSON.stringify({ tenantId: "tenant-b" })
    );
    const res = await reqAuthed(
      app,
      "GET",
      `/api/memory-browse/lessons?scope=${spoofed}`,
      "token-a"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { value: { text?: string } }[] };

    // Must only see tenant-a's data (the auth-derived scope wins).
    const texts = body.data.map((e) => e.value.text);
    expect(texts).toContain("Tenant A secret");
    expect(texts).not.toContain("Tenant B secret");

    // The downstream memory call must have received the AUTHORITATIVE tenantId.
    const lastGet = memoryService.calls.filter((c) => c.op === "get").at(-1);
    // Assert the call happened before asserting its scope: with `?.` alone,
    // a route that stops calling `get` turns this into a vacuous pass.
    expect(lastGet).toBeDefined();
    expect(lastGet?.scope["tenantId"]).toBe("tenant-a");
  });

  it("forces authenticated tenantId over caller-supplied scope on search", async () => {
    const app = createForgeApp(
      createAuthedConfig(memoryService, {
        keys: {
          "token-a": { id: "k-a", tenantId: "tenant-a", role: "operator" },
        },
      })
    );
    const spoofed = encodeURIComponent(
      JSON.stringify({ tenantId: "tenant-b" })
    );
    const res = await reqAuthed(
      app,
      "GET",
      `/api/memory-browse/lessons?scope=${spoofed}&search=secret`,
      "token-a"
    );
    expect(res.status).toBe(200);
    const lastSearch = memoryService.calls
      .filter((c) => c.op === "search")
      .at(-1);
    expect(lastSearch?.scope["tenantId"]).toBe("tenant-a");
  });

  it("layers ownerId from auth context onto scope (browse)", async () => {
    const app = createForgeApp(
      createAuthedConfig(memoryService, {
        keys: {
          "token-owner": { id: "k", ownerId: "owner-x", role: "operator" },
        },
      })
    );
    const res = await reqAuthed(
      app,
      "GET",
      "/api/memory-browse/lessons",
      "token-owner"
    );
    expect(res.status).toBe(200);
    const lastGet = memoryService.calls.filter((c) => c.op === "get").at(-1);
    expect(lastGet).toBeDefined();
    expect(lastGet?.scope["ownerId"]).toBe("owner-x");
  });

  it("honours client-supplied scope when auth is disabled (single-tenant)", async () => {
    const app = createForgeApp(createAuthedConfig(memoryService));
    const scope = encodeURIComponent(JSON.stringify({ tenantId: "tenant-a" }));
    const res = await app.request(`/api/memory-browse/lessons?scope=${scope}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { value: { text?: string } }[] };
    const texts = body.data.map((e) => e.value.text);
    expect(texts).toContain("Tenant A secret");
    expect(texts).not.toContain("Tenant B secret");
  });
});

// ---------------------------------------------------------------------------
// Export: spoofed scope cannot export another tenant's memory
// ---------------------------------------------------------------------------

describe("Memory export — tenant isolation (MJ-SEC-04)", () => {
  let memoryService: ReturnType<typeof createTrackingMemoryService>;

  beforeEach(async () => {
    memoryService = createTrackingMemoryService();
    await memoryService.put("lessons", { tenantId: "tenant-a" }, "a-1", {
      text: "A1",
    });
    await memoryService.put("lessons", { tenantId: "tenant-b" }, "b-1", {
      text: "B1",
    });
  });

  it("overrides spoofed scope with authenticated tenantId", async () => {
    const app = createForgeApp(
      createAuthedConfig(memoryService, {
        keys: {
          "token-a": { id: "k-a", tenantId: "tenant-a", role: "operator" },
        },
      })
    );

    // Tenant A tries to export tenant-b's data by spoofing the scope.
    const res = await reqAuthed(app, "POST", "/api/memory/export", "token-a", {
      namespace: "lessons",
      scope: { tenantId: "tenant-b" },
      format: "json",
      limit: 100,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { record_count: number; data: string };
    };

    // The export must only see tenant-a's frame, not tenant-b's.
    // We decode the json data and confirm no tenant-b records leaked.
    const decoded = Buffer.from(body.data.data, "base64").toString("utf8");
    expect(decoded).not.toContain("B1");
  });

  it("layers default scope when auth is disabled", async () => {
    // Auth disabled → caller-supplied scope is used, since this is a
    // single-tenant deployment.
    const app = createForgeApp(createAuthedConfig(memoryService));

    const res = await app.request("/api/memory/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespace: "lessons",
        scope: { tenantId: "tenant-a" },
        format: "json",
        limit: 100,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { data: string } };
    const decoded = Buffer.from(body.data.data, "base64").toString("utf8");
    expect(decoded).toContain("A1");
    expect(decoded).not.toContain("B1");
  });
});

// ---------------------------------------------------------------------------
// Import: spoofed scope cannot write into another tenant's namespace
// ---------------------------------------------------------------------------

describe("Memory import — tenant isolation (MJ-SEC-04)", () => {
  let memoryService: ReturnType<typeof createTrackingMemoryService>;

  beforeEach(async () => {
    memoryService = createTrackingMemoryService();
    // Pre-seed tenant A so we have data to export → import.
    await memoryService.put("lessons", { tenantId: "tenant-a" }, "seed", {
      text: "seed",
    });
  });

  it("rewrites import scope with authenticated tenantId (no cross-tenant write)", async () => {
    const appA = createForgeApp(
      createAuthedConfig(memoryService, {
        keys: {
          "token-a": { id: "k-a", tenantId: "tenant-a", role: "operator" },
        },
      })
    );

    // First export tenant-a's data while authenticated as tenant-a.
    const exportRes = await reqAuthed(
      appA,
      "POST",
      "/api/memory/export",
      "token-a",
      {
        namespace: "lessons",
        scope: {},
        format: "arrow_ipc",
        limit: 100,
      }
    );
    expect(exportRes.status).toBe(200);
    const exportBody = (await exportRes.json()) as { data: { data: string } };

    // Now authenticate as tenant-b and try to import using a SPOOFED tenant-a
    // scope. The server must rewrite the scope to tenant-b.
    const appB = createForgeApp(
      createAuthedConfig(memoryService, {
        keys: {
          "token-b": { id: "k-b", tenantId: "tenant-b", role: "operator" },
        },
      })
    );

    // Reset call tracker to only observe import-time writes.
    memoryService.calls.length = 0;

    const importRes = await reqAuthed(
      appB,
      "POST",
      "/api/memory/import",
      "token-b",
      {
        data: exportBody.data.data,
        format: "arrow_ipc",
        namespace: "lessons",
        scope: { tenantId: "tenant-a" }, // spoof attempt
        merge_strategy: "upsert",
      }
    );
    expect(importRes.status).toBe(200);

    // Every put recorded since the import started must carry tenantId=tenant-b
    // (the AUTHORITATIVE id), never tenant-a.
    const tenantsTouched = new Set(
      memoryService.calls
        .filter((c) => c.op === "put")
        .map((c) => c.scope["tenantId"])
    );
    if (tenantsTouched.size > 0) {
      expect(tenantsTouched.has("tenant-a")).toBe(false);
      expect(tenantsTouched.has("tenant-b")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Analytics: spoofed scope cannot read another tenant's frame
// ---------------------------------------------------------------------------

describe("Memory analytics — tenant isolation (MJ-SEC-04)", () => {
  it.each([
    ["/api/memory/analytics/decay-trends?window=day", "decay-trends"],
    ["/api/memory/analytics/namespace-stats", "namespace-stats"],
    ["/api/memory/analytics/expiring?horizonMs=86400000", "expiring"],
    ["/api/memory/analytics/agent-performance", "agent-performance"],
    ["/api/memory/analytics/usage-patterns?bucketMs=3600000", "usage-patterns"],
    ["/api/memory/analytics/duplicates?prefixLength=50", "duplicates"],
  ])("overrides spoofed scope on %s (%s)", async (endpoint) => {
    const memoryService = createTrackingMemoryService();
    await memoryService.put(
      "lessons",
      { tenantId: "tenant-a", ownerId: "owner-a" },
      "a-1",
      { text: "A1" }
    );
    await memoryService.put(
      "lessons",
      { tenantId: "tenant-b", ownerId: "owner-b" },
      "b-1",
      { text: "B1" }
    );
    memoryService.calls.length = 0;

    const app = createForgeApp(
      createAuthedConfig(memoryService, {
        keys: {
          "token-a": {
            id: "k-a",
            tenantId: "tenant-a",
            ownerId: "owner-a",
            role: "operator",
          },
        },
      })
    );

    // Tenant A queries analytics with spoofed tenant-b/owner-b scope. Even if
    // DuckDB-WASM is not installed, the route invokes arrowMemory.exportFrame()
    // to build the input table. We assert the frame read uses auth-derived
    // scope, regardless of whether analytics ultimately succeeds.
    const spoofed = encodeURIComponent(
      JSON.stringify({ tenantId: "tenant-b", ownerId: "owner-b" })
    );
    const separator = endpoint.includes("?") ? "&" : "?";
    await reqAuthed(
      app,
      "GET",
      `${endpoint}${separator}namespace=lessons&scope=${spoofed}`,
      "token-a"
    );

    // Include `getKeyed`: analytics builds its input frame through the keyed
    // read, so omitting it leaves `reads` empty and every assertion below
    // passes vacuously — the `toBeGreaterThan(0)` guard exists to catch exactly
    // that, and did.
    const reads = memoryService.calls.filter(
      (c) => c.op === "get" || c.op === "getKeyed" || c.op === "search"
    );
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => c.scope["tenantId"] === "tenant-a")).toBe(true);
    expect(reads.every((c) => c.scope["ownerId"] === "owner-a")).toBe(true);
    expect(reads.some((c) => c.scope["tenantId"] === "tenant-b")).toBe(false);
    expect(reads.some((c) => c.scope["ownerId"] === "owner-b")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SEC-H-07: `namespace` is a partition key beside `scope`
// ---------------------------------------------------------------------------

describe("Memory namespace isolation (SEC-H-07)", () => {
  let memoryService: ReturnType<typeof createTrackingMemoryService>;

  function authedNamespaceConfig(
    allowedNamespaces?: readonly string[]
  ): ForgeServerConfig {
    const config = createAuthedConfig(memoryService, {
      keys: {
        "token-a": { id: "k-a", tenantId: "tenant-a", role: "operator" },
      },
    });
    if (allowedNamespaces) {
      config.memoryTenantScope = { allowedNamespaces };
    }
    return config;
  }

  beforeEach(async () => {
    memoryService = createTrackingMemoryService();
    await memoryService.put("lessons", { tenantId: "tenant-a" }, "a-1", {
      text: "A1",
    });
    await memoryService.put("secrets", { tenantId: "tenant-a" }, "s-1", {
      text: "SECRET",
    });
  });

  it("rejects an export addressing a namespace outside the allowlist", async () => {
    const app = createForgeApp(authedNamespaceConfig(["lessons"]));

    const res = await reqAuthed(app, "POST", "/api/memory/export", "token-a", {
      namespace: "secrets",
      scope: {},
      format: "json",
      limit: 100,
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NAMESPACE_NOT_ALLOWED");
    // The rejection must happen BEFORE the store is READ. Seeding in
    // beforeEach uses `put`, so filter to reads rather than asserting the
    // namespace is absent from `calls` entirely.
    expect(
      memoryService.calls.some(
        (c) => c.namespace === "secrets" && c.op !== "put"
      )
    ).toBe(false);
  });

  it("rejects an import writing into a namespace outside the allowlist", async () => {
    const app = createForgeApp(authedNamespaceConfig(["lessons"]));

    // Round-trip a REAL export payload: a malformed body short-circuits as
    // `invalid_payload` (HTTP 200) before importFrame is ever reached, which
    // would make this test pass vacuously against a missing guard.
    const exportRes = await reqAuthed(
      app,
      "POST",
      "/api/memory/export",
      "token-a",
      { namespace: "lessons", scope: {}, format: "arrow_ipc", limit: 100 }
    );
    expect(exportRes.status).toBe(200);
    const exportBody = (await exportRes.json()) as {
      data: { data: string; record_count: number };
    };
    expect(exportBody.data.record_count).toBeGreaterThan(0);

    memoryService.calls.length = 0;

    const res = await reqAuthed(app, "POST", "/api/memory/import", "token-a", {
      namespace: "secrets",
      scope: {},
      format: "arrow_ipc",
      data: exportBody.data.data,
      merge_strategy: "upsert",
    });

    expect(res.status).toBe(403);
    expect(
      memoryService.calls.some(
        (c) => c.op === "put" && c.namespace === "secrets"
      )
    ).toBe(false);
  });

  it("rejects an analytics query addressing a disallowed namespace", async () => {
    const app = createForgeApp(authedNamespaceConfig(["lessons"]));

    const res = await reqAuthed(
      app,
      "GET",
      "/api/memory/analytics/namespace-stats?namespace=secrets",
      "token-a"
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NAMESPACE_NOT_ALLOWED");
  });

  it("allows a namespace that IS on the allowlist", async () => {
    const app = createForgeApp(authedNamespaceConfig(["lessons"]));

    const res = await reqAuthed(app, "POST", "/api/memory/export", "token-a", {
      namespace: "lessons",
      scope: {},
      format: "json",
      limit: 100,
    });

    expect(res.status).toBe(200);
    // Guard against a vacuous pass: prove the allowed namespace really
    // reached the store rather than being short-circuited.
    expect(memoryService.calls.some((c) => c.namespace === "lessons")).toBe(
      true
    );
  });

  it("rejects a browse addressing a namespace outside the allowlist", async () => {
    const app = createForgeApp(authedNamespaceConfig(["lessons"]));
    memoryService.calls.length = 0;

    const res = await reqAuthed(
      app,
      "GET",
      "/api/memory-browse/secrets",
      "token-a"
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NAMESPACE_NOT_ALLOWED");
    // The namespace arrives as a URL path segment and flows straight into the
    // store, so prove the read never happened rather than only checking status.
    expect(memoryService.calls.some((c) => c.namespace === "secrets")).toBe(
      false
    );
  });

  it("rejects a browse SEARCH addressing a disallowed namespace", async () => {
    const app = createForgeApp(authedNamespaceConfig(["lessons"]));
    memoryService.calls.length = 0;

    const res = await reqAuthed(
      app,
      "GET",
      "/api/memory-browse/secrets?search=SECRET",
      "token-a"
    );

    expect(res.status).toBe(403);
    expect(memoryService.calls.some((c) => c.namespace === "secrets")).toBe(
      false
    );
  });

  it("allows a browse of a namespace that IS on the allowlist", async () => {
    const app = createForgeApp(authedNamespaceConfig(["lessons"]));
    memoryService.calls.length = 0;

    const res = await reqAuthed(
      app,
      "GET",
      "/api/memory-browse/lessons",
      "token-a"
    );

    expect(res.status).toBe(200);
    // Guard against a vacuous pass: prove the allowed namespace really reached
    // the store rather than being short-circuited by the new guard.
    expect(memoryService.calls.some((c) => c.namespace === "lessons")).toBe(
      true
    );
  });

  it("allows any browse namespace when no allowlist is configured", async () => {
    const app = createForgeApp(authedNamespaceConfig());
    memoryService.calls.length = 0;

    const res = await reqAuthed(
      app,
      "GET",
      "/api/memory-browse/secrets",
      "token-a"
    );

    expect(res.status).toBe(200);
    expect(memoryService.calls.some((c) => c.namespace === "secrets")).toBe(
      true
    );
  });

  it("allows any namespace when no allowlist is configured (single-tenant)", async () => {
    const app = createForgeApp(authedNamespaceConfig());

    const res = await reqAuthed(app, "POST", "/api/memory/export", "token-a", {
      namespace: "secrets",
      scope: {},
      format: "json",
      limit: 100,
    });

    expect(res.status).toBe(200);
    expect(memoryService.calls.some((c) => c.namespace === "secrets")).toBe(
      true
    );
  });
});
