/**
 * Minimal fake MCP client for integration tests.
 *
 * Implements the same structural interface that mcp-tool-instantiation.ts
 * expects when it dynamically imports MCPClient from @dzupagent/core.
 * Staying at this boundary means the tests catch wiring drift between
 * tool-resolver.ts ↔ mcp-tool-instantiation.ts ↔ @dzupagent/core contract.
 */
import type { MCPToolDescriptor, MCPToolResult } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// FakeMcpServer — per-server state
// ---------------------------------------------------------------------------

export interface FakeMcpServerOpts {
  id: string
  name?: string
  tools?: MCPToolDescriptor[]
  /** When true, connect() returns false */
  failConnect?: boolean
  /**
   * Canned responses keyed by tool name.
   * If absent for a tool name, a default text response is returned.
   */
  responses?: Record<string, MCPToolResult>
  /** When set, invokeTool() throws this error instead of returning a response. */
  throwOnInvoke?: Error
}

export class FakeMcpServer {
  readonly id: string
  readonly name: string
  readonly tools: MCPToolDescriptor[]
  readonly failConnect: boolean
  readonly responses: Record<string, MCPToolResult>
  readonly throwOnInvoke: Error | undefined
  readonly callHistory: Array<{ tool: string; args: Record<string, unknown> }> = []

  constructor(opts: FakeMcpServerOpts) {
    this.id = opts.id
    this.name = opts.name ?? opts.id
    this.tools = opts.tools ?? []
    this.failConnect = opts.failConnect ?? false
    this.responses = opts.responses ?? {}
    this.throwOnInvoke = opts.throwOnInvoke
  }

  invoke(toolName: string, args: Record<string, unknown>): MCPToolResult {
    this.callHistory.push({ tool: toolName, args })
    if (this.throwOnInvoke) throw this.throwOnInvoke
    if (this.responses[toolName]) return this.responses[toolName]!
    return { content: [{ type: 'text', text: `default:${toolName}` }] }
  }
}

// ---------------------------------------------------------------------------
// FakeMcpClient — drops in for MCPClient from @dzupagent/core
// ---------------------------------------------------------------------------

export class FakeMcpClient {
  private readonly backends = new Map<string, FakeMcpServer>()
  private readonly configs = new Map<string, { id: string; name: string; maxEagerTools?: number }>()
  private readonly connected = new Set<string>()

  /** Track cleanup calls */
  disconnectAllCallCount = 0

  /** Register a fake backend before connecting */
  registerBackend(server: FakeMcpServer): void {
    this.backends.set(server.id, server)
  }

  // ---- MCPClient interface ----

  addServer(config: { id: string; name: string; maxEagerTools?: number }): void {
    this.configs.set(config.id, config)
  }

  async connect(serverId: string): Promise<boolean> {
    const backend = this.backends.get(serverId)
    if (!backend || backend.failConnect) return false
    this.connected.add(serverId)
    return true
  }

  getEagerTools(): MCPToolDescriptor[] {
    const out: MCPToolDescriptor[] = []
    for (const id of this.connected) {
      const backend = this.backends.get(id)
      if (!backend) continue
      const cfg = this.configs.get(id)
      const limit = cfg?.maxEagerTools ?? Infinity
      out.push(...backend.tools.slice(0, limit))
    }
    return out
  }

  async invokeTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    for (const id of this.connected) {
      const backend = this.backends.get(id)
      if (!backend) continue
      if (backend.tools.some((t) => t.name === toolName)) {
        return backend.invoke(toolName, args)
      }
    }
    return { content: [{ type: 'text', text: `tool "${toolName}" not found` }], isError: true }
  }

  async disconnectAll(): Promise<void> {
    this.disconnectAllCallCount++
    this.connected.clear()
  }
}

// ---------------------------------------------------------------------------
// makeToolDescriptor — factory for test descriptors
// ---------------------------------------------------------------------------

export function makeToolDescriptor(
  name: string,
  serverId: string,
  properties: Record<string, { type: string; description?: string }> = {},
  required?: string[],
): MCPToolDescriptor {
  return {
    name,
    description: `Fake MCP tool: ${name}`,
    inputSchema: {
      type: 'object',
      properties: properties as MCPToolDescriptor['inputSchema']['properties'],
      required,
    },
    serverId,
  }
}
