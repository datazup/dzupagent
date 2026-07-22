import { describe, it, expect, vi } from "vitest";
import { MCPClient } from "../mcp-client.js";
import type { MCPServerConfig, MCPToolDescriptor } from "../mcp-types.js";

/**
 * AGENT-H-07 — MCPClient.invokeTool() must validate model-emitted arguments
 * against the tool's declared inputSchema BEFORE they reach the transport
 * (executeToolCall). A malformed call (wrong type / missing required key) is
 * rejected with a structured `MCP_ARG_VALIDATION_FAILED` tool-error and the
 * transport is never touched.
 *
 * We build a client with one connected server whose single tool declares a
 * real inputSchema, then spy on the private `executeToolCall` to assert it is
 * (not) reached.
 */
function makeClientWithSchema(descriptor: MCPToolDescriptor): {
  client: MCPClient;
  executeSpy: ReturnType<typeof vi.fn>;
} {
  const client = new MCPClient();
  const serverConfig: MCPServerConfig = {
    id: descriptor.serverId,
    name: "Schema Server",
    url: "stdio://test",
    transport: "stdio",
  };

  const c = client as unknown as Record<string, unknown>;
  const connections = c["connections"] as Map<string, unknown>;
  connections.set(descriptor.serverId, {
    state: "connected",
    config: serverConfig,
    tools: [descriptor],
    eagerTools: [descriptor],
    deferredTools: [],
  });

  // Replace the real transport call with a spy so we can assert whether the
  // args ever reached it, and return a benign success when they do.
  const executeSpy = vi.fn(async () => ({
    content: [{ type: "text", text: "ok" }],
    isError: false,
  }));
  c["executeToolCall"] = executeSpy;

  return { client, executeSpy };
}

const SEARCH_TOOL: MCPToolDescriptor = {
  name: "search",
  description: "search the index",
  serverId: "srv",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
    },
    required: ["query"],
  },
};

describe("MCPClient.invokeTool() AGENT-H-07 argument validation", () => {
  it("rejects a wrong-typed argument before reaching the transport", async () => {
    const { client, executeSpy } = makeClientWithSchema(SEARCH_TOOL);

    const result = await client.invokeTool("search", {
      query: 123 as unknown as string, // should be string
    });

    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("MCP_ARG_VALIDATION_FAILED");
    expect(result.content[0]?.text).toContain("MCP_ARG_VALIDATION_FAILED");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("rejects a missing required argument before reaching the transport", async () => {
    const { client, executeSpy } = makeClientWithSchema(SEARCH_TOOL);

    const result = await client.invokeTool("search", {
      limit: 10, // `query` (required) omitted
    });

    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("MCP_ARG_VALIDATION_FAILED");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("forwards well-formed args to the transport", async () => {
    const { client, executeSpy } = makeClientWithSchema(SEARCH_TOOL);

    const result = await client.invokeTool("search", {
      query: "hello",
      limit: 5,
    });

    expect(result.isError).toBe(false);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    // The validated (parsed) args are what reach the transport.
    expect(executeSpy).toHaveBeenCalledWith(
      expect.anything(),
      "search",
      expect.objectContaining({ query: "hello", limit: 5 })
    );
  });

  it("skips validation for a schemaless tool (no declared properties)", async () => {
    const schemaless: MCPToolDescriptor = {
      name: "raw",
      description: "no schema",
      serverId: "srv",
      inputSchema: { type: "object", properties: {} },
    };
    const { client, executeSpy } = makeClientWithSchema(schemaless);

    const result = await client.invokeTool("raw", {
      anything: "goes",
      nested: { a: 1 },
    });

    expect(result.isError).toBe(false);
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});
