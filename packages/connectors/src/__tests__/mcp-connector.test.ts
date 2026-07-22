/**
 * Tests for MCPAsyncToolResolver — covers tool discovery, schema retrieval,
 * tool invocation, error handling, connection lifecycle, and caching behaviour.
 *
 * The MCPClient is mocked so no real network connections are made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MCPAsyncToolResolver } from "../mcp-tool-resolver.js";
import type { MCPClient } from "@dzupagent/core/pipeline";
import type { MCPToolDescriptor } from "@dzupagent/core/pipeline";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * AGENT-M-16 — successful MCP server text is fenced at the source in an
 * <untrusted_content source="tool_result"> boundary by the resolver. Mirror
 * that transform so assertions read against the expected fenced value.
 */
function fence(text: string): string {
  return `<untrusted_content source="tool_result">\n${text}\n</untrusted_content>`;
}

function makeTool(
  name: string,
  serverId = "server-1",
  overrides?: Partial<MCPToolDescriptor>
): MCPToolDescriptor {
  return {
    name,
    description: `Description for ${name}`,
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "The input value" },
      },
      required: ["input"],
    },
    serverId,
    ...overrides,
  };
}

function makeToolComplex(
  name: string,
  serverId = "server-1"
): MCPToolDescriptor {
  return {
    name,
    description: `Complex tool ${name}`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        options: {
          type: "object",
          properties: {
            limit: { type: "number" },
            offset: { type: "number" },
            filters: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      },
      required: ["query"],
    },
    serverId,
  };
}

function createMockClient(overrides?: Partial<MCPClient>): MCPClient {
  return {
    addServer: vi.fn(),
    connect: vi.fn().mockResolvedValue(true),
    connectAll: vi.fn().mockResolvedValue(new Map()),
    disconnect: vi.fn().mockResolvedValue(undefined),
    disconnectAll: vi.fn().mockResolvedValue(undefined),
    getEagerTools: vi.fn().mockReturnValue([]),
    getDeferredToolNames: vi.fn().mockReturnValue([]),
    findTool: vi.fn().mockReturnValue(null),
    invokeTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    }),
    loadDeferredTool: vi.fn().mockReturnValue(null),
    getStatus: vi.fn().mockReturnValue([]),
    hasConnections: vi.fn().mockReturnValue(false),
    ...overrides,
  } as unknown as MCPClient;
}

// ---------------------------------------------------------------------------
// Tool discovery
// ---------------------------------------------------------------------------

describe("MCPAsyncToolResolver — tool discovery", () => {
  it("lists no tools when client has no connections", () => {
    const client = createMockClient();
    const resolver = new MCPAsyncToolResolver(client);
    expect(resolver.listAvailable()).toEqual([]);
  });

  it("lists eager tools from a single server", () => {
    const tools = [makeTool("search"), makeTool("read")];
    const client = createMockClient({
      getEagerTools: vi.fn().mockReturnValue(tools),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const available = resolver.listAvailable();
    expect(available).toContain("server-1/search");
    expect(available).toContain("server-1/read");
    expect(available).toHaveLength(2);
  });

  it("lists deferred tool names from connected server", () => {
    const client = createMockClient({
      getEagerTools: vi.fn().mockReturnValue([]),
      getDeferredToolNames: vi.fn().mockReturnValue([
        { name: "heavy-tool", serverId: "server-1" },
        { name: "another-deferred", serverId: "server-1" },
      ]),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const available = resolver.listAvailable();
    expect(available).toContain("server-1/heavy-tool");
    expect(available).toContain("server-1/another-deferred");
    expect(available).toHaveLength(2);
  });

  it("merges eager and deferred tools from multiple servers", () => {
    const client = createMockClient({
      getEagerTools: vi
        .fn()
        .mockReturnValue([
          makeTool("tool-a", "server-1"),
          makeTool("tool-b", "server-2"),
        ]),
      getDeferredToolNames: vi
        .fn()
        .mockReturnValue([{ name: "tool-c", serverId: "server-1" }]),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const available = resolver.listAvailable();
    expect(available).toContain("server-1/tool-a");
    expect(available).toContain("server-2/tool-b");
    expect(available).toContain("server-1/tool-c");
    expect(available).toHaveLength(3);
  });

  it("deduplicates refs when a tool appears in both eager and deferred", () => {
    const client = createMockClient({
      getEagerTools: vi.fn().mockReturnValue([makeTool("search", "server-1")]),
      getDeferredToolNames: vi
        .fn()
        .mockReturnValue([{ name: "search", serverId: "server-1" }]),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const available = resolver.listAvailable();
    // Should be deduplicated
    expect(available.filter((r) => r === "server-1/search")).toHaveLength(1);
  });

  it("returns sorted list of available refs", () => {
    const client = createMockClient({
      getEagerTools: vi
        .fn()
        .mockReturnValue([
          makeTool("zebra", "server-1"),
          makeTool("alpha", "server-1"),
          makeTool("mango", "server-1"),
        ]),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const available = resolver.listAvailable();
    expect(available).toEqual([...available].sort());
  });

  it("listAvailable returns a copy — mutations do not affect internal state", () => {
    const tools = [makeTool("tool-x")];
    const client = createMockClient({
      getEagerTools: vi.fn().mockReturnValue(tools),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const list1 = resolver.listAvailable();
    list1.push("injected/fake");
    const list2 = resolver.listAvailable();
    expect(list2).not.toContain("injected/fake");
  });
});

// ---------------------------------------------------------------------------
// Tool schema retrieval
// ---------------------------------------------------------------------------

describe("MCPAsyncToolResolver — tool schema retrieval", () => {
  it("resolve() returns null for unknown tool ref", async () => {
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(null),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("server-1/unknown-tool");
    expect(result).toBeNull();
  });

  it("resolve() returns ResolvedTool with correct ref and kind", async () => {
    const tool = makeTool("search");
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("server-1/search");
    expect(result).not.toBeNull();
    expect(result!.ref).toBe("server-1/search");
    expect(result!.kind).toBe("mcp-tool");
  });

  it("resolve() returns tool with name and description in handle", async () => {
    const tool = makeTool("lookup");
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("server-1/lookup");
    expect(result).not.toBeNull();
    const handle = result!.handle as { toolName: string; serverId: string };
    expect(handle.toolName).toBe("lookup");
    expect(handle.serverId).toBe("server-1");
  });

  it("resolve() includes inputSchema in resolved tool", async () => {
    const tool = makeTool("search");
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("server-1/search");
    expect(result!.inputSchema).toMatchObject({
      type: "object",
      properties: expect.objectContaining({ input: expect.any(Object) }),
    });
  });

  it("resolve() returns null for empty string ref", async () => {
    const client = createMockClient();
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("");
    expect(result).toBeNull();
  });

  it("resolve() returns null when ref has empty serverId segment", async () => {
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(makeTool("tool")),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("/tool");
    expect(result).toBeNull();
  });

  it("resolve() returns null when ref has empty toolName segment", async () => {
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(makeTool("")),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("server-1/");
    expect(result).toBeNull();
  });

  it("resolve() rejects when qualified serverId does not match tool serverId", async () => {
    const tool = makeTool("search", "server-1");
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
    });
    const resolver = new MCPAsyncToolResolver(client);
    // Ref specifies server-2, but tool belongs to server-1
    const result = await resolver.resolve("server-2/search");
    expect(result).toBeNull();
  });

  it("resolve() works with unqualified tool name (no serverId)", async () => {
    const tool = makeTool("search", "server-1");
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("search");
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("mcp-tool");
  });
});

// ---------------------------------------------------------------------------
// Tool invocation
// ---------------------------------------------------------------------------

describe("MCPAsyncToolResolver — tool invocation", () => {
  it("invoking handle calls client.invokeTool with correct args", async () => {
    const tool = makeTool("search");
    const invokeTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "result" }],
      isError: false,
    });
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
      invokeTool,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const resolved = await resolver.resolve("server-1/search");
    expect(resolved).not.toBeNull();

    const handle = resolved!.handle as {
      invoke: (input: unknown) => Promise<unknown>;
    };
    await handle.invoke({ input: "hello" });

    expect(invokeTool).toHaveBeenCalledWith("search", { input: "hello" });
  });

  it("invocation result has content array with type and value", async () => {
    const tool = makeTool("search");
    const invokeTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "found it" }],
      isError: false,
    });
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
      invokeTool,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const resolved = await resolver.resolve("server-1/search");
    const handle = resolved!.handle as {
      invoke: (
        input: unknown
      ) => Promise<{ content: unknown[]; isError: boolean }>;
    };
    const result = await handle.invoke({ input: "hello" });

    expect(result.content).toBeInstanceOf(Array);
    expect(result.content[0]).toMatchObject({
      type: "text",
      value: fence("found it"),
    });
    expect(result.isError).toBe(false);
  });

  it("invocation result isError is true when server returns error", async () => {
    const tool = makeTool("search");
    const invokeTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Error occurred" }],
      isError: true,
    });
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
      invokeTool,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const resolved = await resolver.resolve("server-1/search");
    const handle = resolved!.handle as {
      invoke: (
        input: unknown
      ) => Promise<{ content: unknown[]; isError: boolean }>;
    };
    const result = await handle.invoke({ input: "fail" });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      value: "Error occurred",
    });
  });

  it("invocation with null input defaults to empty object", async () => {
    const tool = makeTool("ping");
    const invokeTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "pong" }],
      isError: false,
    });
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
      invokeTool,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const resolved = await resolver.resolve("server-1/ping");
    const handle = resolved!.handle as {
      invoke: (input: unknown) => Promise<unknown>;
    };
    await handle.invoke(null);

    expect(invokeTool).toHaveBeenCalledWith("ping", {});
  });

  it("invocation with undefined input defaults to empty object", async () => {
    const tool = makeTool("ping");
    const invokeTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "pong" }],
      isError: false,
    });
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
      invokeTool,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const resolved = await resolver.resolve("server-1/ping");
    const handle = resolved!.handle as {
      invoke: (input: unknown) => Promise<unknown>;
    };
    await handle.invoke(undefined);

    expect(invokeTool).toHaveBeenCalledWith("ping", {});
  });
});

// ---------------------------------------------------------------------------
// Complex parameter invocation
// ---------------------------------------------------------------------------

describe("MCPAsyncToolResolver — complex parameter invocation", () => {
  it("passes nested object params correctly to invokeTool", async () => {
    const tool = makeToolComplex("db-query");
    const invokeTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "rows: 5" }],
      isError: false,
    });
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
      invokeTool,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const resolved = await resolver.resolve("server-1/db-query");
    const handle = resolved!.handle as {
      invoke: (input: unknown) => Promise<unknown>;
    };

    const params = {
      query: "SELECT * FROM users",
      options: {
        limit: 10,
        offset: 0,
        filters: ["active", "verified"],
      },
    };
    await handle.invoke(params);

    expect(invokeTool).toHaveBeenCalledWith("db-query", params);
  });

  it("handles array params in tool invocation", async () => {
    const tool = makeTool("batch-process", "server-1", {
      inputSchema: {
        type: "object",
        properties: {
          items: { type: "array", items: { type: "string" } },
        },
        required: ["items"],
      },
    });
    const invokeTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "processed 3 items" }],
      isError: false,
    });
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
      invokeTool,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const resolved = await resolver.resolve("server-1/batch-process");
    const handle = resolved!.handle as {
      invoke: (input: unknown) => Promise<unknown>;
    };
    await handle.invoke({ items: ["a", "b", "c"] });

    expect(invokeTool).toHaveBeenCalledWith("batch-process", {
      items: ["a", "b", "c"],
    });
  });
});

// ---------------------------------------------------------------------------
// Tool result format
// ---------------------------------------------------------------------------

describe("MCPAsyncToolResolver — tool result format", () => {
  it("maps text content parts correctly", async () => {
    const tool = makeTool("read");
    const invokeTool = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "first line" },
        { type: "text", text: "second line" },
      ],
      isError: false,
    });
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
      invokeTool,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const resolved = await resolver.resolve("server-1/read");
    const handle = resolved!.handle as {
      invoke: (
        input: unknown
      ) => Promise<{ content: Array<{ type: string; value: unknown }> }>;
    };
    const result = await handle.invoke({ input: "test" });

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({
      type: "text",
      value: fence("first line"),
    });
    expect(result.content[1]).toEqual({
      type: "text",
      value: fence("second line"),
    });
  });

  it("maps image content parts correctly", async () => {
    const tool = makeTool("screenshot");
    const invokeTool = vi.fn().mockResolvedValue({
      content: [{ type: "image", data: "base64encodeddata" }],
      isError: false,
    });
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
      invokeTool,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const resolved = await resolver.resolve("server-1/screenshot");
    const handle = resolved!.handle as {
      invoke: (
        input: unknown
      ) => Promise<{ content: Array<{ type: string; value: unknown }> }>;
    };
    const result = await handle.invoke({ input: "page" });

    expect(result.content[0]).toEqual({
      type: "image",
      value: "base64encodeddata",
    });
  });

  it("maps unknown content type as json", async () => {
    const tool = makeTool("raw-data");
    const rawPart = {
      type: "resource",
      uri: "file:///some/path",
      text: "content",
    };
    const invokeTool = vi.fn().mockResolvedValue({
      content: [rawPart],
      isError: false,
    });
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
      invokeTool,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const resolved = await resolver.resolve("server-1/raw-data");
    const handle = resolved!.handle as {
      invoke: (
        input: unknown
      ) => Promise<{ content: Array<{ type: string; value: unknown }> }>;
    };
    const result = await handle.invoke({ input: "x" });

    expect(result.content[0]).toMatchObject({ type: "json", value: rawPart });
  });

  it("handles empty content array gracefully", async () => {
    const tool = makeTool("noop");
    const invokeTool = vi.fn().mockResolvedValue({
      content: [],
      isError: false,
    });
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
      invokeTool,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const resolved = await resolver.resolve("server-1/noop");
    const handle = resolved!.handle as {
      invoke: (input: unknown) => Promise<{ content: unknown[] }>;
    };
    const result = await handle.invoke({});

    expect(result.content).toEqual([]);
  });

  it("handles missing content (null/undefined) from server gracefully", async () => {
    const tool = makeTool("odd-tool");
    const invokeTool = vi.fn().mockResolvedValue({
      // no content field
      isError: false,
    });
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
      invokeTool,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const resolved = await resolver.resolve("server-1/odd-tool");
    const handle = resolved!.handle as {
      invoke: (input: unknown) => Promise<{ content: unknown[] }>;
    };
    const result = await handle.invoke({});

    expect(result.content).toEqual([]);
  });

  it("text content missing text field defaults to empty string", async () => {
    const tool = makeTool("sparse-tool");
    const invokeTool = vi.fn().mockResolvedValue({
      content: [{ type: "text" }], // no text field
      isError: false,
    });
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
      invokeTool,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const resolved = await resolver.resolve("server-1/sparse-tool");
    const handle = resolved!.handle as {
      invoke: (
        input: unknown
      ) => Promise<{ content: Array<{ type: string; value: unknown }> }>;
    };
    const result = await handle.invoke({});

    expect(result.content[0]).toEqual({ type: "text", value: fence("") });
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("MCPAsyncToolResolver — error handling", () => {
  it("wraps invokeTool throw into an error with context", async () => {
    const tool = makeTool("flaky");
    const invokeTool = vi.fn().mockRejectedValue(new Error("network timeout"));
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
      invokeTool,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const resolved = await resolver.resolve("server-1/flaky");
    const handle = resolved!.handle as {
      invoke: (input: unknown) => Promise<unknown>;
    };

    await expect(handle.invoke({ input: "x" })).rejects.toThrow(
      "network timeout"
    );
  });

  it("wraps non-Error throws from invokeTool", async () => {
    const tool = makeTool("flaky");
    const invokeTool = vi.fn().mockRejectedValue("string error from server");
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
      invokeTool,
    });
    const resolver = new MCPAsyncToolResolver(client);
    const resolved = await resolver.resolve("server-1/flaky");
    const handle = resolved!.handle as {
      invoke: (input: unknown) => Promise<unknown>;
    };

    await expect(handle.invoke({ input: "x" })).rejects.toThrow(
      "string error from server"
    );
  });

  it("resolve() returns null (not throw) for non-existent tool", async () => {
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(null),
    });
    const resolver = new MCPAsyncToolResolver(client);

    await expect(resolver.resolve("server-1/nonexistent")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Multiple tools — sequential invocation
// ---------------------------------------------------------------------------

describe("MCPAsyncToolResolver — multiple tools sequential invocation", () => {
  it("can invoke two different tools sequentially", async () => {
    const toolA = makeTool("tool-a");
    const toolB = makeTool("tool-b");

    const findTool = vi.fn().mockImplementation((name: string) => {
      if (name === "tool-a") return toolA;
      if (name === "tool-b") return toolB;
      return null;
    });
    const invokeTool = vi.fn().mockImplementation((name: string) => {
      return Promise.resolve({
        content: [{ type: "text", text: `result from ${name}` }],
        isError: false,
      });
    });
    const client = createMockClient({ findTool, invokeTool });
    const resolver = new MCPAsyncToolResolver(client);

    const resolvedA = await resolver.resolve("server-1/tool-a");
    const resolvedB = await resolver.resolve("server-1/tool-b");

    expect(resolvedA).not.toBeNull();
    expect(resolvedB).not.toBeNull();

    const handleA = resolvedA!.handle as {
      invoke: (i: unknown) => Promise<{ content: Array<{ value: unknown }> }>;
    };
    const handleB = resolvedB!.handle as {
      invoke: (i: unknown) => Promise<{ content: Array<{ value: unknown }> }>;
    };

    const resultA = await handleA.invoke({ input: "x" });
    const resultB = await handleB.invoke({ input: "y" });

    expect(resultA.content[0]).toMatchObject({
      value: fence("result from tool-a"),
    });
    expect(resultB.content[0]).toMatchObject({
      value: fence("result from tool-b"),
    });
  });

  it("can resolve and invoke tools from different servers", async () => {
    const toolFromS1 = makeTool("search", "server-1");
    const toolFromS2 = makeTool("write", "server-2");

    const findTool = vi.fn().mockImplementation((name: string) => {
      if (name === "search") return toolFromS1;
      if (name === "write") return toolFromS2;
      return null;
    });
    const invokeTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "done" }],
      isError: false,
    });
    const client = createMockClient({ findTool, invokeTool });
    const resolver = new MCPAsyncToolResolver(client);

    const r1 = await resolver.resolve("server-1/search");
    const r2 = await resolver.resolve("server-2/write");

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect((r1!.handle as { serverId: string }).serverId).toBe("server-1");
    expect((r2!.handle as { serverId: string }).serverId).toBe("server-2");
  });
});

// ---------------------------------------------------------------------------
// Catalogue caching (TTL)
// ---------------------------------------------------------------------------

describe("MCPAsyncToolResolver — catalogue TTL and refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("listAvailable returns cached list before TTL expires", () => {
    const getEagerTools = vi
      .fn()
      .mockReturnValueOnce([makeTool("first-tool")])
      .mockReturnValue([makeTool("second-tool")]);
    const client = createMockClient({ getEagerTools });
    const resolver = new MCPAsyncToolResolver(client, { ttlMs: 5000 });

    // First call — uses initial catalogue
    const list = resolver.listAvailable();
    expect(list).toContain("server-1/first-tool");
    // Advance time but not past TTL
    vi.advanceTimersByTime(4000);
    // Should still be cached
    const list2 = resolver.listAvailable();
    expect(list2).toContain("server-1/first-tool");
  });

  it("refreshCatalogue() immediately updates the cached list", () => {
    const getEagerTools = vi
      .fn()
      .mockReturnValueOnce([makeTool("old-tool")])
      .mockReturnValue([makeTool("new-tool")]);
    const client = createMockClient({ getEagerTools });
    const resolver = new MCPAsyncToolResolver(client);

    expect(resolver.listAvailable()).toContain("server-1/old-tool");

    resolver.refreshCatalogue();

    expect(resolver.listAvailable()).toContain("server-1/new-tool");
    expect(resolver.listAvailable()).not.toContain("server-1/old-tool");
  });

  it("resolve() triggers lazy TTL refresh when cache is stale", async () => {
    const toolV1 = makeTool("tool-v1");
    const toolV2 = makeTool("tool-v2");

    const getEagerTools = vi
      .fn()
      .mockReturnValueOnce([toolV1])
      .mockReturnValue([toolV2]);
    const findTool = vi.fn().mockReturnValue(toolV2);
    const client = createMockClient({ getEagerTools, findTool });

    const resolver = new MCPAsyncToolResolver(client, { ttlMs: 1000 });
    expect(resolver.listAvailable()).toContain("server-1/tool-v1");

    // Advance past TTL
    vi.advanceTimersByTime(1500);

    // resolve() should trigger a refresh
    await resolver.resolve("server-1/tool-v2");
    expect(resolver.listAvailable()).toContain("server-1/tool-v2");
  });

  it("custom TTL of 0ms causes refresh on every resolve call", async () => {
    const getEagerTools = vi.fn().mockReturnValue([makeTool("tool")]);
    const findTool = vi.fn().mockReturnValue(makeTool("tool"));
    const client = createMockClient({ getEagerTools, findTool });
    const resolver = new MCPAsyncToolResolver(client, { ttlMs: 0 });

    const callsBefore = getEagerTools.mock.calls.length;
    await resolver.resolve("server-1/tool");
    // Should have called getEagerTools again due to TTL=0
    expect(getEagerTools.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

// ---------------------------------------------------------------------------
// Handle structure
// ---------------------------------------------------------------------------

describe("MCPAsyncToolResolver — handle structure", () => {
  it("resolved handle has kind = mcp-tool", async () => {
    const tool = makeTool("search");
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("server-1/search");
    const handle = result!.handle as { kind: string };
    expect(handle.kind).toBe("mcp-tool");
  });

  it("resolved handle id is fully-qualified ref", async () => {
    const tool = makeTool("search", "server-1");
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("server-1/search");
    const handle = result!.handle as { id: string };
    expect(handle.id).toBe("server-1/search");
  });

  it("resolved handle has invoke function", async () => {
    const tool = makeTool("search");
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("server-1/search");
    const handle = result!.handle as { invoke: unknown };
    expect(typeof handle.invoke).toBe("function");
  });

  it("resolved handle inputSchema matches tool descriptor", async () => {
    const schema = {
      type: "object" as const,
      properties: {
        q: { type: "string" as const },
        n: { type: "number" as const },
      },
      required: ["q"],
    };
    const tool = makeTool("custom", "server-1", { inputSchema: schema });
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("server-1/custom");
    expect(result!.inputSchema).toMatchObject(schema);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("MCPAsyncToolResolver — edge cases", () => {
  it("handles tool name with slashes in name gracefully", async () => {
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(null),
    });
    const resolver = new MCPAsyncToolResolver(client);
    // ref: "server-1/tool/with/slashes" — only first slash splits server/tool
    const result = await resolver.resolve("server-1/tool/with/slashes");
    // toolName would be "tool/with/slashes", findTool returns null
    expect(result).toBeNull();
  });

  it("handles tool with no description field", async () => {
    const tool: MCPToolDescriptor = {
      name: "no-desc-tool",
      description: "",
      inputSchema: { type: "object", properties: {} },
      serverId: "server-1",
    };
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
    });
    const resolver = new MCPAsyncToolResolver(client);
    const result = await resolver.resolve("server-1/no-desc-tool");
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("mcp-tool");
  });

  it("can resolve same tool multiple times independently", async () => {
    const tool = makeTool("search");
    const invokeTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    const client = createMockClient({
      findTool: vi.fn().mockReturnValue(tool),
      invokeTool,
    });
    const resolver = new MCPAsyncToolResolver(client);

    const r1 = await resolver.resolve("server-1/search");
    const r2 = await resolver.resolve("server-1/search");

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();

    const h1 = r1!.handle as { invoke: (i: unknown) => Promise<unknown> };
    const h2 = r2!.handle as { invoke: (i: unknown) => Promise<unknown> };

    await h1.invoke({ input: "a" });
    await h2.invoke({ input: "b" });

    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(invokeTool).toHaveBeenNthCalledWith(1, "search", { input: "a" });
    expect(invokeTool).toHaveBeenNthCalledWith(2, "search", { input: "b" });
  });

  it("refreshCatalogue re-reads from client on every call", () => {
    const getEagerTools = vi.fn().mockReturnValue([]);
    const client = createMockClient({ getEagerTools });
    const resolver = new MCPAsyncToolResolver(client);

    // 1 call from constructor
    const callsAfterInit = getEagerTools.mock.calls.length;

    resolver.refreshCatalogue();
    resolver.refreshCatalogue();

    expect(getEagerTools.mock.calls.length).toBe(callsAfterInit + 2);
  });

  it("default TTL is 60 seconds", async () => {
    vi.useFakeTimers();
    try {
      const getEagerTools = vi
        .fn()
        .mockReturnValueOnce([makeTool("old")])
        .mockReturnValue([makeTool("new")]);
      const findTool = vi.fn().mockReturnValue(makeTool("new"));
      const client = createMockClient({ getEagerTools, findTool });
      const resolver = new MCPAsyncToolResolver(client); // default 60s

      expect(resolver.listAvailable()).toContain("server-1/old");

      // Advance 59.9 seconds — should NOT refresh
      vi.advanceTimersByTime(59_900);
      await resolver.resolve("server-1/old");
      expect(resolver.listAvailable()).toContain("server-1/old");

      // Advance past 60 seconds — should refresh
      vi.advanceTimersByTime(200);
      await resolver.resolve("server-1/new");
      expect(resolver.listAvailable()).toContain("server-1/new");
    } finally {
      vi.useRealTimers();
    }
  });
});
