/**
 * `@dzupagent/core/mcp-client` — client-only MCP subpath (B-05).
 *
 * Publishes the MCP client together with the connection pool, the reliability
 * manager, the transport capability helpers and the stdio security controls
 * that callers must keep in front of the client, so consuming apps can drop
 * their hand-rolled JSON-RPC clients without importing the growth-frozen root
 * barrel. Pure re-exports: no behaviour lives here. Pinned by
 * `__tests__/mcp-client-subpath.test.ts`.
 *
 * @module core/mcp-client
 */

export { MCPClient } from "./mcp/mcp-client.js";
export { McpConnectionPool } from "./mcp/mcp-connection-pool.js";
export type { McpConnectionPoolConfig } from "./mcp/mcp-connection-pool.js";
export { McpReliabilityManager } from "./mcp/mcp-reliability.js";
export type {
  McpReliabilityConfig,
  McpServerHealth,
} from "./mcp/mcp-reliability.js";
export {
  getMcpTransportCapability,
  listMcpTransportCapabilities,
  validateTransportCapabilityDescriptor,
  MCPTransportCapabilityValidationError,
  MCPUnsupportedTransportError,
} from "./mcp/mcp-transport-capabilities.js";
export type { MCPTransportCapabilityDescriptor } from "./mcp/mcp-transport-capabilities.js";
export {
  validateMcpExecutablePath,
  assertMcpCommandAllowed,
  sanitizeMcpEnv,
} from "./mcp/mcp-security.js";
export type { McpStdioArgPolicy } from "./mcp/mcp-security.js";
export type {
  MCPTransport,
  MCPServerConfig,
  MCPToolDescriptor,
  MCPToolAnnotations,
  MCPToolOutputSchema,
  MCPToolParameter,
  MCPToolResult,
  MCPConnectionState,
  MCPServerStatus,
} from "./mcp/mcp-types.js";
