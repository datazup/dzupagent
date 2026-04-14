/**
 * MCP domain types for adapter-level MCP server management and bindings.
 *
 * These types model the relationship between external MCP servers and
 * the AI agent adapters that consume them. An AdapterMcpServer represents
 * a registered MCP server instance, while an AdapterMcpBinding connects
 * a server to a specific provider adapter with mode and tool filtering.
 */

import type { AdapterProviderId } from '../types.js'

/** Registered MCP server that can be bound to adapters. */
export interface AdapterMcpServer {
  /** Unique server identifier */
  id: string
  /** Transport mechanism for connecting to the server */
  transport: 'http' | 'sse' | 'stdio'
  /** Server URL (for http/sse) or command path (for stdio) */
  endpoint: string
  /** Command arguments (for stdio transport) */
  args?: string[]
  /** Environment variables to pass (for stdio transport) */
  env?: Record<string, string>
  /** Headers to send with HTTP/SSE requests */
  headers?: Record<string, string>
  /** Whether this server is active and available for bindings */
  enabled: boolean
  /** Classification tags for filtering and routing */
  tags?: string[]
  /** ISO 8601 creation timestamp */
  createdAt: string
  /** ISO 8601 last-updated timestamp */
  updatedAt: string
}

/** Binding that connects an MCP server to a specific provider adapter. */
export interface AdapterMcpBinding {
  /** Unique binding identifier */
  id: string
  /** The adapter provider this binding targets */
  providerId: AdapterProviderId
  /** The MCP server being bound */
  serverId: string
  /** Whether this binding is active */
  enabled: boolean
  /** How the adapter consumes MCP tools from this server */
  mode: 'native' | 'tool-bridge' | 'prompt-injection'
  /** If set, only these tools are exposed to the adapter */
  toolAllowlist?: string[]
  /** If set, these tools are excluded from the adapter */
  toolDenylist?: string[]
  /** ISO 8601 creation timestamp */
  createdAt: string
  /** ISO 8601 last-updated timestamp */
  updatedAt: string
}

/** Result of an MCP server connectivity test. */
export interface McpServerTestResult {
  ok: boolean
  toolCount?: number
  error?: string
}

/** Effective MCP configuration resolved for a specific provider adapter. */
export interface EffectiveMcpConfig {
  servers: Array<{
    server: AdapterMcpServer
    binding: AdapterMcpBinding
  }>
}
