import { describe, it, expect } from "vitest";
import { MCPClient } from "../mcp-client.js";
import type { MCPServerConfig } from "../mcp-types.js";

/**
 * Build a minimal MCPClient with one fake "connected" server and one registered
 * tool, so invokeTool() reaches the path-guard check without a real transport.
 *
 * MCPClient internals (from source):
 *   - `connections`: Map<string, ServerConnection>
 *     ServerConnection = { config, state, tools, eagerTools, deferredTools, ... }
 *   - findTool() iterates conn.tools for each connection
 */
function makeClient(filesystemRoot?: string): MCPClient {
  const client = new MCPClient();
  const serverConfig: MCPServerConfig = {
    id: "test-fs-server",
    name: "Test FS Server",
    url: "stdio://test",
    transport: "stdio",
    ...(filesystemRoot !== undefined ? { filesystemRoot } : {}),
  };

  // Reach into the private `connections` Map via cast.
  const c = client as unknown as Record<string, unknown>;
  const connections = c["connections"] as Map<
    string,
    {
      state: string;
      config: MCPServerConfig;
      tools: Array<{ name: string; serverId: string }>;
      eagerTools: Array<{ name: string; serverId: string }>;
      deferredTools: Array<{ name: string; serverId: string }>;
    }
  >;

  connections.set("test-fs-server", {
    state: "connected",
    config: serverConfig,
    tools: [{ name: "read_file", serverId: "test-fs-server" }],
    eagerTools: [{ name: "read_file", serverId: "test-fs-server" }],
    deferredTools: [],
  });

  return client;
}

describe("MCPClient jailed-fs path-escape guard", () => {
  it("allows a safe relative path when filesystemRoot is configured", async () => {
    const client = makeClient("/workspace/tenant-a");
    const result = await client.invokeTool("read_file", {
      path: "src/main.ts",
    });
    // Transport will fail (no real stdio), but NOT with a path-escape error.
    if (result.isError) {
      expect(result.content[0]?.text).not.toContain("MCP_PATH_ESCAPE");
    }
  });

  it("rejects a traversal path when filesystemRoot is configured", async () => {
    const client = makeClient("/workspace/tenant-a");
    const result = await client.invokeTool("read_file", {
      path: "../../etc/passwd",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("MCP_PATH_ESCAPE");
  });

  it("rejects an absolute path outside root when filesystemRoot is configured", async () => {
    const client = makeClient("/workspace/tenant-a");
    const result = await client.invokeTool("read_file", {
      path: "/etc/shadow",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("MCP_PATH_ESCAPE");
  });

  it("does NOT apply the guard when filesystemRoot is not configured", async () => {
    const client = makeClient(); // no filesystemRoot
    const result = await client.invokeTool("read_file", {
      path: "../../etc/passwd",
    });
    // Will fail for transport reasons, but not for path-escape.
    if (result.isError) {
      expect(result.content[0]?.text).not.toContain("MCP_PATH_ESCAPE");
    }
  });

  it("does not block non-path argument keys", async () => {
    const client = makeClient("/workspace/tenant-a");
    // 'query' is not in PATH_ARG_KEYS — traversal-like value is not blocked.
    const result = await client.invokeTool("read_file", {
      query: "../../etc/passwd",
    });
    if (result.isError) {
      expect(result.content[0]?.text).not.toContain("MCP_PATH_ESCAPE");
    }
  });
});
