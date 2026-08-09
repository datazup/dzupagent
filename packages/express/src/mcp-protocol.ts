import type { Request } from "express";
import type {
  MCPRequest,
  MCPRequestId,
  MCPResponse,
} from "@dzupagent/core/pipeline";
import type {
  MCPRequestProtocolContext,
  MCPRouterProtocolConfig,
} from "./types.js";

export const LEGACY_MCP_PROTOCOL_VERSION = "2025-11-25";
export const CURRENT_MCP_PROTOCOL_VERSION = "2026-07-28";

export const MCP_HEADER_MISMATCH = -32020;
export const MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;

export type MCPHttpClassification =
  | { ok: true; context: MCPRequestProtocolContext; current: boolean }
  | { ok: false; status: 400; response: MCPResponse };

export function classifyMcpHttpRequest(
  req: Request,
  request: MCPRequest,
  config: MCPRouterProtocolConfig | undefined
): MCPHttpClassification {
  if (!config) return { ok: true, context: {}, current: false };

  const currentVersion =
    config.current?.version ?? CURRENT_MCP_PROTOCOL_VERSION;
  const legacyVersions = new Set(
    config.legacyVersions ?? [LEGACY_MCP_PROTOCOL_VERSION]
  );
  const headerVersion = req.get("MCP-Protocol-Version");
  const meta = requestMeta(request);
  const metaVersion = meta?.["io.modelcontextprotocol/protocolVersion"];
  const id = requestId(request);
  const currentIntent =
    headerVersion === currentVersion || metaVersion === currentVersion;

  if (currentIntent) {
    if (!config.current) {
      return unsupported(
        id,
        String(headerVersion ?? metaVersion),
        [...legacyVersions]
      );
    }
    if (!meta) {
      return invalidParams(id, "request params must include _meta");
    }
    if (typeof metaVersion !== "string") {
      return invalidParams(
        id,
        "request _meta must include io.modelcontextprotocol/protocolVersion"
      );
    }
    if (headerVersion !== currentVersion || metaVersion !== currentVersion) {
      return mismatch(
        id,
        "MCP-Protocol-Version header must match request _meta protocol version"
      );
    }

    const clientCapabilities =
      meta["io.modelcontextprotocol/clientCapabilities"];
    if (!isRecord(clientCapabilities)) {
      return invalidParams(
        id,
        "request _meta must include object io.modelcontextprotocol/clientCapabilities"
      );
    }

    const clientInfo = meta["io.modelcontextprotocol/clientInfo"];
    if (clientInfo !== undefined && !isImplementation(clientInfo)) {
      return invalidParams(
        id,
        "io.modelcontextprotocol/clientInfo must contain string name and version"
      );
    }

    const methodHeader = req.get("Mcp-Method");
    if (methodHeader !== request.method) {
      return mismatch(
        id,
        `Mcp-Method header must match request method ${request.method}`
      );
    }

    const expectedName = requestRoutingName(request);
    if (expectedName !== undefined) {
      const rawName = req.get("Mcp-Name");
      const decodedName = decodeMcpHeaderValue(rawName);
      if (decodedName === null || decodedName !== expectedName) {
        return mismatch(id, "Mcp-Name header must match the request name or uri");
      }
    }

    return {
      ok: true,
      current: true,
      context: { protocolVersion: currentVersion },
    };
  }

  if (headerVersion && !legacyVersions.has(headerVersion)) {
    return unsupported(id, headerVersion, [currentVersion]);
  }
  if (typeof metaVersion === "string" && !legacyVersions.has(metaVersion)) {
    return unsupported(id, metaVersion, [currentVersion]);
  }

  return {
    ok: true,
    current: false,
    context: headerVersion ? { protocolVersion: headerVersion } : {},
  };
}

export function buildCurrentMcpDiscoverResponse(
  request: MCPRequest,
  config: MCPRouterProtocolConfig
): MCPResponse {
  const current = config.current;
  if (!current) throw new Error("current MCP protocol is not configured");
  return {
    jsonrpc: "2.0",
    id: requestId(request),
    result: {
      supportedVersions: [current.version ?? CURRENT_MCP_PROTOCOL_VERSION],
      capabilities: current.capabilities ?? {},
      ...(current.instructions !== undefined && {
        instructions: current.instructions,
      }),
    },
  };
}

export function decorateCurrentMcpResponse(
  method: string,
  response: MCPResponse,
  config: MCPRouterProtocolConfig
): MCPResponse {
  const current = config.current;
  if (!current || !isRecord(response.result)) return response;

  const result = sortCurrentListResult(method, response.result);
  const cacheable = CURRENT_CACHEABLE_METHODS.has(method);
  return {
    ...response,
    result: {
      ...result,
      ...(cacheable && {
        ttlMs: current.cache?.ttlMs ?? 0,
        cacheScope: current.cache?.cacheScope ?? "private",
      }),
      resultType: "complete",
      _meta: {
        ...(isRecord(result["_meta"]) ? result["_meta"] : {}),
        "io.modelcontextprotocol/serverInfo": current.serverInfo,
      },
    },
  };
}

const CURRENT_CACHEABLE_METHODS = new Set([
  "server/discover",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
]);

const LIST_KEYS: Record<string, { key: string; identity: string }> = {
  "tools/list": { key: "tools", identity: "name" },
  "resources/list": { key: "resources", identity: "uri" },
  "resources/templates/list": {
    key: "resourceTemplates",
    identity: "uriTemplate",
  },
  "prompts/list": { key: "prompts", identity: "name" },
};

function sortCurrentListResult(
  method: string,
  result: Record<string, unknown>
): Record<string, unknown> {
  const definition = LIST_KEYS[method];
  if (!definition) return result;
  const entries = result[definition.key];
  if (!Array.isArray(entries)) return result;
  return {
    ...result,
    [definition.key]: [...entries].sort((left, right) =>
      identity(left, definition.identity).localeCompare(
        identity(right, definition.identity)
      )
    ),
  };
}

function identity(value: unknown, key: string): string {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

function requestMeta(request: MCPRequest): Record<string, unknown> | undefined {
  if (!isRecord(request.params)) return undefined;
  const meta = request.params["_meta"];
  return isRecord(meta) ? meta : undefined;
}

function requestRoutingName(request: MCPRequest): string | undefined {
  if (!isRecord(request.params)) return undefined;
  if (request.method === "resources/read") {
    return typeof request.params["uri"] === "string"
      ? request.params["uri"]
      : undefined;
  }
  if (request.method === "tools/call" || request.method === "prompts/get") {
    return typeof request.params["name"] === "string"
      ? request.params["name"]
      : undefined;
  }
  return undefined;
}

function decodeMcpHeaderValue(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const encoded = value.slice("=?base64?".length, -2);
  try {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) return null;
    return decoded.toString("utf8");
  } catch {
    return null;
  }
}

function mismatch(id: MCPRequestId, message: string): MCPHttpClassification {
  return {
    ok: false,
    status: 400,
    response: {
      jsonrpc: "2.0",
      id,
      error: { code: MCP_HEADER_MISMATCH, message: `Header mismatch: ${message}` },
    },
  };
}

function unsupported(
  id: MCPRequestId,
  requested: string,
  supported: string[]
): MCPHttpClassification {
  return {
    ok: false,
    status: 400,
    response: {
      jsonrpc: "2.0",
      id,
      error: {
        code: MCP_UNSUPPORTED_PROTOCOL_VERSION,
        message: `Unsupported MCP protocol version: ${requested}`,
        data: {
          supported,
          requested,
        },
      },
    },
  };
}

function invalidParams(
  id: MCPRequestId,
  message: string
): MCPHttpClassification {
  return {
    ok: false,
    status: 400,
    response: {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: `Invalid params: ${message}` },
    },
  };
}

function requestId(request: MCPRequest): MCPRequestId {
  return Object.prototype.hasOwnProperty.call(request, "id")
    ? request.id ?? null
    : null;
}

function isImplementation(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    typeof value["version"] === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
