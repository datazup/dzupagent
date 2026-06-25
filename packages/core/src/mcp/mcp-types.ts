import type { OutboundUrlSecurityPolicy } from "../security/outbound-url-policy.js";
import type { McpStdioArgPolicy } from "./mcp-security.js";

/**
 * MCP (Model Context Protocol) type definitions.
 *
 * Covers client configuration, tool descriptors, transport options,
 * and the deferred-loading strategy for large tool sets.
 */

/** Transport type for MCP connections */
export type MCPTransport = "sse" | "http" | "stdio";

/** Configuration for connecting to an MCP server */
export interface MCPServerConfig {
  /** Unique identifier for this server connection */
  id: string;
  /** Human-readable name */
  name: string;
  /** Server URL (for sse/http) or command (for stdio) */
  url: string;
  /** Transport mechanism */
  transport: MCPTransport;
  /** Command arguments (for stdio transport) */
  args?: string[];
  /** Environment variables to pass (for stdio transport) */
  env?: Record<string, string>;
  /** Connection timeout in milliseconds (default 10_000) */
  timeoutMs?: number;
  /** Headers to send with HTTP/SSE requests */
  headers?: Record<string, string>;
  /** Outbound URL policy for HTTP/SSE requests. Defaults to public HTTPS only. */
  urlPolicy?: OutboundUrlSecurityPolicy;
  /** Maximum number of tools to load eagerly (rest deferred) */
  maxEagerTools?: number;
  /**
   * Policy for validating stdio command arguments. Defaults to `'strict'`,
   * which rejects interpreter inline-eval invocations (e.g. `node -e …`).
   * Set to `'legacy'` only for fully trusted, pre-existing configs.
   */
  stdioArgPolicy?: McpStdioArgPolicy;
  /**
   * Optional filesystem jail root for this server's tools.
   *
   * When set, any string argument whose key is in `PATH_ARG_KEYS`
   * (`path`, `filePath`, `file`, `dir`, `root`, `directory`) is validated
   * against this root before the tool is invoked. Paths that resolve outside
   * the root are rejected with `MCP_PATH_ESCAPE`. Leave unset to skip
   * the guard (default, backwards compatible).
   */
  filesystemRoot?: string;
  /**
   * Additional MCP shell tool names to inspect for destructive commands beyond
   * the built-in set (bash, execute_command, run_shell, run_command, shell).
   * Used when an operator registers a custom MCP shell server whose tool names
   * differ from the built-in list (e.g. "execute", "terminal").
   */
  shellToolNames?: readonly string[];
}

/** MCP tool parameter schema (JSON Schema subset) */
export interface MCPToolParameter {
  type: string;
  description?: string;
  required?: boolean;
  properties?: Record<string, MCPToolParameter>;
  items?: MCPToolParameter;
  enum?: unknown[];
  default?: unknown;
}

/** Tool descriptor returned by MCP server */
export interface MCPToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, MCPToolParameter>;
    required?: string[];
  };
  /** Which MCP server this tool came from */
  serverId: string;
}

/** Result of invoking an MCP tool */
export interface MCPToolResult {
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
  /** Machine-readable error code for structured error handling. Set by guards; undefined for transport errors. */
  errorCode?: string;
}

/** Connection state for an MCP server */
export type MCPConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

/** Status of an MCP server connection */
export interface MCPServerStatus {
  id: string;
  name: string;
  state: MCPConnectionState;
  toolCount: number;
  /** Number of tools loaded eagerly vs deferred */
  eagerToolCount: number;
  deferredToolCount: number;
  lastError?: string;
}
