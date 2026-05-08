/**
 * MCP Server utilities — request validation, JSON-RPC envelope builders,
 * resource-content normalization, URI-template matching.
 *
 * These helpers are pure functions used by the request router and handler
 * modules. They are exported so transports and tests can build/inspect
 * JSON-RPC envelopes without instantiating the server class.
 */
import type { MCPResourceContent } from './mcp-resource-types.js'
import type { MCPRequest, MCPRequestId, MCPResponse } from './mcp-server-types.js'

/** Type guard: validate that an arbitrary value conforms to the MCP request shape. */
export function isMCPRequest(input: unknown): input is MCPRequest {
  if (!input || typeof input !== 'object') return false

  const candidate = input as {
    jsonrpc?: unknown
    id?: unknown
    method?: unknown
    params?: unknown
  }

  return candidate.jsonrpc === '2.0'
    && isValidMCPRequestId(candidate.id)
    && typeof candidate.method === 'string'
    && isValidMCPParams(candidate.params)
}

export function isValidMCPRequestId(id: unknown): id is MCPRequestId | undefined {
  return id === undefined || id === null || typeof id === 'string' || typeof id === 'number'
}

export function isValidMCPParams(params: unknown): boolean {
  return params === undefined || Array.isArray(params) || (params !== null && typeof params === 'object')
}

export function isRecordParams(params: unknown): params is Record<string, unknown> {
  return params !== null && typeof params === 'object' && !Array.isArray(params)
}

/** Build a JSON-RPC success response. */
export function buildResult(id: MCPRequestId, result: unknown): MCPResponse {
  return { jsonrpc: '2.0', id, result }
}

/** Build a JSON-RPC error response. */
export function buildError(
  id: MCPRequestId,
  code: number,
  message: string,
  data?: unknown,
): MCPResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } }
}

export function normalizeResourceContent(
  content: string | MCPResourceContent | undefined,
  fallback: { uri: string; mimeType?: string },
): MCPResourceContent {
  if (typeof content === 'string') {
    return {
      uri: fallback.uri,
      ...(fallback.mimeType !== undefined && { mimeType: fallback.mimeType }),
      text: content,
    }
  }

  if (content && typeof content === 'object') {
    return {
      uri: content.uri ?? fallback.uri,
      ...(content.mimeType !== undefined && { mimeType: content.mimeType }),
      ...(content.text !== undefined && { text: content.text }),
      ...(content.blob !== undefined && { blob: content.blob }),
    }
  }

  return {
    uri: fallback.uri,
    ...(fallback.mimeType !== undefined && { mimeType: fallback.mimeType }),
  }
}

export function matchesResourceTemplate(uriTemplate: string, uri: string): boolean {
  const escaped = uriTemplate
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{[^/]+?\\\}/g, '[^/]+')

  return new RegExp(`^${escaped}$`).test(uri)
}
