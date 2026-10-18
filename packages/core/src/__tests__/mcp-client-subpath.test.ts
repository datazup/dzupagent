import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as subpath from "../mcp-client.js";
import { MCPClient } from "../mcp/mcp-client.js";
import { McpConnectionPool } from "../mcp/mcp-connection-pool.js";
import { McpReliabilityManager } from "../mcp/mcp-reliability.js";
import * as capabilities from "../mcp/mcp-transport-capabilities.js";
import * as security from "../mcp/mcp-security.js";

/**
 * B-05 (DZA-WAVE1-20261018-R1): `@dzupagent/core/mcp-client` publishes the MCP
 * client, connection pool, reliability manager, transport capability helpers
 * and stdio security controls as pure re-exports of the `src/mcp/` modules.
 */
function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("@dzupagent/core/mcp-client subpath", () => {
  it("exports exactly the named runtime symbols", () => {
    expect(Object.keys(subpath).sort()).toEqual([
      "MCPClient",
      "MCPTransportCapabilityValidationError",
      "MCPUnsupportedTransportError",
      "McpConnectionPool",
      "McpReliabilityManager",
      "assertMcpCommandAllowed",
      "getMcpTransportCapability",
      "listMcpTransportCapabilities",
      "sanitizeMcpEnv",
      "validateMcpExecutablePath",
      "validateTransportCapabilityDescriptor",
    ]);
  });

  it("re-exports the src/mcp implementations by identity", () => {
    expect(subpath.MCPClient).toBe(MCPClient);
    expect(subpath.McpConnectionPool).toBe(McpConnectionPool);
    expect(subpath.McpReliabilityManager).toBe(McpReliabilityManager);
    expect(subpath.getMcpTransportCapability).toBe(capabilities.getMcpTransportCapability);
    expect(subpath.listMcpTransportCapabilities).toBe(capabilities.listMcpTransportCapabilities);
    expect(subpath.validateTransportCapabilityDescriptor).toBe(
      capabilities.validateTransportCapabilityDescriptor,
    );
    expect(subpath.MCPTransportCapabilityValidationError).toBe(
      capabilities.MCPTransportCapabilityValidationError,
    );
    expect(subpath.MCPUnsupportedTransportError).toBe(capabilities.MCPUnsupportedTransportError);
    expect(subpath.validateMcpExecutablePath).toBe(security.validateMcpExecutablePath);
    expect(subpath.assertMcpCommandAllowed).toBe(security.assertMcpCommandAllowed);
    expect(subpath.sanitizeMcpEnv).toBe(security.sanitizeMcpEnv);
  });

  it("package.json publishes the ./mcp-client subpath", () => {
    const manifest = JSON.parse(readSource("../../package.json")) as {
      exports: Record<string, { import?: string; types?: string }>;
    };
    expect(manifest.exports["./mcp-client"]).toEqual({
      types: "./dist/mcp-client.d.ts",
      import: "./dist/mcp-client.js",
    });
  });

  it("tsup emits the subpath entry", () => {
    expect(readSource("../../tsup.config.ts")).toContain('"src/mcp-client.ts"');
  });
});
