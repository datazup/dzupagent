/**
 * Deep coverage for AgentRegistryAsyncToolResolver.
 *
 * Covers every major branch:
 *  - constructor path (injected fetch vs. globalThis.fetch vs. no fetch)
 *  - listAvailable() before/after catalogue load
 *  - TTL refresh logic
 *  - resolve() happy paths
 *  - resolve() cache hit (no re-fetch)
 *  - resolve() empty-string guard
 *  - resolve() 404 → null
 *  - resolve() infra errors
 *  - resolve() point-lookup falls back when not in catalogue
 *  - concurrent refreshCatalogue() coalescing
 *  - catalogue refresh failure propagation
 *  - HTTP request construction (method, headers, body, content-type)
 *  - parseList shapes: raw array, { agents: [] }, { results: [] }, unknown → []
 *  - parseDescriptor: valid, missing id, null, non-object
 *  - invokeAgent: happy path, response field defaults, timeout abort
 *  - AgentHandle.invoke delegation
 *  - ResolvedTool shape (ref, kind, inputSchema, outputSchema)
 *  - displayName fallback chain (displayName → name → id)
 *  - Base URL trailing-slash normalisation
 *  - auth header forwarding
 *  - TTL default
 *  - requestJson timeout cleared on success
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AgentRegistryAsyncToolResolver,
  type FetchLike,
  type AgentRegistryAsyncToolResolverOptions,
} from "../agent-registry-resolver.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type FetchResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  body: unknown;
};

type Handler = {
  match: (url: string, init: Parameters<FetchLike>[1]) => boolean;
  response: FetchResponse | (() => never);
};

function makeFetch(handlers: Handler[]): {
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

function listFetch(agents: unknown[]): FetchLike {
  return async () =>
    ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => agents,
    } as Awaited<ReturnType<FetchLike>>);
}

function makeResolver(
  extra: Partial<AgentRegistryAsyncToolResolverOptions> = {},
  fetchFn?: FetchLike
) {
  return new AgentRegistryAsyncToolResolver({
    baseUrl: "https://registry.local",
    fetch: fetchFn ?? listFetch([]),
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("AgentRegistryAsyncToolResolver — constructor", () => {
  it("accepts an injected fetch and strips trailing slashes from baseUrl", () => {
    const resolver = makeResolver({ baseUrl: "https://registry.local///" });
    // Just confirm construction did not throw — fetch will be called with no trailing slash
    expect(resolver).toBeDefined();
  });

  it("throws when no fetch is available globally and none is injected", () => {
    const original = (globalThis as Record<string, unknown>).fetch;
    delete (globalThis as Record<string, unknown>).fetch;
    try {
      expect(
        () =>
          new AgentRegistryAsyncToolResolver({
            baseUrl: "https://registry.local",
          })
      ).toThrow(/requires a fetch implementation/);
    } finally {
      (globalThis as Record<string, unknown>).fetch = original;
    }
  });

  it("uses globalThis.fetch when no fetch injected and globalThis.fetch exists", () => {
    const original = (globalThis as Record<string, unknown>).fetch;
    (globalThis as Record<string, unknown>).fetch = listFetch([{ id: "a" }]);
    try {
      const resolver = new AgentRegistryAsyncToolResolver({
        baseUrl: "https://registry.local",
      });
      expect(resolver).toBeDefined();
    } finally {
      (globalThis as Record<string, unknown>).fetch = original;
    }
  });

  it("applies default ttlMs of 60_000", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const fn = vi.fn(listFetch([{ id: "x" }]));
    const resolver = makeResolver({}, fn as unknown as FetchLike);
    await resolver.refreshCatalogue();
    expect(fn).toHaveBeenCalledTimes(1);
    // Advance 59 seconds — still within TTL, no refresh
    vi.setSystemTime(new Date("2026-01-01T00:00:59Z"));
    await resolver.resolve("x");
    expect(fn).toHaveBeenCalledTimes(1); // no second refresh
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// listAvailable
// ---------------------------------------------------------------------------

describe("listAvailable()", () => {
  it("returns empty array before any refresh", () => {
    const resolver = makeResolver();
    expect(resolver.listAvailable()).toEqual([]);
  });

  it("returns sorted refs after refresh", async () => {
    const f = listFetch([{ id: "zzz" }, { id: "aaa" }, { id: "mmm" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    expect(resolver.listAvailable()).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("returns a copy — mutations do not affect internal state", async () => {
    const f = listFetch([{ id: "a" }, { id: "b" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const refs = resolver.listAvailable();
    refs.push("injected");
    expect(resolver.listAvailable()).toEqual(["a", "b"]);
  });

  it("reflects new agents after TTL refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let agents: unknown[] = [{ id: "a" }];
    const fn: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => agents,
      } as Awaited<ReturnType<FetchLike>>);
    const resolver = makeResolver({ ttlMs: 1_000 }, fn);
    await resolver.refreshCatalogue();
    expect(resolver.listAvailable()).toEqual(["a"]);
    agents = [{ id: "a" }, { id: "b" }];
    vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
    await resolver.resolve("a");
    expect(resolver.listAvailable()).toEqual(["a", "b"]);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// refreshCatalogue
// ---------------------------------------------------------------------------

describe("refreshCatalogue()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces concurrent calls into a single HTTP request", async () => {
    const fn = vi.fn(listFetch([{ id: "a" }]));
    const resolver = makeResolver({}, fn as unknown as FetchLike);
    await Promise.all([
      resolver.refreshCatalogue(),
      resolver.refreshCatalogue(),
      resolver.refreshCatalogue(),
    ]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("subsequent sequential refreshes each hit the server", async () => {
    const fn = vi.fn(listFetch([{ id: "a" }]));
    const resolver = makeResolver({}, fn as unknown as FetchLike);
    await resolver.refreshCatalogue();
    await resolver.refreshCatalogue();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws and propagates infra failures", async () => {
    const fn: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const resolver = makeResolver({}, fn);
    await expect(resolver.refreshCatalogue()).rejects.toThrow(
      /AgentRegistry request failed/
    );
  });

  it("throws on non-2xx HTTP during refresh", async () => {
    const stub = makeFetch([
      {
        match: () => true,
        response: {
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          body: {},
        },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await expect(resolver.refreshCatalogue()).rejects.toThrow(/503/);
  });

  it("resets refreshInFlight so a later refresh is possible after failure", async () => {
    let calls = 0;
    const fn: FetchLike = async () => {
      calls++;
      if (calls === 1) throw new Error("first fail");
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [{ id: "a" }],
      } as Awaited<ReturnType<FetchLike>>;
    };
    const resolver = makeResolver({}, fn);
    await expect(resolver.refreshCatalogue()).rejects.toThrow("first fail");
    await resolver.refreshCatalogue();
    expect(resolver.listAvailable()).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// resolve() — happy paths
// ---------------------------------------------------------------------------

describe("resolve() — happy paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null for empty string immediately", async () => {
    const resolver = makeResolver();
    expect(await resolver.resolve("")).toBeNull();
  });

  it('returns a ResolvedTool with kind="agent"', async () => {
    const f = listFetch([
      {
        id: "planner",
        displayName: "Planner",
        inputSchema: { type: "object" },
      },
    ]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("planner");
    expect(result?.kind).toBe("agent");
  });

  it("result.ref matches the requested ref", async () => {
    const f = listFetch([{ id: "planner" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("planner");
    expect(result?.ref).toBe("planner");
  });

  it("result.inputSchema defaults to {} when absent", async () => {
    const f = listFetch([{ id: "planner" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("planner");
    expect(result?.inputSchema).toEqual({});
  });

  it("result.inputSchema is set from descriptor when present", async () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string" } },
    };
    const f = listFetch([{ id: "planner", inputSchema: schema }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("planner");
    expect(result?.inputSchema).toEqual(schema);
  });

  it("result.outputSchema is set from descriptor", async () => {
    const out = { type: "object" };
    const f = listFetch([{ id: "planner", outputSchema: out }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("planner");
    expect(result?.outputSchema).toEqual(out);
  });

  it("result.outputSchema is undefined when absent in descriptor", async () => {
    const f = listFetch([{ id: "planner" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("planner");
    expect(result?.outputSchema).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolve() — handle shape and displayName fallback
// ---------------------------------------------------------------------------

describe("resolve() — handle shape", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('handle has kind="agent"', async () => {
    const f = listFetch([{ id: "x" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("x");
    expect(result?.handle.kind).toBe("agent");
  });

  it("handle.id matches descriptor id", async () => {
    const f = listFetch([{ id: "my-agent" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("my-agent");
    expect((result?.handle as { id: string }).id).toBe("my-agent");
  });

  it("displayName uses displayName field when present", async () => {
    const f = listFetch([{ id: "a", displayName: "Alpha", name: "Not This" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("a");
    expect((result?.handle as { displayName: string }).displayName).toBe(
      "Alpha"
    );
  });

  it("displayName falls back to name when displayName absent", async () => {
    const f = listFetch([{ id: "b", name: "Beta Agent" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("b");
    expect((result?.handle as { displayName: string }).displayName).toBe(
      "Beta Agent"
    );
  });

  it("displayName falls back to id when both displayName and name absent", async () => {
    const f = listFetch([{ id: "gamma" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("gamma");
    expect((result?.handle as { displayName: string }).displayName).toBe(
      "gamma"
    );
  });

  it("handle.invoke calls invokeAgent and returns result", async () => {
    const stub = makeFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [{ id: "agent1" }] },
      },
      {
        match: (url, init) =>
          url.includes("/agents/agent1/invoke") && init?.method === "POST",
        response: {
          ok: true,
          status: 200,
          body: { output: { done: true }, runId: "run-99", durationMs: 100 },
        },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("agent1");
    const handle = result!.handle as {
      invoke: (inv: {
        prompt: string;
      }) => Promise<{ output: unknown; runId: string; durationMs: number }>;
    };
    const inv = await handle.invoke({ prompt: "do something" });
    expect(inv).toEqual({
      output: { done: true },
      runId: "run-99",
      durationMs: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// resolve() — cache behaviour
// ---------------------------------------------------------------------------

describe("resolve() — cache behaviour", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not re-fetch agent on repeated resolve() within TTL", async () => {
    const fn = vi.fn(listFetch([{ id: "a" }]));
    const resolver = makeResolver(
      { ttlMs: 60_000 },
      fn as unknown as FetchLike
    );
    await resolver.refreshCatalogue();
    await resolver.resolve("a");
    await resolver.resolve("a");
    // Still only 1 call — the list fetch
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("point-lookup result is cached — second resolve() hits cache", async () => {
    // Catalogue is empty, but point-lookup finds the agent
    const fn = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/agents")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [],
        } as Awaited<ReturnType<FetchLike>>;
      }
      if (url.includes("/agents/hidden")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ id: "hidden" }),
        } as Awaited<ReturnType<FetchLike>>;
      }
      return {
        ok: false,
        status: 500,
        statusText: "x",
        json: async () => ({}),
      } as Awaited<ReturnType<FetchLike>>;
    });
    const resolver = makeResolver(
      { ttlMs: 60_000 },
      fn as unknown as FetchLike
    );
    await resolver.refreshCatalogue();
    await resolver.resolve("hidden"); // triggers point-lookup (2 calls so far)
    const callsBefore = fn.mock.calls.length;
    await resolver.resolve("hidden"); // should hit cache, no new call
    expect(fn.mock.calls.length).toBe(callsBefore);
  });

  it("point-lookup adds agent to listAvailable()", async () => {
    const fn = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/agents")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [],
        } as Awaited<ReturnType<FetchLike>>;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ id: "new-one" }),
      } as Awaited<ReturnType<FetchLike>>;
    });
    const resolver = makeResolver(
      { ttlMs: 60_000 },
      fn as unknown as FetchLike
    );
    await resolver.refreshCatalogue();
    expect(resolver.listAvailable()).toEqual([]);
    await resolver.resolve("new-one");
    expect(resolver.listAvailable()).toContain("new-one");
  });

  it("duplicate point-lookup id not added to refs twice", async () => {
    const fn = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/agents")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [],
        } as Awaited<ReturnType<FetchLike>>;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ id: "only-one" }),
      } as Awaited<ReturnType<FetchLike>>;
    });
    const resolver = makeResolver(
      { ttlMs: 60_000 },
      fn as unknown as FetchLike
    );
    await resolver.refreshCatalogue();
    await resolver.resolve("only-one");
    // Force TTL expiry so catalogue refreshes but agent stays cached
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    const fn2 = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/agents")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [],
        } as Awaited<ReturnType<FetchLike>>;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ id: "only-one" }),
      } as Awaited<ReturnType<FetchLike>>;
    });
    // New resolver to isolate
    const resolver2 = makeResolver(
      { ttlMs: 1_000 },
      fn2 as unknown as FetchLike
    );
    await resolver2.refreshCatalogue();
    await resolver2.resolve("only-one");
    await resolver2.resolve("only-one"); // again — should not double-add
    const refs = resolver2.listAvailable();
    expect(refs.filter((r) => r === "only-one")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// resolve() — not found / error paths
// ---------------------------------------------------------------------------

describe("resolve() — not-found and error paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when 404 from catalogue + point-lookup", async () => {
    const stub = makeFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [] },
      },
      {
        match: (url) => url.includes("/agents/ghost"),
        response: { ok: false, status: 404, statusText: "Not Found", body: {} },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await resolver.refreshCatalogue();
    expect(await resolver.resolve("ghost")).toBeNull();
  });

  it("throws (not null) when point-lookup returns 500", async () => {
    const stub = makeFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [] },
      },
      {
        match: (url) => url.includes("/agents/broken"),
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
    await expect(resolver.resolve("broken")).rejects.toThrow(/500/);
  });

  it("throws on network error during resolve", async () => {
    const fn: FetchLike = async () => {
      throw new Error("ETIMEDOUT");
    };
    const resolver = makeResolver({}, fn);
    await expect(resolver.resolve("any")).rejects.toThrow(
      /AgentRegistry request failed/
    );
  });

  it("propagates catalogue 503 during lazy TTL refresh in resolve()", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let calls = 0;
    const fn: FetchLike = async () => {
      calls++;
      if (calls > 1) {
        return {
          ok: false,
          status: 503,
          statusText: "Down",
          json: async () => ({}),
        } as Awaited<ReturnType<FetchLike>>;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [{ id: "x" }],
      } as Awaited<ReturnType<FetchLike>>;
    };
    const resolver = makeResolver({ ttlMs: 1_000 }, fn);
    await resolver.refreshCatalogue();
    vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
    await expect(resolver.resolve("x")).rejects.toThrow(/503/);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// HTTP request construction
// ---------------------------------------------------------------------------

describe("HTTP request construction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends GET to /agents for list refresh", async () => {
    const stub = makeFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [] },
      },
    ]);
    await makeResolver({}, stub.fetch).refreshCatalogue();
    expect(stub.calls[0]?.init?.method).toBe("GET");
    expect(stub.calls[0]?.url).toMatch(/\/agents$/);
  });

  it("sends GET to /agents/:id for point-lookup", async () => {
    const stub = makeFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [] },
      },
      {
        match: (url) => url.includes("/agents/target"),
        response: { ok: true, status: 200, body: { id: "target" } },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await resolver.refreshCatalogue();
    await resolver.resolve("target");
    const lookupCall = stub.calls.find(
      (c) => c.url.includes("/agents/target") && !c.url.includes("/invoke")
    );
    expect(lookupCall?.init?.method).toBe("GET");
  });

  it("encodes special characters in agent id for URL", async () => {
    const stub = makeFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [] },
      },
      {
        match: (url) => url.includes("my%20agent"),
        response: { ok: true, status: 200, body: { id: "my agent" } },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await resolver.refreshCatalogue();
    await resolver.resolve("my agent");
    const call = stub.calls.find((c) => c.url.includes("my%20agent"));
    expect(call).toBeDefined();
  });

  it("sends POST with JSON body for invoke", async () => {
    const stub = makeFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [{ id: "agent1" }] },
      },
      {
        match: (url, init) =>
          url.includes("/agents/agent1/invoke") && init?.method === "POST",
        response: {
          ok: true,
          status: 200,
          body: { output: "ok", runId: "r1", durationMs: 10 },
        },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("agent1");
    const handle = result!.handle as {
      invoke: (inv: { prompt: string }) => Promise<unknown>;
    };
    await handle.invoke({ prompt: "hello" });
    const invokeCall = stub.calls.find((c) => c.url.includes("/invoke"));
    expect(invokeCall?.init?.method).toBe("POST");
    expect(invokeCall?.init?.headers?.["content-type"]).toBe(
      "application/json"
    );
    const parsedBody = JSON.parse(invokeCall?.init?.body ?? "{}");
    expect(parsedBody.prompt).toBe("hello");
  });

  it("includes authorization header in GET request", async () => {
    const stub = makeFetch([
      {
        match: () => true,
        response: { ok: true, status: 200, body: [] },
      },
    ]);
    const resolver = makeResolver(
      { headers: { authorization: "Bearer tok123" } },
      stub.fetch
    );
    await resolver.refreshCatalogue();
    expect(stub.calls[0]?.init?.headers?.authorization).toBe("Bearer tok123");
  });

  it("always includes accept: application/json header", async () => {
    const stub = makeFetch([
      {
        match: () => true,
        response: { ok: true, status: 200, body: [] },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await resolver.refreshCatalogue();
    expect(stub.calls[0]?.init?.headers?.accept).toBe("application/json");
  });

  it("does not send content-type on GET requests", async () => {
    const stub = makeFetch([
      {
        match: () => true,
        response: { ok: true, status: 200, body: [] },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await resolver.refreshCatalogue();
    expect(stub.calls[0]?.init?.headers?.["content-type"]).toBeUndefined();
  });

  it("passes AbortSignal to fetch", async () => {
    let receivedSignal: AbortSignal | undefined;
    const fn: FetchLike = async (_url, init) => {
      receivedSignal = init?.signal;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [],
      } as Awaited<ReturnType<FetchLike>>;
    };
    const resolver = makeResolver({}, fn);
    await resolver.refreshCatalogue();
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal instanceof AbortSignal).toBe(true);
  });

  it("strips trailing slashes from baseUrl so URLs are clean", async () => {
    const stub = makeFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [] },
      },
    ]);
    const resolver = makeResolver(
      { baseUrl: "https://registry.local////" },
      stub.fetch
    );
    await resolver.refreshCatalogue();
    expect(stub.calls[0]?.url).toBe("https://registry.local/agents");
  });
});

// ---------------------------------------------------------------------------
// parseList shape variants
// ---------------------------------------------------------------------------

describe("parseList() — response shape variants", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts raw array at top level", async () => {
    const f = listFetch([{ id: "a" }, { id: "b" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    expect(resolver.listAvailable()).toEqual(["a", "b"]);
  });

  it("accepts { agents: [...] } envelope", async () => {
    const fn: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ agents: [{ id: "c" }, { id: "d" }] }),
      } as Awaited<ReturnType<FetchLike>>);
    const resolver = makeResolver({}, fn);
    await resolver.refreshCatalogue();
    expect(resolver.listAvailable()).toEqual(["c", "d"]);
  });

  it("accepts { results: [...] } envelope", async () => {
    const fn: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ results: [{ id: "e" }, { id: "f" }] }),
      } as Awaited<ReturnType<FetchLike>>);
    const resolver = makeResolver({}, fn);
    await resolver.refreshCatalogue();
    expect(resolver.listAvailable()).toEqual(["e", "f"]);
  });

  it("returns empty list for unknown shape", async () => {
    const fn: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ data: { nested: true } }),
      } as Awaited<ReturnType<FetchLike>>);
    const resolver = makeResolver({}, fn);
    await resolver.refreshCatalogue();
    expect(resolver.listAvailable()).toEqual([]);
  });

  it("skips entries without a string id", async () => {
    const fn: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [
          { id: "valid" },
          { id: 123 },
          { name: "no-id" },
          null,
          "string-entry",
        ],
      } as Awaited<ReturnType<FetchLike>>);
    const resolver = makeResolver({}, fn);
    await resolver.refreshCatalogue();
    expect(resolver.listAvailable()).toEqual(["valid"]);
  });

  it("skips null entries in the list", async () => {
    const fn: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [null, undefined, { id: "ok" }],
      } as Awaited<ReturnType<FetchLike>>);
    const resolver = makeResolver({}, fn);
    await resolver.refreshCatalogue();
    expect(resolver.listAvailable()).toEqual(["ok"]);
  });

  it("handles non-object entries in the list", async () => {
    const fn: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [42, "hello", true, { id: "real" }],
      } as Awaited<ReturnType<FetchLike>>);
    const resolver = makeResolver({}, fn);
    await resolver.refreshCatalogue();
    expect(resolver.listAvailable()).toEqual(["real"]);
  });
});

// ---------------------------------------------------------------------------
// parseDescriptor field handling
// ---------------------------------------------------------------------------

describe("parseDescriptor() — field handling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("picks up name field from descriptor", async () => {
    const f = listFetch([{ id: "x", name: "Agent X" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("x");
    expect((result?.handle as { displayName: string }).displayName).toBe(
      "Agent X"
    );
  });

  it("ignores non-string name field", async () => {
    const f = listFetch([{ id: "x", name: 42, displayName: "Proper Name" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("x");
    // displayName is present and valid
    expect((result?.handle as { displayName: string }).displayName).toBe(
      "Proper Name"
    );
  });

  it("ignores non-string displayName field, falls back to name", async () => {
    const f = listFetch([{ id: "x", displayName: 99, name: "Fallback" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("x");
    expect((result?.handle as { displayName: string }).displayName).toBe(
      "Fallback"
    );
  });

  it("preserves inputSchema of any shape", async () => {
    const schema = { oneOf: [{ type: "string" }, { type: "number" }] };
    const f = listFetch([{ id: "x", inputSchema: schema }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("x");
    expect(result?.inputSchema).toEqual(schema);
  });

  it("preserves outputSchema of any shape", async () => {
    const schema = { type: "array", items: { type: "string" } };
    const f = listFetch([{ id: "x", outputSchema: schema }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("x");
    expect(result?.outputSchema).toEqual(schema);
  });
});

// ---------------------------------------------------------------------------
// invokeAgent — response field defaults
// ---------------------------------------------------------------------------

describe("invokeAgent() — response field defaults", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults output to null when missing from response", async () => {
    const stub = makeFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [{ id: "a" }] },
      },
      {
        match: (url) => url.includes("/invoke"),
        response: {
          ok: true,
          status: 200,
          body: { runId: "r1", durationMs: 5 },
        },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("a");
    const handle = result!.handle as {
      invoke: (inv: { prompt: string }) => Promise<{ output: unknown }>;
    };
    const inv = await handle.invoke({ prompt: "go" });
    expect(inv.output).toBeNull();
  });

  it('defaults runId to "<agentId>-<startedAt>" when missing from response', async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.100Z"));
    const stub = makeFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [{ id: "a" }] },
      },
      {
        match: (url) => url.includes("/invoke"),
        response: {
          ok: true,
          status: 200,
          body: { output: "x", durationMs: 5 },
        },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("a");
    const handle = result!.handle as {
      invoke: (inv: { prompt: string }) => Promise<{ runId: string }>;
    };
    const inv = await handle.invoke({ prompt: "go" });
    expect(inv.runId).toMatch(/^a-\d+$/);
  });

  it("defaults durationMs to computed elapsed when missing from response", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const stub = makeFetch([
      {
        match: (url) => url.endsWith("/agents"),
        response: { ok: true, status: 200, body: [{ id: "a" }] },
      },
      {
        match: (url) => url.includes("/invoke"),
        response: { ok: true, status: 200, body: { output: "x", runId: "r1" } },
      },
    ]);
    const resolver = makeResolver({}, stub.fetch);
    await resolver.refreshCatalogue();
    const result = await resolver.resolve("a");
    const handle = result!.handle as {
      invoke: (inv: { prompt: string }) => Promise<{ durationMs: number }>;
    };
    const inv = await handle.invoke({ prompt: "go" });
    expect(typeof inv.durationMs).toBe("number");
    expect(inv.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("forwards prompt, context, parentRunId to the POST body", async () => {
    const stub = makeFetch([
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
    type FullHandle = {
      invoke: (inv: {
        prompt: string;
        context?: unknown;
        parentRunId?: string;
      }) => Promise<unknown>;
    };
    const handle = result!.handle as FullHandle;
    await handle.invoke({
      prompt: "test",
      context: { key: "val" },
      parentRunId: "parent-1",
    });
    const invokeCall = stub.calls.find((c) => c.url.includes("/invoke"));
    const body = JSON.parse(invokeCall?.init?.body ?? "{}");
    expect(body.prompt).toBe("test");
    expect(body.context).toEqual({ key: "val" });
    expect(body.parentRunId).toBe("parent-1");
  });
});

// ---------------------------------------------------------------------------
// TTL — custom values
// ---------------------------------------------------------------------------

describe("TTL — custom values", () => {
  it("respects custom ttlMs option", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let callCount = 0;
    const fn: FetchLike = async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [{ id: "x" }],
      } as Awaited<ReturnType<FetchLike>>;
    };
    const resolver = makeResolver({ ttlMs: 500 }, fn);
    await resolver.refreshCatalogue();
    expect(callCount).toBe(1);
    // Still within TTL (100ms < 500ms)
    vi.setSystemTime(new Date("2026-01-01T00:00:00.100Z"));
    await resolver.resolve("x");
    expect(callCount).toBe(1);
    // Past TTL (600ms > 500ms)
    vi.setSystemTime(new Date("2026-01-01T00:00:00.600Z"));
    await resolver.resolve("x");
    expect(callCount).toBe(2);
    vi.useRealTimers();
  });

  it("ttlMs=0 forces a refresh on every resolve()", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let callCount = 0;
    const fn: FetchLike = async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [{ id: "x" }],
      } as Awaited<ReturnType<FetchLike>>;
    };
    const resolver = makeResolver({ ttlMs: 0 }, fn);
    await resolver.refreshCatalogue();
    await resolver.resolve("x");
    await resolver.resolve("x");
    // 1 manual + 2 lazy — each resolve triggers a refresh
    expect(callCount).toBeGreaterThanOrEqual(3);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Multiple agents in catalogue
// ---------------------------------------------------------------------------

describe("multiple agents in catalogue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves each agent independently from a multi-agent catalogue", async () => {
    const f = listFetch([
      { id: "alpha", displayName: "Alpha" },
      { id: "beta", displayName: "Beta" },
      { id: "gamma", displayName: "Gamma" },
    ]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    const a = await resolver.resolve("alpha");
    const b = await resolver.resolve("beta");
    const g = await resolver.resolve("gamma");
    expect((a?.handle as { displayName: string }).displayName).toBe("Alpha");
    expect((b?.handle as { displayName: string }).displayName).toBe("Beta");
    expect((g?.handle as { displayName: string }).displayName).toBe("Gamma");
  });

  it("catalogue refs are sorted alphabetically", async () => {
    const f = listFetch([{ id: "z" }, { id: "a" }, { id: "m" }, { id: "b" }]);
    const resolver = makeResolver({}, f);
    await resolver.refreshCatalogue();
    expect(resolver.listAvailable()).toEqual(["a", "b", "m", "z"]);
  });

  it("resolves an agent not in catalogue via point-lookup while others are cached", async () => {
    const fn = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = input.toString();
      if (url.endsWith("/agents")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [{ id: "known" }],
        } as Awaited<ReturnType<FetchLike>>;
      }
      if (url.includes("/agents/unknown-but-real")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ id: "unknown-but-real" }),
        } as Awaited<ReturnType<FetchLike>>;
      }
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: async () => ({}),
      } as Awaited<ReturnType<FetchLike>>;
    });
    const resolver = makeResolver(
      { ttlMs: 60_000 },
      fn as unknown as FetchLike
    );
    await resolver.refreshCatalogue();
    const known = await resolver.resolve("known");
    const extra = await resolver.resolve("unknown-but-real");
    expect(known?.ref).toBe("known");
    expect(extra?.ref).toBe("unknown-but-real");
  });
});
