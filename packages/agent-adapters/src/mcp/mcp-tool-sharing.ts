/**
 * MCPToolSharingBridge — Bridges DzupAgent's MCP infrastructure with the
 * adapter layer, enabling tools to be shared across all AI agent adapters.
 *
 * Two responsibilities:
 * 1. Expose DzupAgent tools TO adapters (Claude, Codex, Gemini, etc.)
 * 2. Collect tools FROM adapters and register them for cross-adapter sharing
 *
 * Internally maintains a lightweight tool registry (Map<string, SharedTool>)
 * and delegates JSON-RPC handling to DzupAgentMCPServer from @dzupagent/core.
 */

import { DzupAgentMCPServer } from '@dzupagent/core'
import type {
  DzupEventBus,
  MCPToolDescriptor,
  MCPRequest,
  MCPResponse,
} from '@dzupagent/core'

import type { AdapterProviderId } from '../types.js'

// ---------------------------------------------------------------------------
// Configuration & shared types
// ---------------------------------------------------------------------------

export interface MCPToolSharingConfig {
  /** Server name for the MCP server. Default: 'dzupagent-tools' */
  serverName?: string
  /** Server version. Default: '1.0.0' */
  serverVersion?: string
  /** Event bus for observability */
  eventBus?: DzupEventBus
}

export interface SharedTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Which provider originally owns this tool */
  sourceProvider?: AdapterProviderId
  /** Handler that executes the tool */
  handler: (args: Record<string, unknown>) => Promise<string>
}

export interface ToolSharingStats {
  totalTools: number
  toolsBySource: Record<string, number>
  toolNames: string[]
}

// ---------------------------------------------------------------------------
// Adapter-specific config shapes
// ---------------------------------------------------------------------------

/** Config shape returned for Claude adapters (mcpServers) */
interface ClaudeToolConfig {
  mcpServers: Record<string, {
    type: 'in-process'
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
    handler: (request: unknown) => Promise<unknown>
  }>
}

/** Config shape returned for Codex adapters (dynamicTools) */
interface CodexToolConfig {
  dynamicTools: Array<{
    name: string
    description: string
    inputSchema: Record<string, unknown>
  }>
}

/** Config shape returned for CLI-based adapters (system prompt injection) */
interface CLIToolConfig {
  systemPromptTools: string
}

// ---------------------------------------------------------------------------
// MCPToolSharingBridge
// ---------------------------------------------------------------------------

export class MCPToolSharingBridge {
  private readonly tools = new Map<string, SharedTool>()
  private readonly mcpServer: DzupAgentMCPServer
  private readonly serverName: string
  private readonly eventBus: DzupEventBus | undefined

  constructor(config?: MCPToolSharingConfig) {
    this.serverName = config?.serverName ?? 'dzupagent-tools'
    this.eventBus = config?.eventBus

    this.mcpServer = new DzupAgentMCPServer({
      name: this.serverName,
      version: config?.serverVersion ?? '1.0.0',
    })
  }

  /**
   * Register a tool to be shared across all adapters.
   * Wraps the tool as an MCPExposedTool and registers it on the internal
   * MCP server for JSON-RPC handling.
   */
  registerTool(tool: SharedTool): void {
    this.tools.set(tool.name, tool)

    // Mirror registration onto the MCP server for JSON-RPC support
    this.mcpServer.registerTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      handler: tool.handler,
    })

    this.emitEvent('mcp:connected', {
      serverName: this.serverName,
      toolCount: this.tools.size,
    })
  }

  /**
   * Unregister a tool by name.
   * Returns true if the tool existed and was removed, false otherwise.
   */
  unregisterTool(name: string): boolean {
    const existed = this.tools.delete(name)
    if (existed) {
      this.mcpServer.unregisterTool(name)
    }
    return existed
  }

  /**
   * Register multiple tools at once.
   */
  registerTools(tools: SharedTool[]): void {
    for (const tool of tools) {
      this.registerTool(tool)
    }
  }

  /**
   * Get the MCP server configuration that adapters should use to connect.
   * Returns the server name and all registered tool descriptors.
   */
  getServerConfig(): { name: string; tools: MCPToolDescriptor[] } {
    return {
      name: this.serverName,
      tools: this.mcpServer.listTools(),
    }
  }

  /**
   * Build adapter-specific tool configuration for a given provider.
   *
   * - Claude: returns mcpServers config for claude-agent-sdk
   * - Codex: returns dynamicTools array for codex-sdk
   * - Gemini/Qwen/Crush (CLI-based): returns systemPromptTools string
   */
  buildAdapterToolConfig(providerId: AdapterProviderId): ClaudeToolConfig | CodexToolConfig | CLIToolConfig {
    const toolList = this.buildToolList()

    switch (providerId) {
      case 'claude':
        return this.buildClaudeConfig(toolList)
      case 'codex':
        return this.buildCodexConfig(toolList)
      case 'gemini':
      case 'qwen':
      case 'crush':
      case 'gemini-sdk':
      case 'goose':
      case 'openrouter':
        return this.buildCLIConfig(toolList)
    }
  }

  /**
   * Handle a JSON-RPC MCP request (delegates to internal DzupAgentMCPServer).
   * This allows the bridge to act as an MCP server for adapters that
   * support the MCP protocol natively.
   */
  async handleRequest(request: unknown): Promise<unknown> {
    const mcpRequest = request as MCPRequest
    const response: MCPResponse = await this.mcpServer.handleRequest(mcpRequest)
    return response
  }

  /**
   * Get sharing statistics: total count, breakdown by source provider,
   * and the list of all tool names.
   */
  getStats(): ToolSharingStats {
    const toolsBySource: Record<string, number> = {}

    for (const tool of this.tools.values()) {
      const source = tool.sourceProvider ?? 'unknown'
      toolsBySource[source] = (toolsBySource[source] ?? 0) + 1
    }

    return {
      totalTools: this.tools.size,
      toolsBySource,
      toolNames: [...this.tools.keys()],
    }
  }

  /**
   * List all shared tool names.
   */
  listTools(): string[] {
    return [...this.tools.keys()]
  }

  /**
   * Clear all registered tools.
   */
  clear(): void {
    const names = [...this.tools.keys()]
    for (const name of names) {
      this.mcpServer.unregisterTool(name)
    }
    this.tools.clear()
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildToolList(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    const list: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = []
    for (const tool of this.tools.values()) {
      list.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })
    }
    return list
  }

  private buildClaudeConfig(
    toolList: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
  ): ClaudeToolConfig {
    return {
      mcpServers: {
        [this.serverName]: {
          type: 'in-process' as const,
          tools: toolList,
          handler: async (request: unknown) => this.handleRequest(request),
        },
      },
    }
  }

  private buildCodexConfig(
    toolList: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
  ): CodexToolConfig {
    return {
      dynamicTools: toolList.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }
  }

  private buildCLIConfig(
    toolList: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
  ): CLIToolConfig {
    const sections = toolList.map(t =>
      `Tool: ${t.name}\nDescription: ${t.description}\nParams: ${JSON.stringify(t.inputSchema)}`,
    )
    return {
      systemPromptTools: sections.join('\n\n'),
    }
  }

  private emitEvent(
    type: 'mcp:connected',
    data: { serverName: string; toolCount: number },
  ): void {
    if (!this.eventBus) return

    try {
      this.eventBus.emit({ type, ...data })
    } catch {
      // Event emission is non-fatal — swallow errors silently
    }
  }
}
