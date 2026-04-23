/**
 * MCP Server — Exposes DzupAgent capabilities through the MCP JSON-RPC surface.
 *
 * The server is intentionally transport-agnostic. HTTP, stdio, SSE, or in-process
 * integrations can all delegate request handling here and keep protocol behavior
 * centralized in one place.
 */
import type {
  MCPResource,
  MCPResourceContent,
  MCPResourceTemplate,
} from './mcp-resource-types.js'
import type {
  MCPSamplingRequest,
  SamplingHandler,
} from './mcp-sampling-types.js'
import type {
  MCPToolDescriptor,
  MCPToolParameter,
  MCPToolResult,
} from './mcp-types.js'

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

export interface MCPServerCapabilities {
  tools?: {
    listChanged?: boolean
  }
  resources?: {
    subscribe?: boolean
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
  /** Optional capability overrides */
  capabilities?: MCPServerCapabilities
  /** Optional sampling handler for in-process/loopback usage */
  samplingHandler?: SamplingHandler
}

// ---------------------------------------------------------------------------
// JSON-RPC error codes
// ---------------------------------------------------------------------------

const JSON_RPC_INVALID_REQUEST = -32600
const JSON_RPC_METHOD_NOT_FOUND = -32601
const JSON_RPC_INVALID_PARAMS = -32602
const JSON_RPC_INTERNAL_ERROR = -32000
const DEFAULT_PROTOCOL_VERSION = '2024-11-05'

// ---------------------------------------------------------------------------
// DzupAgentMCPServer
// ---------------------------------------------------------------------------

/**
 * Lightweight MCP server that exposes registered tools via JSON-RPC.
 *
 * Usage:
 * ```ts
 * const server = new DzupAgentMCPServer({
 *   name: 'forge-codegen',
 *   version: '1.0.0',
 *   tools: [{ name: 'generate', description: '...', inputSchema: {...}, handler: async (args) => '...' }],
 * })
 *
 * // In your transport layer (HTTP, stdio, SSE):
 * const response = await server.handleRequest(jsonRpcRequest)
 * ```
 */
export class DzupAgentMCPServer {
  private readonly serverName: string
  private readonly serverVersion: string
  private readonly protocolVersion: string
  private readonly tools: Map<string, MCPExposedTool> = new Map()
  private readonly resources: Map<string, MCPExposedResource> = new Map()
  private readonly resourceTemplates: Map<string, MCPExposedResourceTemplate> = new Map()
  private readonly capabilityOverrides: MCPServerCapabilities | undefined
  private readonly samplingHandler: SamplingHandler | undefined

  constructor(options: MCPServerOptions) {
    this.serverName = options.name
    this.serverVersion = options.version
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION
    this.capabilityOverrides = options.capabilities
    this.samplingHandler = options.samplingHandler

    for (const tool of options.tools ?? []) {
      this.tools.set(tool.name, tool)
    }
    for (const resource of options.resources ?? []) {
      this.resources.set(resource.uri, resource)
    }
    for (const template of options.resourceTemplates ?? []) {
      this.resourceTemplates.set(template.uriTemplate, template)
    }
  }

  /** Server name (used in tool descriptors and initialize response). */
  get name(): string { return this.serverName }

  /** Server version. */
  get version(): string { return this.serverVersion }

  /** MCP protocol version advertised during initialize. */
  get advertisedProtocolVersion(): string { return this.protocolVersion }

  /** Register an additional tool after construction. */
  registerTool(tool: MCPExposedTool): void {
    this.tools.set(tool.name, tool)
  }

  /** Remove a registered tool by name. */
  unregisterTool(name: string): void {
    this.tools.delete(name)
  }

  /** Register an additional resource after construction. */
  registerResource(resource: MCPExposedResource): void {
    this.resources.set(resource.uri, resource)
  }

  /** Remove a registered resource by URI. */
  unregisterResource(uri: string): void {
    this.resources.delete(uri)
  }

  /** Register a resource template after construction. */
  registerResourceTemplate(template: MCPExposedResourceTemplate): void {
    this.resourceTemplates.set(template.uriTemplate, template)
  }

  /** Remove a resource template by URI template. */
  unregisterResourceTemplate(uriTemplate: string): void {
    this.resourceTemplates.delete(uriTemplate)
  }

  /** List all registered tools as MCP descriptors. */
  listTools(): MCPToolDescriptor[] {
    const descriptors: MCPToolDescriptor[] = []
    for (const tool of this.tools.values()) {
      const requiredFields = tool.inputSchema['required'] as string[] | undefined
      descriptors.push({
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: 'object',
          properties: (tool.inputSchema['properties'] ?? {}) as Record<string, MCPToolParameter>,
          ...(requiredFields !== undefined && { required: requiredFields }),
        },
        serverId: this.serverName,
      })
    }
    return descriptors
  }

  /** List all registered resources as MCP descriptors. */
  listResources(): MCPResource[] {
    return [...this.resources.values()].map(resource => ({
      uri: resource.uri,
      name: resource.name,
      ...(resource.description !== undefined && { description: resource.description }),
      ...(resource.mimeType !== undefined && { mimeType: resource.mimeType }),
    }))
  }

  /** List all registered resource templates. */
  listResourceTemplates(): MCPResourceTemplate[] {
    return [...this.resourceTemplates.values()].map(template => ({
      uriTemplate: template.uriTemplate,
      name: template.name,
      ...(template.description !== undefined && { description: template.description }),
      ...(template.mimeType !== undefined && { mimeType: template.mimeType }),
    }))
  }

  /** Return the advertised MCP capabilities for this server. */
  getCapabilities(): MCPServerCapabilities {
    const capabilities: MCPServerCapabilities = {}

    if (this.tools.size > 0 || this.capabilityOverrides?.tools) {
      capabilities.tools = {
        ...(this.capabilityOverrides?.tools ?? {}),
      }
    }

    if (this.resources.size > 0 || this.resourceTemplates.size > 0 || this.capabilityOverrides?.resources) {
      capabilities.resources = {
        ...(this.capabilityOverrides?.resources ?? {}),
      }
    }

    if (this.samplingHandler || this.capabilityOverrides?.sampling) {
      capabilities.sampling = {
        ...(this.capabilityOverrides?.sampling ?? {}),
      }
    }

    return capabilities
  }

  /** Handle a JSON-RPC request implementing the MCP server protocol surface. */
  async handleRequest(request: MCPRequest): Promise<MCPResponse | null> {
    if (!isMCPRequest(request)) {
      return this.buildError(null, JSON_RPC_INVALID_REQUEST, 'Invalid MCP request')
    }

    const hasId = Object.prototype.hasOwnProperty.call(request, 'id')
    const { id, method, params } = request
    const responseId = hasId ? (id ?? null) : null

    let response: MCPResponse
    switch (method) {
      case 'initialize':
        response = this.buildResult(responseId, this.buildInitializeResult())
        break

      case 'tools/list':
        response = this.buildResult(responseId, { tools: this.listTools() })
        break
      case 'tools/call':
        response = await this.handleToolCall(responseId, params)
        break

      case 'resources/list':
        response = this.buildResult(responseId, { resources: this.listResources() })
        break
      case 'resources/templates/list':
        response = this.buildResult(responseId, { resourceTemplates: this.listResourceTemplates() })
        break
      case 'resources/read':
        response = await this.handleResourceRead(responseId, params)
        break

      case 'sampling/createMessage':
        response = await this.handleSamplingRequest(responseId, params)
        break
      default:
        response = this.buildError(responseId, JSON_RPC_METHOD_NOT_FOUND, `Unknown method: ${method}`)
    }

    return hasId ? response : null
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async handleToolCall(
    id: MCPRequestId,
    params: Record<string, unknown> | undefined,
  ): Promise<MCPResponse> {
    if (!params || typeof params['name'] !== 'string') {
      return this.buildError(id, JSON_RPC_INVALID_PARAMS, 'Missing required param: name')
    }

    const toolName = params['name'] as string
    const tool = this.tools.get(toolName)

    if (!tool) {
      return this.buildError(
        id,
        JSON_RPC_METHOD_NOT_FOUND,
        `Tool not found: ${toolName}`,
        { availableTools: [...this.tools.keys()] },
      )
    }

    const args = (params['arguments'] ?? {}) as Record<string, unknown>

    try {
      const result = await tool.handler(args)
      if (typeof result === 'string') {
        return this.buildResult(id, {
          content: [{ type: 'text', text: result }],
          isError: false,
        } satisfies MCPToolResult)
      }
      return this.buildResult(id, {
        ...result,
        isError: result.isError ?? false,
      } satisfies MCPToolResult)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return this.buildError(id, JSON_RPC_INTERNAL_ERROR, `Tool execution failed: ${message}`, {
        toolName,
      })
    }
  }

  private async handleResourceRead(
    id: MCPRequestId,
    params: Record<string, unknown> | undefined,
  ): Promise<MCPResponse> {
    if (!params || typeof params['uri'] !== 'string') {
      return this.buildError(id, JSON_RPC_INVALID_PARAMS, 'Missing required param: uri')
    }

    const uri = params['uri']
    const resource = this.resources.get(uri)
    if (resource) {
      const content = await resource.read?.()
      return this.buildResult(id, {
        contents: [normalizeResourceContent(content, {
          uri,
          ...(resource.mimeType !== undefined && { mimeType: resource.mimeType }),
        })],
      })
    }

    const template = this.findResourceTemplate(uri)
    if (template) {
      const content = await template.read(uri)
      return this.buildResult(id, {
        contents: [normalizeResourceContent(content, {
          uri,
          ...(template.mimeType !== undefined && { mimeType: template.mimeType }),
        })],
      })
    }

    return this.buildError(id, JSON_RPC_METHOD_NOT_FOUND, `Resource not found: ${uri}`)
  }

  private async handleSamplingRequest(
    id: MCPRequestId,
    params: Record<string, unknown> | undefined,
  ): Promise<MCPResponse> {
    if (!this.samplingHandler) {
      return this.buildError(id, JSON_RPC_METHOD_NOT_FOUND, 'Sampling is not enabled for this server')
    }

    try {
      const response = await this.samplingHandler((params ?? {}) as unknown as MCPSamplingRequest)
      return this.buildResult(id, response)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return this.buildError(id, JSON_RPC_INTERNAL_ERROR, `Sampling failed: ${message}`)
    }
  }

  private findResourceTemplate(uri: string): MCPExposedResourceTemplate | undefined {
    for (const template of this.resourceTemplates.values()) {
      if (matchesResourceTemplate(template.uriTemplate, uri)) {
        return template
      }
    }
    return undefined
  }

  private buildInitializeResult(): MCPInitializeResult {
    return {
      protocolVersion: this.protocolVersion,
      serverInfo: {
        name: this.serverName,
        version: this.serverVersion,
      },
      capabilities: this.getCapabilities(),
    }
  }

  private buildResult(id: MCPRequestId, result: unknown): MCPResponse {
    return { jsonrpc: '2.0', id, result }
  }

  private buildError(
    id: MCPRequestId,
    code: number,
    message: string,
    data?: unknown,
  ): MCPResponse {
    return { jsonrpc: '2.0', id, error: { code, message, data } }
  }
}

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

function isValidMCPRequestId(id: unknown): id is MCPRequestId | undefined {
  return id === undefined || id === null || typeof id === 'string' || typeof id === 'number'
}

function isValidMCPParams(params: unknown): boolean {
  return params === undefined || Array.isArray(params) || (params !== null && typeof params === 'object')
}

function normalizeResourceContent(
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

function matchesResourceTemplate(uriTemplate: string, uri: string): boolean {
  const escaped = uriTemplate
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{[^/]+?\\\}/g, '[^/]+')

  return new RegExp(`^${escaped}$`).test(uri)
}
