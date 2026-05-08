/**
 * DzupAgentMCPServer — transport-agnostic MCP JSON-RPC server class.
 *
 * Owns registries (tools, resources, resource templates, prompts) and the
 * sampling handler, and routes incoming JSON-RPC requests to the appropriate
 * handler module. Protocol behavior lives in `mcp-server-handlers.ts`;
 * envelope/validation helpers live in `mcp-server-utils.ts`.
 */
import type { MCPPromptDescriptor } from './mcp-prompt-types.js'
import type {
  MCPResource,
  MCPResourceTemplate,
} from './mcp-resource-types.js'
import type { SamplingHandler } from './mcp-sampling-types.js'
import {
  handlePromptGet,
  handleResourceRead,
  handleSamplingRequest,
  handleToolCall,
} from './mcp-server-handlers.js'
import type {
  MCPExposedPrompt,
  MCPExposedResource,
  MCPExposedResourceTemplate,
  MCPExposedTool,
  MCPInitializeResult,
  MCPRequest,
  MCPResponse,
  MCPServerCapabilities,
  MCPServerOptions,
} from './mcp-server-types.js'
import {
  DEFAULT_PROTOCOL_VERSION,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
} from './mcp-server-types.js'
import {
  buildError,
  buildResult,
  isMCPRequest,
} from './mcp-server-utils.js'
import type {
  MCPToolDescriptor,
  MCPToolParameter,
} from './mcp-types.js'

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
  private readonly prompts: Map<string, MCPExposedPrompt> = new Map()
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
    for (const prompt of options.prompts ?? []) {
      this.prompts.set(prompt.name, prompt)
    }
  }

  /** Server name (used in tool descriptors and initialize response). */
  get name(): string { return this.serverName }

  /** Server version. */
  get version(): string { return this.serverVersion }

  /** MCP protocol version advertised during initialize. */
  get advertisedProtocolVersion(): string { return this.protocolVersion }

  // Registry mutators — keyed by tool name / resource URI / template / prompt name.
  registerTool(tool: MCPExposedTool): void { this.tools.set(tool.name, tool) }
  unregisterTool(name: string): void { this.tools.delete(name) }
  registerResource(resource: MCPExposedResource): void { this.resources.set(resource.uri, resource) }
  unregisterResource(uri: string): void { this.resources.delete(uri) }
  registerResourceTemplate(template: MCPExposedResourceTemplate): void { this.resourceTemplates.set(template.uriTemplate, template) }
  unregisterResourceTemplate(uriTemplate: string): void { this.resourceTemplates.delete(uriTemplate) }
  registerPrompt(prompt: MCPExposedPrompt): void { this.prompts.set(prompt.name, prompt) }
  unregisterPrompt(name: string): void { this.prompts.delete(name) }

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

  /** List all registered prompts as MCP descriptors. */
  listPrompts(): MCPPromptDescriptor[] {
    return [...this.prompts.values()].map(prompt => ({
      name: prompt.name,
      ...(prompt.description !== undefined && { description: prompt.description }),
      ...(prompt.arguments !== undefined && { arguments: prompt.arguments }),
    }))
  }

  /** Return the advertised MCP capabilities for this server. */
  getCapabilities(): MCPServerCapabilities {
    const capabilities: MCPServerCapabilities = {}

    if (this.tools.size > 0 || this.capabilityOverrides?.tools) {
      capabilities.tools = { ...(this.capabilityOverrides?.tools ?? {}) }
    }
    if (this.resources.size > 0 || this.resourceTemplates.size > 0 || this.capabilityOverrides?.resources) {
      capabilities.resources = { ...(this.capabilityOverrides?.resources ?? {}) }
    }
    if (this.prompts.size > 0 || this.capabilityOverrides?.prompts) {
      capabilities.prompts = { ...(this.capabilityOverrides?.prompts ?? {}) }
    }
    if (this.samplingHandler || this.capabilityOverrides?.sampling) {
      capabilities.sampling = { ...(this.capabilityOverrides?.sampling ?? {}) }
    }

    return capabilities
  }

  /** Handle a JSON-RPC request implementing the MCP server protocol surface. */
  async handleRequest(request: MCPRequest): Promise<MCPResponse | null> {
    if (!isMCPRequest(request)) {
      return buildError(null, JSON_RPC_INVALID_REQUEST, 'Invalid MCP request')
    }

    const hasId = Object.prototype.hasOwnProperty.call(request, 'id')
    const { id, method, params } = request
    const responseId = hasId ? (id ?? null) : null

    let response: MCPResponse
    switch (method) {
      case 'initialize':
        response = buildResult(responseId, this.buildInitializeResult())
        break

      case 'tools/list':
        response = buildResult(responseId, { tools: this.listTools() })
        break
      case 'tools/call':
        response = await handleToolCall(this.tools, responseId, params)
        break

      case 'resources/list':
        response = buildResult(responseId, { resources: this.listResources() })
        break
      case 'resources/templates/list':
        response = buildResult(responseId, { resourceTemplates: this.listResourceTemplates() })
        break
      case 'resources/read':
        response = await handleResourceRead(this.resources, this.resourceTemplates, responseId, params)
        break

      case 'prompts/list':
        response = buildResult(responseId, { prompts: this.listPrompts() })
        break
      case 'prompts/get':
        response = await handlePromptGet(this.prompts, responseId, params)
        break

      case 'sampling/createMessage':
        response = await handleSamplingRequest(this.samplingHandler, responseId, params)
        break
      default:
        response = buildError(responseId, JSON_RPC_METHOD_NOT_FOUND, `Unknown method: ${method}`)
    }

    return hasId ? response : null
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
}
