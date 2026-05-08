/**
 * MCP Server — Exposes DzupAgent capabilities through the MCP JSON-RPC surface.
 *
 * The server is intentionally transport-agnostic. HTTP, stdio, SSE, or in-process
 * integrations can all delegate request handling here and keep protocol behavior
 * centralized in one place.
 *
 * This module is a thin barrel that re-exports from focused sibling modules:
 *
 * - `mcp-server-types.ts` — JSON-RPC envelope, exposed entities, options, capabilities
 * - `mcp-server-utils.ts` — request/param validation, envelope builders, URI matching
 * - `mcp-server-handlers.ts` — tool/resource/prompt/sampling method implementations
 * - `mcp-server-core.ts` — `DzupAgentMCPServer` class (registries + request router)
 *
 * Callers continue to import from `./mcp-server.js`; no caller changes are required.
 */

export {
  DzupAgentMCPServer,
} from './mcp-server-core.js'

export type {
  MCPExposedPrompt,
  MCPExposedResource,
  MCPExposedResourceTemplate,
  MCPExposedTool,
  MCPInitializeResult,
  MCPRequest,
  MCPRequestId,
  MCPResponse,
  MCPServerCapabilities,
  MCPServerOptions,
} from './mcp-server-types.js'

export { isMCPRequest } from './mcp-server-utils.js'
