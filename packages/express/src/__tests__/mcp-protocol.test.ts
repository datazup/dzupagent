import type { Request } from "express";
import { describe, expect, it } from "vitest";
import type { MCPRequest, MCPResponse } from "@dzupagent/core/pipeline";
import {
  classifyMcpHttpRequest,
  decorateCurrentMcpResponse,
} from "../mcp-protocol.js";
import type { MCPRouterProtocolConfig } from "../types.js";

const protocol: MCPRouterProtocolConfig = {
  legacyVersions: ["2025-11-25"],
  current: {
    version: "2026-07-28",
    serverInfo: { name: "test-server", version: "1.0.0" },
    capabilities: { tools: {} },
  },
};

function request(headers: Record<string, string>): Request {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    get(name: string) {
      return lower[name.toLowerCase()];
    },
  } as Request;
}

function currentRequest(
  method = "tools/list",
  params: Record<string, unknown> = {}
): MCPRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

describe("current MCP HTTP protocol boundary", () => {
  it("accepts matching stateless metadata and ignores a legacy session header", () => {
    const result = classifyMcpHttpRequest(
      request({
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list",
        "Mcp-Session-Id": "ignored-legacy-session",
      }),
      currentRequest(),
      protocol
    );

    expect(result).toEqual({
      ok: true,
      current: true,
      context: { protocolVersion: "2026-07-28" },
    });
  });

  it("rejects missing capabilities and header/body mismatches", () => {
    const missingCapabilities = currentRequest();
    delete (
      missingCapabilities.params?.["_meta"] as Record<string, unknown>
    )["io.modelcontextprotocol/clientCapabilities"];

    const missing = classifyMcpHttpRequest(
      request({
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list",
      }),
      missingCapabilities,
      protocol
    );
    expect(missing).toMatchObject({
      ok: false,
      status: 400,
      response: { error: { code: -32020 } },
    });

    const mismatch = classifyMcpHttpRequest(
      request({
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "wrong",
      }),
      currentRequest("tools/call", { name: "expected", arguments: {} }),
      protocol
    );
    expect(mismatch).toMatchObject({
      ok: false,
      status: 400,
      response: { error: { code: -32020 } },
    });
  });

  it("decodes the Base64 sentinel before comparing Mcp-Name", () => {
    const encoded = Buffer.from("résumé", "utf8").toString("base64");
    const result = classifyMcpHttpRequest(
      request({
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "prompts/get",
        "Mcp-Name": `=?base64?${encoded}?=`,
      }),
      currentRequest("prompts/get", { name: "résumé", arguments: {} }),
      protocol
    );
    expect(result).toMatchObject({ ok: true, current: true });
  });

  it("rejects unknown revisions with the protocol-defined error", () => {
    const result = classifyMcpHttpRequest(
      request({ "MCP-Protocol-Version": "2099-01-01" }),
      { jsonrpc: "2.0", id: 7, method: "tools/list" },
      protocol
    );
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      response: {
        id: 7,
        error: {
          code: -32022,
          data: { requested: "2099-01-01" },
        },
      },
    });
  });

  it("adds current result metadata, safe cache hints, and deterministic list order", () => {
    const response: MCPResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [{ name: "zeta" }, { name: "alpha" }],
      },
    };
    expect(decorateCurrentMcpResponse("tools/list", response, protocol)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [{ name: "alpha" }, { name: "zeta" }],
        ttlMs: 0,
        cacheScope: "private",
        resultType: "complete",
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "test-server",
            version: "1.0.0",
          },
        },
      },
    });
  });
});
