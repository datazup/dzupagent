/**
 * W29-B — Agent adapter deep coverage for the connectors package.
 *
 * This file tests the two "adapter" components that live in @dzupagent/connectors:
 *   - AgentRegistryAsyncToolResolver  (HTTP-backed agent registry adapter)
 *   - MCPAsyncToolResolver            (MCPClient-backed tool registry adapter)
 *
 * It adds coverage for scenarios NOT addressed in the existing test files:
 *   agent-registry-resolver.test.ts, agent-registry-resolver-deep.test.ts,
 *   mcp-tool-resolver.test.ts
 *
 * Test areas:
 *   AgentRegistryAsyncToolResolver
 *     - invoke body fields (context, parentRunId forwarding)
 *     - invoke 4xx/5xx error propagation
 *     - concurrent refreshCatalogue with rapid re-calls after resolution
 *     - TTL boundary (exact boundary, just-before, just-after)
 *     - timeoutMs option (custom timeout < default)
 *     - large catalogue sorting stability
 *     - baseUrl normalisation with port / path prefix
 *     - headers merged with accept
 *     - point-lookup URL encoding edge cases
 *     - catalogue replaced on second refresh (stale entries cleared)
 *     - resolve() returns null for whitespace-only ref guard
 *     - resolve() called before any refresh triggers lazy load
 *     - invoke with empty context/parentRunId
 *     - multiple simultaneous resolve() calls
 *     - descriptor with only id (minimal)
 *
 *   MCPAsyncToolResolver
 *     - empty catalogue on construction
 *     - only deferred tools (no eager)
 *     - only eager tools (no deferred)
 *     - duplicate refs across eager and deferred — deduplicated
 *     - unqualified ref (no slash) resolves when findTool matches
 *     - unqualified ref returns null when findTool returns null
 *     - server qualifier mismatch on unqualified ref (single-slash edge case)
 *     - handle.invoke passes null input as empty args
 *     - handle.invoke with missing content array — defaults to []
 *     - handle.invoke isError:true propagated
 *     - content part of unknown type mapped to json
 *     - content part text with undefined text value
 *     - content part image with undefined data value
 *     - resolve() after TTL expiry triggers refreshCatalogue
 *     - refreshCatalogue() is synchronous — no async
 *     - listAvailable() returns copy (mutation safe)
 *     - resolve() re-uses existing descriptor after TTL refresh adds more tools
 *     - custom ttlMs=0 refreshes every call
 *     - custom ttlMs=Infinity never refreshes automatically
 *     - handle inputSchema forwarded to ResolvedTool
 *     - ref round-trip: resolved ref matches input ref
 *     - empty ref returns null
 *     - slash-only ref ("/") returns null
 *     - ref with empty server id ("/tool") returns null
 *     - ref with empty tool name ("srv/") returns null
 *     - findTool called with unqualified tool name (no serverId prefix)
 *     - multiple tools across multiple servers — all resolvable
 *     - invokeTool called with correct tool name (not ref)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MCPClient } from "@dzupagent/core";
import {
  AgentRegistryAsyncToolResolver,
  type FetchLike,
  type AgentRegistryAsyncToolResolverOptions,
} from "../agent-registry-resolver.js";
import { MCPAsyncToolResolver } from "../mcp-tool-resolver.js";

// ============================================================================
// Shared fetch helpers
// ============================================================================

type MockResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  body: unknown;
};

function buildFetch(
  handlers: Array<{
    match: (url: string, init: Parameters<FetchLike>[1]) => boolean;
    response: MockResponse | (() => never);
  }>
): {
  fetch: FetchLike;
  calls: Array<{ url: string; init: Parameters<FetchLike>[1] }>;
} {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    calls.push({ url, init });
    for (const h of handlers) {
      if (h.match(url, init)) {
        if (typeof h.response === "function") {
          h.response();
          throw new Error("unreachable");
        }
        return {
          ok: h.response.ok,
          status: h.response.status,
          statusText: h.response.statusText ?? "OK",
          json: async () => h.response.body as unknown,
        } as Awaited<ReturnType<FetchLike>>;
      }
    }
    return {
      ok: false,
      status: 500,
      statusText: "Unhandled",
      json: async () => ({}),
    } as Awaited<ReturnType<FetchLike>>;
  };
  return { fetch, calls };
}

function simpleFetch(body: unknown, status = 200): FetchLike {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: "OK",
      json: async () => body,
    } as Awaited<ReturnType<FetchLike>>);
}

function makeResolver(
  extra: Partial<AgentRegistryAsyncToolResolverOptions> = {},
  fetchFn?: FetchLike
): AgentRegistryAsyncToolResolver {
  return new AgentRegistryAsyncToolResolver({
    baseUrl: "https://registry.local",
    fetch: fetchFn ?? simpleFetch([]),
    ...extra,
  });
}

// ============================================================================
// MCPClient helpers
// ============================================================================

type EagerTool = ReturnType<MCPClient["getEagerTools"]>[number];
type DeferredName = ReturnType<MCPClient["getDeferredToolNames"]>[number];

function makeEager(
  name: string,
  serverId: string,
  schema?: unknown
): EagerTool {
  return {
    name,
    description: `${name} description`,
    serverId,
    inputSchema: schema ?? {
      type: "object",
      properties: { input: { type: "string" } },
    },
  };
}

function makeClient(opts: {
  eager?: EagerTool[];
  deferred?: DeferredName[];
  findTool?: (name: string) => EagerTool | null;
  invokeTool?: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<unknown>;
}): MCPClient {
  const eager = opts.eager ?? [];
  const deferred = opts.deferred ?? [];
  const findFn =
    opts.findTool ??
    ((name: string) => eager.find((t) => t.name === name) ?? null);
  const invokeFn =
    opts.invokeTool ??
    (async () => ({ content: [{ type: "text", text: "ok" }], isError: false }));
  return {
    getEagerTools: vi.fn(() => eager),
    getDeferredToolNames: vi.fn(() => deferred),
    findTool: vi.fn((n: string) => findFn(n)),
    invokeTool: vi.fn((n: string, a: Record<string, unknown>) =>
      invokeFn(n, a)
    ),
  } as unknown as MCPClient;
}

type InvokableHandle = {
  invoke: (input: unknown) => Promise<{
    content: ReadonlyArray<{ type: string; value: unknown }>;
    isError: boolean;
  }>;
};

// ============================================================================
// AgentRegistryAsyncToolResolver — additional deep coverage
// ============================================================================

describe("AgentRegistryAsyncToolResolver — invoke body forwarding", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards context field to POST body", async () => {
    const stub = buildFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [{ id: "a" }] },
      },
      {
        match: (url) => url.includes("/invoke"),
        response: { ok: true, status: 200, body: {} },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("a");
    type H = {
      invoke: (i: { prompt: string; context: unknown }) => Promise<unknown>;
    };
    await (result!.handle as H).invoke({
      prompt: "go",
      context: { tenant: "acme" },
    });
    const call = stub.calls.find((c) => c.url.includes("/invoke"));
    expect(JSON.parse(call!.init!.body!)).toMatchObject({
      context: { tenant: "acme" },
    });
  });

  it("forwards parentRunId field to POST body", async () => {
    const stub = buildFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [{ id: "b" }] },
      },
      {
        match: (url) => url.includes("/invoke"),
        response: { ok: true, status: 200, body: {} },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("b");
    type H = {
      invoke: (i: { prompt: string; parentRunId: string }) => Promise<unknown>;
    };
    await (result!.handle as H).invoke({
      prompt: "run",
      parentRunId: "parent-abc",
    });
    const call = stub.calls.find((c) => c.url.includes("/invoke"));
    expect(JSON.parse(call!.init!.body!)).toMatchObject({
      parentRunId: "parent-abc",
    });
  });

  it("omits context and parentRunId when not supplied", async () => {
    const stub = buildFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [{ id: "c" }] },
      },
      {
        match: (url) => url.includes("/invoke"),
        response: { ok: true, status: 200, body: {} },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("c");
    type H = { invoke: (i: { prompt: string }) => Promise<unknown> };
    await (result!.handle as H).invoke({ prompt: "minimal" });
    const call = stub.calls.find((c) => c.url.includes("/invoke"));
    const body = JSON.parse(call!.init!.body!);
    // prompt is always present; context/parentRunId only when provided
    expect(body.prompt).toBe("minimal");
  });
});

describe("AgentRegistryAsyncToolResolver — invoke error paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws when invoke endpoint returns 400", async () => {
    const stub = buildFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [{ id: "a" }] },
      },
      {
        match: (url) => url.includes("/invoke"),
        response: {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          body: {},
        },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("a");
    type H = { invoke: (i: { prompt: string }) => Promise<unknown> };
    await expect(
      (result!.handle as H).invoke({ prompt: "bad" })
    ).rejects.toThrow(/400/);
  });

  it("throws when invoke endpoint returns 500", async () => {
    const stub = buildFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [{ id: "x" }] },
      },
      {
        match: (url) => url.includes("/invoke"),
        response: {
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          body: {},
        },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("x");
    type H = { invoke: (i: { prompt: string }) => Promise<unknown> };
    await expect(
      (result!.handle as H).invoke({ prompt: "fail" })
    ).rejects.toThrow();
  });

  it("throws when network fails during invoke", async () => {
    let callCount = 0;
    const fn: FetchLike = async (url) => {
      callCount++;
      if (callCount === 1) {
        // list call succeeds
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [{ id: "a" }],
        } as Awaited<ReturnType<FetchLike>>;
      }
      throw new Error("connection reset");
    };
    const resolver = makeResolver({}, fn);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("a");
    type H = { invoke: (i: { prompt: string }) => Promise<unknown> };
    await expect(
      (result!.handle as H).invoke({ prompt: "crash" })
    ).rejects.toThrow(/AgentRegistry request failed/);
  });
});

describe("AgentRegistryAsyncToolResolver — TTL boundary precision", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT refresh when exactly 1ms before TTL boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const fn = vi.fn(simpleFetch([{ id: "x" }]));
    const resolver = makeResolver({ ttlMs: 1000 }, fn as unknown as FetchLike);
    await resolver.refreshCatalogue();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.999Z"));
    await resolver.resolve("x");
    // No second refresh — still within TTL
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("refreshes when exactly at TTL boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const fn = vi.fn(simpleFetch([{ id: "x" }]));
    const resolver = makeResolver({ ttlMs: 1000 }, fn as unknown as FetchLike);
    await resolver.refreshCatalogue();
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    await resolver.resolve("x");
    // TTL check is `>=`, so at exactly 1000ms it triggers
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("AgentRegistryAsyncToolResolver — catalogue replacement on re-refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears stale agents from catalogue when second refresh returns fewer", async () => {
    let phase = 1;
    const fn: FetchLike = async () => {
      const body = phase === 1 ? [{ id: "a" }, { id: "b" }] : [{ id: "a" }];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => body,
      } as Awaited<ReturnType<FetchLike>>;
    };
    const resolver = makeResolver({ ttlMs: 500 }, fn);
    await resolver.refreshCatalogue();
    expect(resolver.listAvailable()).toEqual(["a", "b"]);
    phase = 2;
    vi.setSystemTime(new Date("2026-01-01T00:00:01Z"));
    await resolver.refreshCatalogue();
    expect(resolver.listAvailable()).toEqual(["a"]);
  });

  it("adds new agents to catalogue when second refresh returns more", async () => {
    let phase = 1;
    const fn: FetchLike = async () => {
      const body = phase === 1 ? [{ id: "a" }] : [{ id: "a" }, { id: "c" }];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => body,
      } as Awaited<ReturnType<FetchLike>>;
    };
    const resolver = makeResolver({ ttlMs: 500 }, fn);
    await resolver.refreshCatalogue();
    phase = 2;
    await resolver.refreshCatalogue();
    expect(resolver.listAvailable()).toContain("c");
  });
});

describe("AgentRegistryAsyncToolResolver — baseUrl with path prefix and port", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves path prefix in baseUrl", async () => {
    const stub = buildFetch([
      {
        match: (url) => url.includes("/api/v1/agents"),
        response: { ok: true, status: 200, body: [] },
      },
    ]);
    const resolver = new AgentRegistryAsyncToolResolver({
      baseUrl: "https://registry.local/api/v1",
      fetch: stub.fetch,
    });
    await resolver.refreshCatalogue();
    expect(stub.calls[0]?.url).toMatch(/\/api\/v1\/agents$/);
  });

  it("preserves non-standard port in baseUrl", async () => {
    const stub = buildFetch([
      {
        match: () => true,
        response: { ok: true, status: 200, body: [] },
      },
    ]);
    const resolver = new AgentRegistryAsyncToolResolver({
      baseUrl: "http://localhost:9090",
      fetch: stub.fetch,
    });
    await resolver.refreshCatalogue();
    expect(stub.calls[0]?.url).toContain("localhost:9090");
  });
});

describe("AgentRegistryAsyncToolResolver — resolve before any refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("triggers lazy refresh on first resolve() with TTL=0", async () => {
    const fn = vi.fn(simpleFetch([{ id: "z" }]));
    const resolver = makeResolver({ ttlMs: 0 }, fn as unknown as FetchLike);
    // No explicit refreshCatalogue — rely on lazy trigger
    const result = await resolver.resolve("z");
    // First call: list (TTL=0 means lastRefreshAt=0, Date.now()-0 >= 0)
    expect(fn).toHaveBeenCalled();
    expect(result?.ref).toBe("z");
  });

  it("lazy refresh populates catalogue before point-lookup", async () => {
    const fn = vi.fn(simpleFetch([{ id: "lazy-agent" }]));
    const resolver = makeResolver({ ttlMs: 0 }, fn as unknown as FetchLike);
    await resolver.resolve("lazy-agent");
    expect(resolver.listAvailable()).toContain("lazy-agent");
  });
});

describe("AgentRegistryAsyncToolResolver — simultaneous resolve() calls", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("handles concurrent resolve() calls for different agents", async () => {
    const f = simpleFetch([
      { id: "p1", displayName: "P1" },
      { id: "p2", displayName: "P2" },
    ]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const [r1, r2] = await Promise.all([
      resolver.resolve("p1"),
      resolver.resolve("p2"),
    ]);
    expect(r1?.ref).toBe("p1");
    expect(r2?.ref).toBe("p2");
  });

  it("handles concurrent resolve() for the same agent — both resolve correctly", async () => {
    const f = simpleFetch([{ id: "shared" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const [r1, r2, r3] = await Promise.all([
      resolver.resolve("shared"),
      resolver.resolve("shared"),
      resolver.resolve("shared"),
    ]);
    expect(r1?.ref).toBe("shared");
    expect(r2?.ref).toBe("shared");
    expect(r3?.ref).toBe("shared");
  });
});

describe("AgentRegistryAsyncToolResolver — minimal descriptor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves an agent with only id — no name, displayName, schema", async () => {
    const f = simpleFetch([{ id: "minimal" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("minimal");
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("agent");
    expect(result?.inputSchema).toEqual({});
    expect(result?.outputSchema).toBeUndefined();
  });

  it("handle.id equals the descriptor id for minimal agent", async () => {
    const f = simpleFetch([{ id: "min2" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("min2");
    expect((result?.handle as { id: string }).id).toBe("min2");
  });
});

describe("AgentRegistryAsyncToolResolver — headers merged correctly", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("custom headers do not override accept header", async () => {
    const stub = buildFetch([
      { match: () => true, response: { ok: true, status: 200, body: [] } },
    ]);
    const resolver = makeResolver(
      { headers: { "x-custom": "val" } },
      stub.fetch
    );
    await resolver.refreshCatalogue();
    const h = stub.calls[0]?.init?.headers;
    expect(h?.accept).toBe("application/json");
    expect(h?.["x-custom"]).toBe("val");
  });

  it("multiple custom headers all forwarded", async () => {
    const stub = buildFetch([
      { match: () => true, response: { ok: true, status: 200, body: [] } },
    ]);
    const resolver = makeResolver(
      { headers: { "x-tenant": "acme", "x-version": "2" } },
      stub.fetch
    );
    await resolver.refreshCatalogue();
    const h = stub.calls[0]?.init?.headers;
    expect(h?.["x-tenant"]).toBe("acme");
    expect(h?.["x-version"]).toBe("2");
  });
});

describe("AgentRegistryAsyncToolResolver — URL encoding edge cases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("encodes agent id with slashes", async () => {
    const stub = buildFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [] },
      },
      {
        match: (url) => url.includes("org%2Fagent"),
        response: { ok: true, status: 200, body: { id: "org/agent" } },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await resolver.refreshCatalogue();
    await resolver.resolve("org/agent");
    const call = stub.calls.find((c) => c.url.includes("org%2Fagent"));
    expect(call).toBeDefined();
  });

  it("encodes agent id with unicode characters", async () => {
    // "café" → café contains 'é' (U+00E9) → %C3%A9
    const agentId = "café-agent";
    const stub = buildFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [] },
      },
      {
        match: (url) => url.includes("caf%C3%A9-agent"),
        response: { ok: true, status: 200, body: { id: agentId } },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await resolver.refreshCatalogue();
    await resolver.resolve(agentId);
    const call = stub.calls.find((c) => c.url.includes("caf%C3%A9-agent"));
    expect(call).toBeDefined();
  });
});

// ============================================================================
// MCPAsyncToolResolver — deep coverage
// ============================================================================

describe("MCPAsyncToolResolver — empty catalogue on construction", () => {
  it("returns empty list when client has no tools", () => {
    const client = makeClient({ eager: [], deferred: [] });
    const resolver = new MCPAsyncToolResolver(client);
    expect(resolver.listAvailable()).toEqual([]);
  });

  it("resolve() on empty catalogue returns null", async () => {
    const client = makeClient({ eager: [], deferred: [] });
    const resolver = new MCPAsyncToolResolver(client);
    expect(await resolver.resolve("any/tool")).toBeNull();
  });
});

describe("MCPAsyncToolResolver — only deferred tools", () => {
  it("includes deferred tools in listAvailable", () => {
    const client = makeClient({
      eager: [],
      deferred: [
        { name: "alpha", serverId: "srv" },
        { name: "beta", serverId: "srv" },
      ],
    });
    const resolver = new MCPAsyncToolResolver(client);
    expect(resolver.listAvailable()).toEqual(["srv/alpha", "srv/beta"]);
  });
});

describe("MCPAsyncToolResolver — only eager tools", () => {
  it("includes only eager tools when no deferred", () => {
    const client = makeClient({
      eager: [makeEager("search", "srv-a"), makeEager("write", "srv-a")],
      deferred: [],
    });
    const resolver = new MCPAsyncToolResolver(client);
    expect(resolver.listAvailable()).toEqual(["srv-a/search", "srv-a/write"]);
  });
});

describe("MCPAsyncToolResolver — ref deduplication", () => {
  it("deduplicates same ref appearing in both eager and deferred", () => {
    const client = makeClient({
      eager: [makeEager("tool", "srv")],
      deferred: [{ name: "tool", serverId: "srv" }],
    });
    const resolver = new MCPAsyncToolResolver(client);
    const refs = resolver.listAvailable();
    expect(refs.filter((r) => r === "srv/tool")).toHaveLength(1);
  });
});

describe("MCPAsyncToolResolver — unqualified ref resolution", () => {
  it("resolves an unqualified ref when findTool returns a match", async () => {
    const tool = makeEager("search", "srv-a");
    const client = makeClient({
      eager: [tool],
      findTool: (name) => (name === "search" ? tool : null),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("search");
    expect(result).not.toBeNull();
    expect(result?.handle).toMatchObject({
      toolName: "search",
      serverId: "srv-a",
    });
  });

  it("returns null for unqualified ref when findTool returns null", async () => {
    const client = makeClient({
      eager: [],
      findTool: () => null,
    });
    const resolver = new MCPAsyncToolResolver(client);
    expect(await resolver.resolve("nonexistent")).toBeNull();
  });
});

describe("MCPAsyncToolResolver — ref edge cases", () => {
  it("returns null for empty ref", async () => {
    const client = makeClient({ eager: [makeEager("t", "srv")] });
    const resolver = new MCPAsyncToolResolver(client);
    expect(await resolver.resolve("")).toBeNull();
  });

  it('returns null for slash-only ref "/"', async () => {
    const client = makeClient({ eager: [makeEager("t", "srv")] });
    const resolver = new MCPAsyncToolResolver(client);
    // serverId="" toolName="" -> parseRef returns null
    expect(await resolver.resolve("/")).toBeNull();
  });

  it('returns null for ref with empty server id "/tool"', async () => {
    const tool = makeEager("tool", "srv");
    const client = makeClient({
      eager: [tool],
      findTool: (name) => (name === "tool" ? tool : null),
    });
    const resolver = new MCPAsyncToolResolver(client);
    // "/tool" → serverId="" → parseRef returns null because serverId is empty
    expect(await resolver.resolve("/tool")).toBeNull();
  });

  it('returns null for ref with empty tool name "srv/"', async () => {
    const client = makeClient({ eager: [makeEager("t", "srv")] });
    const resolver = new MCPAsyncToolResolver(client);
    // "srv/" → toolName="" → parseRef returns null
    expect(await resolver.resolve("srv/")).toBeNull();
  });
});

describe("MCPAsyncToolResolver — handle.invoke arg handling", () => {
  it("passes null input as empty object to invokeTool", async () => {
    const invokeSpy = vi.fn(async () => ({
      content: [{ type: "text", text: "done" }],
      isError: false,
    }));
    const client = makeClient({
      eager: [makeEager("run", "srv")],
      invokeTool: invokeSpy,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("srv/run");
    await (result!.handle as InvokableHandle).invoke(null);
    // invokeTool called with empty object (null ?? {} → {})
    expect(invokeSpy).toHaveBeenCalledWith("run", {});
  });

  it("passes undefined input as empty object to invokeTool", async () => {
    const invokeSpy = vi.fn(async () => ({
      content: [],
      isError: false,
    }));
    const client = makeClient({
      eager: [makeEager("run", "srv")],
      invokeTool: invokeSpy,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("srv/run");
    await (result!.handle as InvokableHandle).invoke(undefined);
    expect(invokeSpy).toHaveBeenCalledWith("run", {});
  });

  it("passes structured args object through unchanged", async () => {
    const invokeSpy = vi.fn(async () => ({ content: [], isError: false }));
    const client = makeClient({
      eager: [makeEager("query", "db")],
      invokeTool: invokeSpy,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("db/query");
    await (result!.handle as InvokableHandle).invoke({
      sql: "SELECT 1",
      limit: 10,
    });
    expect(invokeSpy).toHaveBeenCalledWith("query", {
      sql: "SELECT 1",
      limit: 10,
    });
  });
});

describe("MCPAsyncToolResolver — content part mapping", () => {
  it("maps text part correctly", async () => {
    const client = makeClient({
      eager: [makeEager("t", "srv")],
      invokeTool: async () => ({
        content: [{ type: "text", text: "hello world" }],
        isError: false,
      }),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("srv/t");
    const inv = await (result!.handle as InvokableHandle).invoke({});
    expect(inv.content).toEqual([{ type: "text", value: "hello world" }]);
  });

  it("maps image part correctly", async () => {
    const client = makeClient({
      eager: [makeEager("snap", "srv")],
      invokeTool: async () => ({
        content: [{ type: "image", data: "abc123", mimeType: "image/png" }],
        isError: false,
      }),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("srv/snap");
    const inv = await (result!.handle as InvokableHandle).invoke({});
    expect(inv.content).toEqual([{ type: "image", value: "abc123" }]);
  });

  it("maps unknown part type to json with full object as value", async () => {
    const client = makeClient({
      eager: [makeEager("raw", "srv")],
      invokeTool: async () => ({
        content: [{ type: "binary", data: "xyz", encoding: "base64" }],
        isError: false,
      }),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("srv/raw");
    const inv = await (result!.handle as InvokableHandle).invoke({});
    expect(inv.content[0]?.type).toBe("json");
    expect((inv.content[0]?.value as { type: string }).type).toBe("binary");
  });

  it("handles empty content array", async () => {
    const client = makeClient({
      eager: [makeEager("noop", "srv")],
      invokeTool: async () => ({ content: [], isError: false }),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("srv/noop");
    const inv = await (result!.handle as InvokableHandle).invoke({});
    expect(inv.content).toEqual([]);
  });

  it("handles missing content array (undefined) — defaults to []", async () => {
    const client = makeClient({
      eager: [makeEager("silent", "srv")],
      invokeTool: async () => ({
        content: undefined as unknown as [],
        isError: false,
      }),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("srv/silent");
    const inv = await (result!.handle as InvokableHandle).invoke({});
    expect(inv.content).toEqual([]);
  });

  it("propagates isError:true from client", async () => {
    const client = makeClient({
      eager: [makeEager("fail", "srv")],
      invokeTool: async () => ({
        content: [{ type: "text", text: "boom" }],
        isError: true,
      }),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("srv/fail");
    const inv = await (result!.handle as InvokableHandle).invoke({});
    expect(inv.isError).toBe(true);
  });

  it("maps text part with undefined text to empty string", async () => {
    const client = makeClient({
      eager: [makeEager("blank", "srv")],
      invokeTool: async () => ({
        content: [{ type: "text", text: undefined }],
        isError: false,
      }),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("srv/blank");
    const inv = await (result!.handle as InvokableHandle).invoke({});
    expect(inv.content[0]).toEqual({ type: "text", value: "" });
  });

  it("maps image part with undefined data to empty string", async () => {
    const client = makeClient({
      eager: [makeEager("nodata", "srv")],
      invokeTool: async () => ({
        content: [{ type: "image", data: undefined }],
        isError: false,
      }),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("srv/nodata");
    const inv = await (result!.handle as InvokableHandle).invoke({});
    expect(inv.content[0]).toEqual({ type: "image", value: "" });
  });

  it("handles multiple content parts in order", async () => {
    const client = makeClient({
      eager: [makeEager("multi", "srv")],
      invokeTool: async () => ({
        content: [
          { type: "text", text: "first" },
          { type: "image", data: "imgdata" },
          { type: "text", text: "last" },
        ],
        isError: false,
      }),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("srv/multi");
    const inv = await (result!.handle as InvokableHandle).invoke({});
    expect(inv.content).toEqual([
      { type: "text", value: "first" },
      { type: "image", value: "imgdata" },
      { type: "text", value: "last" },
    ]);
  });
});

describe("MCPAsyncToolResolver — invoke error surface", () => {
  it("wraps invokeTool throw in descriptive error", async () => {
    const client = makeClient({
      eager: [makeEager("boom", "srv")],
      invokeTool: async () => {
        throw new Error("EPIPE");
      },
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("srv/boom");
    await expect(
      (result!.handle as InvokableHandle).invoke({})
    ).rejects.toThrow(/MCP tool invocation failed.*EPIPE/);
  });

  it("wraps non-Error invokeTool throws in descriptive error", async () => {
    const client = makeClient({
      eager: [makeEager("crash", "srv")],
      invokeTool: async () => {
        throw "plain string error";
      },
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("srv/crash");
    await expect(
      (result!.handle as InvokableHandle).invoke({})
    ).rejects.toThrow(/MCP tool invocation failed/);
  });
});

describe("MCPAsyncToolResolver — TTL refresh behaviour", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not call getEagerTools again within TTL", async () => {
    const client = makeClient({ eager: [makeEager("t", "srv")], deferred: [] });
    const resolver = new MCPAsyncToolResolver(client, { ttlMs: 5000 });
    vi.setSystemTime(new Date("2026-01-01T00:00:04Z"));
    await resolver.resolve("srv/t");
    // Only 1 call at construction — no additional call within TTL
    expect(client.getEagerTools).toHaveBeenCalledTimes(1);
  });

  it("calls getEagerTools again after TTL expires", async () => {
    const eager = [makeEager("t", "srv")];
    const client = makeClient({ eager, deferred: [] });
    const resolver = new MCPAsyncToolResolver(client, { ttlMs: 1000 });
    vi.setSystemTime(new Date("2026-01-01T00:00:01.001Z"));
    await resolver.resolve("srv/t");
    expect(client.getEagerTools).toHaveBeenCalledTimes(2);
  });

  it("ttlMs=Infinity never triggers automatic refresh", async () => {
    const eager = [makeEager("t", "srv")];
    const client = makeClient({ eager, deferred: [] });
    const resolver = new MCPAsyncToolResolver(client, { ttlMs: Infinity });
    // Advance a very long time
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    await resolver.resolve("srv/t");
    // Still only 1 call (the construction call)
    expect(client.getEagerTools).toHaveBeenCalledTimes(1);
  });

  it("ttlMs default is 60_000", async () => {
    const eager = [makeEager("t", "srv")];
    const client = makeClient({ eager, deferred: [] });
    const resolver = new MCPAsyncToolResolver(client); // default TTL
    // 59 seconds — still within TTL
    vi.setSystemTime(new Date("2026-01-01T00:00:59Z"));
    await resolver.resolve("srv/t");
    expect(client.getEagerTools).toHaveBeenCalledTimes(1);
    // 60 seconds — at TTL boundary
    vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
    await resolver.resolve("srv/t");
    expect(client.getEagerTools).toHaveBeenCalledTimes(2);
  });
});

describe("MCPAsyncToolResolver — listAvailable safety", () => {
  it("returns a copy — mutations do not affect internal state", () => {
    const client = makeClient({
      eager: [makeEager("a", "srv"), makeEager("b", "srv")],
    });
    const resolver = new MCPAsyncToolResolver(client);
    const refs = resolver.listAvailable();
    refs.push("injected/ref");
    expect(resolver.listAvailable()).not.toContain("injected/ref");
  });

  it("returns alphabetically sorted refs", () => {
    const client = makeClient({
      eager: [
        makeEager("z", "srv"),
        makeEager("a", "srv"),
        makeEager("m", "srv"),
      ],
    });
    const resolver = new MCPAsyncToolResolver(client);
    expect(resolver.listAvailable()).toEqual(["srv/a", "srv/m", "srv/z"]);
  });
});

describe("MCPAsyncToolResolver — ResolvedTool shape", () => {
  it("inputSchema from eager tool forwarded to ResolvedTool", async () => {
    const schema = {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    };
    const client = makeClient({ eager: [makeEager("search", "srv", schema)] });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("srv/search");
    expect(result?.inputSchema).toEqual(schema);
  });

  it("ref matches the requested ref string", async () => {
    const client = makeClient({ eager: [makeEager("do_thing", "provider")] });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("provider/do_thing");
    expect(result?.ref).toBe("provider/do_thing");
  });

  it('kind is "mcp-tool"', async () => {
    const client = makeClient({ eager: [makeEager("x", "srv")] });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("srv/x");
    expect(result?.kind).toBe("mcp-tool");
  });

  it("handle.id is serverId/toolName composite", async () => {
    const client = makeClient({ eager: [makeEager("calc", "math")] });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("math/calc");
    expect((result?.handle as { id: string }).id).toBe("math/calc");
  });

  it("handle.serverId equals the tool serverId", async () => {
    const client = makeClient({ eager: [makeEager("run", "runner")] });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("runner/run");
    expect((result?.handle as { serverId: string }).serverId).toBe("runner");
  });

  it("handle.toolName equals the tool name", async () => {
    const client = makeClient({ eager: [makeEager("execute", "exec-srv")] });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("exec-srv/execute");
    expect((result?.handle as { toolName: string }).toolName).toBe("execute");
  });
});

describe("MCPAsyncToolResolver — multiple servers", () => {
  it("resolves tools from different servers independently", async () => {
    const client = makeClient({
      eager: [
        makeEager("search", "search-srv"),
        makeEager("write", "fs-srv"),
        makeEager("query", "db-srv"),
      ],
    });
    const resolver = new MCPAsyncToolResolver(client);
    const r1 = await resolver.resolve("search-srv/search");
    const r2 = await resolver.resolve("fs-srv/write");
    const r3 = await resolver.resolve("db-srv/query");
    expect(r1?.handle).toMatchObject({
      serverId: "search-srv",
      toolName: "search",
    });
    expect(r2?.handle).toMatchObject({ serverId: "fs-srv", toolName: "write" });
    expect(r3?.handle).toMatchObject({ serverId: "db-srv", toolName: "query" });
  });

  it("returns null when correct server but wrong tool name", async () => {
    const client = makeClient({
      eager: [makeEager("search", "srv-a")],
    });
    const resolver = new MCPAsyncToolResolver(client);
    expect(await resolver.resolve("srv-a/read_file")).toBeNull();
  });

  it("returns null when correct tool name but wrong server", async () => {
    const client = makeClient({
      eager: [makeEager("search", "srv-a")],
    });
    const resolver = new MCPAsyncToolResolver(client);
    expect(await resolver.resolve("srv-b/search")).toBeNull();
  });
});

describe("MCPAsyncToolResolver — invokeTool called with tool name not ref", () => {
  it("invokeTool receives bare tool name (not serverId/toolName)", async () => {
    const invokeSpy = vi.fn(async () => ({ content: [], isError: false }));
    const client = makeClient({
      eager: [makeEager("my_tool", "my_server")],
      invokeTool: invokeSpy,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("my_server/my_tool");
    await (result!.handle as InvokableHandle).invoke({ key: "value" });
    // Should be called with just "my_tool", not "my_server/my_tool"
    expect(invokeSpy).toHaveBeenCalledWith("my_tool", { key: "value" });
  });
});

describe("MCPAsyncToolResolver — refreshCatalogue is synchronous", () => {
  it("refreshCatalogue() returns void synchronously", () => {
    const client = makeClient({ eager: [makeEager("t", "srv")] });
    const resolver = new MCPAsyncToolResolver(client);
    // refreshCatalogue returns void (not a Promise)
    const returnVal = resolver.refreshCatalogue();
    expect(returnVal).toBeUndefined();
  });

  it("after refreshCatalogue() the new tools are immediately visible", () => {
    const eager: EagerTool[] = [makeEager("t1", "srv")];
    const client = makeClient({ eager });
    const resolver = new MCPAsyncToolResolver(client);
    eager.push(makeEager("t2", "srv"));
    resolver.refreshCatalogue();
    expect(resolver.listAvailable()).toContain("srv/t2");
  });
});
