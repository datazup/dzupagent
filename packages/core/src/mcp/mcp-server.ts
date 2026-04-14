/**
 * MCP Server — Exposes DzupAgent instances as MCP tools.
 *
 * Implements the minimal JSON-RPC protocol surface for `tools/list`
 * and `tools/call` so any MCP client (Claude Code, Cursor, Zed) can
 * discover and invoke registered tools. No SDK dependency required.
 */
import type { MCPToolDescriptor, MCPToolParameter } from './mcp-types.js'

// ---------------------------------------------------------------------------
// JSON-RPC types (MCP protocol surface)
// ---------------------------------------------------------------------------

export interface MCPRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: Record<string, unknown>
}

export interface MCPResponse {
  jsonrpc: '2.0'
  id: string | number
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
  handler: (args: Record<string, unknown>) => Promise<string>
}

export interface MCPServerOptions {
  /** Human-readable server name */
  name: string
  /** Server version */
  version: string
  /** Initial set of tools to expose */
  tools?: MCPExposedTool[]
}

// ---------------------------------------------------------------------------
// JSON-RPC error codes
// ---------------------------------------------------------------------------

const JSON_RPC_METHOD_NOT_FOUND = -32601
const JSON_RPC_INVALID_PARAMS = -32602
const JSON_RPC_INTERNAL_ERROR = -32000

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
  private readonly tools: Map<string, MCPExposedTool> = new Map()

  constructor(options: MCPServerOptions) {
    this.serverName = options.name
    this.serverVersion = options.version

    for (const tool of options.tools ?? []) {
      this.tools.set(tool.name, tool)
    }
  }

  /** Server name (used in tool descriptors and initialize response). */
  get name(): string { return this.serverName }

  /** Server version. */
  get version(): string { return this.serverVersion }

  /** Register an additional tool after construction. */
  registerTool(tool: MCPExposedTool): void {
    this.tools.set(tool.name, tool)
  }

  /** Remove a registered tool by name. */
  unregisterTool(name: string): void {
    this.tools.delete(name)
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

  /** Handle a JSON-RPC request implementing the MCP tools protocol. */
  async handleRequest(request: MCPRequest): Promise<MCPResponse> {
    const { id, method, params } = request

    switch (method) {
      case 'tools/list':
        return this.buildResult(id, { tools: this.listTools() })

      case 'tools/call':
        return this.handleToolCall(id, params)

      default:
        return this.buildError(id, JSON_RPC_METHOD_NOT_FOUND, `Unknown method: ${method}`)
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async handleToolCall(
    id: string | number,
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
      const text = await tool.handler(args)
      return this.buildResult(id, {
        content: [{ type: 'text', text }],
        isError: false,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return this.buildError(id, JSON_RPC_INTERNAL_ERROR, `Tool execution failed: ${message}`, {
        toolName,
      })
    }
  }

  private buildResult(id: string | number, result: unknown): MCPResponse {
    return { jsonrpc: '2.0', id, result }
  }

  private buildError(
    id: string | number,
    code: number,
    message: string,
    data?: unknown,
  ): MCPResponse {
    return { jsonrpc: '2.0', id, error: { code, message, data } }
  }
}
