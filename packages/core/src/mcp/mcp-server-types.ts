/**
 * MCP Server type definitions — JSON-RPC envelope, exposed entities, options.
 *
 * These types form the public protocol surface used by `DzupAgentMCPServer`.
 * They are kept in a dedicated module so transports and tests can import
 * shapes without pulling in the server runtime.
 */
import type {
  MCPPromptArgument,
  MCPPromptHandler,
} from './mcp-prompt-types.js'
import type { MCPResourceContent } from './mcp-resource-types.js'
import type { SamplingHandler } from './mcp-sampling-types.js'
import type { MCPToolResult } from './mcp-types.js'

// ---------------------------------------------------------------------------
// JSON-RPC types (MCP protocol surface)
// ---------------------------------------------------------------------------

export type MCPRequestId = string | number | null

export interface MCPRequest {
  jsonrpc: '2.0'
  id?: MCPRequestId
  method: string
  params?: Record<string, unknown>
}

export interface MCPResponse {
  jsonrpc: '2.0'
  id: MCPRequestId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

// ---------------------------------------------------------------------------
// Server types
// ---------------------------------------------------------------------------

export interface MCPExposedTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<string | MCPToolResult>
}

export interface MCPExposedResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
  read?: () => Promise<string | MCPResourceContent | undefined>
}

export interface MCPExposedResourceTemplate {
  uriTemplate: string
  name: string
  description?: string
  mimeType?: string
  read: (uri: string) => Promise<string | MCPResourceContent | undefined>
}

export interface MCPExposedPrompt {
  name: string
  description?: string
  arguments?: MCPPromptArgument[]
  get: MCPPromptHandler
}

export interface MCPServerCapabilities {
  tools?: {
    listChanged?: boolean
  }
  resources?: {
    subscribe?: boolean
    listChanged?: boolean
  }
  prompts?: {
    listChanged?: boolean
  }
  sampling?: Record<string, never>
}

export interface MCPInitializeResult {
  protocolVersion: string
  serverInfo: {
    name: string
    version: string
  }
  capabilities: MCPServerCapabilities
}

export interface MCPServerOptions {
  /** Human-readable server name */
  name: string
  /** Server version */
  version: string
  /** MCP protocol version to advertise. Default: 2024-11-05 */
  protocolVersion?: string
  /** Initial set of tools to expose */
  tools?: MCPExposedTool[]
  /** Initial set of resources to expose */
  resources?: MCPExposedResource[]
  /** Initial set of resource templates to expose */
  resourceTemplates?: MCPExposedResourceTemplate[]
  /** Initial set of prompts to expose */
  prompts?: MCPExposedPrompt[]
  /** Optional capability overrides */
  capabilities?: MCPServerCapabilities
  /** Optional sampling handler for in-process/loopback usage */
  samplingHandler?: SamplingHandler
}

// ---------------------------------------------------------------------------
// JSON-RPC error codes (shared by handler modules)
// ---------------------------------------------------------------------------

export const JSON_RPC_INVALID_REQUEST = -32600
export const JSON_RPC_METHOD_NOT_FOUND = -32601
export const JSON_RPC_INVALID_PARAMS = -32602
export const JSON_RPC_INTERNAL_ERROR = -32000
export const DEFAULT_PROTOCOL_VERSION = '2024-11-05'
