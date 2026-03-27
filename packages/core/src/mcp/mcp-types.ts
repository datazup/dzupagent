/**
 * MCP (Model Context Protocol) type definitions.
 *
 * Covers client configuration, tool descriptors, transport options,
 * and the deferred-loading strategy for large tool sets.
 */

/** Transport type for MCP connections */
export type MCPTransport = 'sse' | 'http' | 'stdio'

/** Configuration for connecting to an MCP server */
export interface MCPServerConfig {
  /** Unique identifier for this server connection */
  id: string
  /** Human-readable name */
  name: string
  /** Server URL (for sse/http) or command (for stdio) */
  url: string
  /** Transport mechanism */
  transport: MCPTransport
  /** Command arguments (for stdio transport) */
  args?: string[]
  /** Environment variables to pass (for stdio transport) */
  env?: Record<string, string>
  /** Connection timeout in milliseconds (default 10_000) */
  timeoutMs?: number
  /** Headers to send with HTTP/SSE requests */
  headers?: Record<string, string>
  /** Maximum number of tools to load eagerly (rest deferred) */
  maxEagerTools?: number
}

/** MCP tool parameter schema (JSON Schema subset) */
export interface MCPToolParameter {
  type: string
  description?: string
  required?: boolean
  properties?: Record<string, MCPToolParameter>
  items?: MCPToolParameter
  enum?: unknown[]
  default?: unknown
}

/** Tool descriptor returned by MCP server */
export interface MCPToolDescriptor {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, MCPToolParameter>
    required?: string[]
  }
  /** Which MCP server this tool came from */
  serverId: string
}

/** Result of invoking an MCP tool */
export interface MCPToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource'
    text?: string
    data?: string
    mimeType?: string
  }>
  isError?: boolean
}

/** Connection state for an MCP server */
export type MCPConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

/** Status of an MCP server connection */
export interface MCPServerStatus {
  id: string
  name: string
  state: MCPConnectionState
  toolCount: number
  /** Number of tools loaded eagerly vs deferred */
  eagerToolCount: number
  deferredToolCount: number
  lastError?: string
}
