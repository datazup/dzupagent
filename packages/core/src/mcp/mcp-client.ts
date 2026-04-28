/**
 * MCP Client — connects to external MCP servers, discovers tools, invokes them.
 *
 * Inspired by Mastra's MCPClient pattern with Claude Code's deferred loading
 * strategy for large tool sets (>10% context budget).
 *
 * Non-fatal: connection failures don't break agent pipelines.
 */
import type {
  MCPServerConfig,
  MCPToolDescriptor,
  MCPToolResult,
  MCPConnectionState,
  MCPServerStatus,
} from './mcp-types.js'
import { validateMcpExecutablePath, sanitizeMcpEnv } from './mcp-security.js'
import { fetchWithOutboundUrlPolicy } from '../security/outbound-url-policy.js'

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

interface ServerConnection {
  config: MCPServerConfig
  state: MCPConnectionState
  tools: MCPToolDescriptor[]
  eagerTools: MCPToolDescriptor[]
  deferredTools: MCPToolDescriptor[]
  lastError?: string
  /** Abort controller for active connections */
  abort?: AbortController
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class MCPClient {
  private connections = new Map<string, ServerConnection>()

  /**
   * Register an MCP server. Does not connect immediately — call connect() or connectAll().
   */
  addServer(config: MCPServerConfig): this {
    this.connections.set(config.id, {
      config,
      state: 'disconnected',
      tools: [],
      eagerTools: [],
      deferredTools: [],
    })
    return this
  }

  /**
   * Connect to a specific MCP server and discover its tools.
   * Non-fatal: returns false on failure instead of throwing.
   */
  async connect(serverId: string): Promise<boolean> {
    const conn = this.connections.get(serverId)
    if (!conn) return false

    conn.state = 'connecting'
    conn.abort = new AbortController()

    try {
      const tools = await this.discoverTools(conn)
      conn.tools = tools
      conn.state = 'connected'

      // Apply deferred loading strategy
      const maxEager = conn.config.maxEagerTools ?? Infinity
      if (tools.length > maxEager) {
        conn.eagerTools = tools.slice(0, maxEager)
        conn.deferredTools = tools.slice(maxEager)
      } else {
        conn.eagerTools = tools
        conn.deferredTools = []
      }

      return true
    } catch (err) {
      conn.state = 'error'
      conn.lastError = err instanceof Error ? err.message : String(err)
      return false
    }
  }

  /**
   * Connect to all registered servers in parallel.
   * Returns Map of serverId → success.
   */
  async connectAll(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>()
    const promises = Array.from(this.connections.keys()).map(async (id) => {
      results.set(id, await this.connect(id))
    })
    await Promise.all(promises)
    return results
  }

  /**
   * Disconnect from a specific server.
   */
  async disconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId)
    if (!conn) return

    conn.abort?.abort()
    conn.state = 'disconnected'
    conn.tools = []
    conn.eagerTools = []
    conn.deferredTools = []
  }

  /**
   * Disconnect from all servers.
   */
  async disconnectAll(): Promise<void> {
    await Promise.all(
      Array.from(this.connections.keys()).map(id => this.disconnect(id)),
    )
  }

  // -------------------------------------------------------------------------
  // Tool access
  // -------------------------------------------------------------------------

  /**
   * Get all eagerly-loaded tools across all connected servers.
   */
  getEagerTools(): MCPToolDescriptor[] {
    const tools: MCPToolDescriptor[] = []
    for (const conn of this.connections.values()) {
      if (conn.state === 'connected') {
        tools.push(...conn.eagerTools)
      }
    }
    return tools
  }

  /**
   * Get deferred (lazily-loaded) tool names across all servers.
   * Use loadDeferredTool() to fetch the full schema when needed.
   */
  getDeferredToolNames(): Array<{ name: string; serverId: string }> {
    const names: Array<{ name: string; serverId: string }> = []
    for (const conn of this.connections.values()) {
      if (conn.state === 'connected') {
        for (const t of conn.deferredTools) {
          names.push({ name: t.name, serverId: t.serverId })
        }
      }
    }
    return names
  }

  /**
   * Load a deferred tool's full schema by name.
   * Moves it from deferred to eager.
   */
  loadDeferredTool(toolName: string): MCPToolDescriptor | null {
    for (const conn of this.connections.values()) {
      const idx = conn.deferredTools.findIndex(t => t.name === toolName)
      if (idx !== -1) {
        const removed = conn.deferredTools.splice(idx, 1)
        const descriptor = removed[0]
        if (descriptor) {
          conn.eagerTools.push(descriptor)
          return descriptor
        }
      }
    }
    return null
  }

  /**
   * Find a tool by name across all connected servers.
   */
  findTool(toolName: string): MCPToolDescriptor | null {
    for (const conn of this.connections.values()) {
      if (conn.state !== 'connected') continue
      const found = conn.tools.find(t => t.name === toolName)
      if (found) return found
    }
    return null
  }

  /**
   * Invoke an MCP tool by name with the given arguments.
   * Non-fatal: returns error result instead of throwing.
   */
  async invokeTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const descriptor = this.findTool(toolName)
    if (!descriptor) {
      return {
        content: [{ type: 'text', text: `Tool "${toolName}" not found on any connected MCP server` }],
        isError: true,
      }
    }

    const conn = this.connections.get(descriptor.serverId)
    if (!conn || conn.state !== 'connected') {
      return {
        content: [{ type: 'text', text: `MCP server "${descriptor.serverId}" is not connected` }],
        isError: true,
      }
    }

    try {
      return await this.executeToolCall(conn, toolName, args)
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Tool invocation failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      }
    }
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /**
   * Get status of all registered servers.
   */
  getStatus(): MCPServerStatus[] {
    return Array.from(this.connections.values()).map(conn => ({
      id: conn.config.id,
      name: conn.config.name,
      state: conn.state,
      toolCount: conn.tools.length,
      eagerToolCount: conn.eagerTools.length,
      deferredToolCount: conn.deferredTools.length,
      ...(conn.lastError !== undefined && { lastError: conn.lastError }),
    }))
  }

  /**
   * Check if any server is connected.
   */
  hasConnections(): boolean {
    for (const conn of this.connections.values()) {
      if (conn.state === 'connected') return true
    }
    return false
  }

  // -------------------------------------------------------------------------
  // Transport implementations
  // -------------------------------------------------------------------------

  /**
   * Discover tools from an MCP server via its transport.
   */
  private async discoverTools(conn: ServerConnection): Promise<MCPToolDescriptor[]> {
    const { config } = conn
    const timeout = config.timeoutMs ?? 10_000

    switch (config.transport) {
      case 'http':
        return this.discoverViaHttp(config, timeout)
      case 'sse':
        return this.discoverViaSse(config, timeout)
      case 'stdio':
        return this.discoverViaStdio(config, timeout)
      default:
        throw new Error(`Unsupported MCP transport: ${config.transport as string}`)
    }
  }

  private async discoverViaHttp(
    config: MCPServerConfig,
    timeout: number,
  ): Promise<MCPToolDescriptor[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await fetchWithOutboundUrlPolicy(`${config.url}/tools/list`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...config.headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
        signal: controller.signal,
      }, {
        policy: config.urlPolicy,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json() as {
        result?: { tools?: Array<{ name: string; description: string; inputSchema: MCPToolDescriptor['inputSchema'] }> }
      }

      return (data.result?.tools ?? []).map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        serverId: config.id,
      }))
    } finally {
      clearTimeout(timer)
    }
  }

  private async discoverViaSse(
    config: MCPServerConfig,
    timeout: number,
  ): Promise<MCPToolDescriptor[]> {
    // SSE transport: POST to the server endpoint with tools/list
    // The SSE transport uses the same JSON-RPC protocol over HTTP
    return this.discoverViaHttp(config, timeout)
  }

  private async discoverViaStdio(
    config: MCPServerConfig,
    timeout: number,
  ): Promise<MCPToolDescriptor[]> {
    const request = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 1,
    }) + '\n'

    const stdout = await this.spawnWithStdin(config, request, timeout)

    // Parse the last JSON line (skip any preamble)
    const lines = stdout.trim().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line) continue
      try {
        const data = JSON.parse(line) as {
          result?: { tools?: Array<{ name: string; description: string; inputSchema: MCPToolDescriptor['inputSchema'] }> }
        }
        if (data.result?.tools) {
          return data.result.tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            serverId: config.id,
          }))
        }
      } catch {
        continue
      }
    }

    return []
  }

  /**
   * Execute a tool call via the appropriate transport.
   */
  private async executeToolCall(
    conn: ServerConnection,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<MCPToolResult> {
    const { config } = conn
    const timeout = config.timeoutMs ?? 10_000

    const request = {
      jsonrpc: '2.0' as const,
      method: 'tools/call' as const,
      params: { name: toolName, arguments: args },
      id: Date.now(),
    }

    switch (config.transport) {
      case 'http':
      case 'sse': {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)

        try {
          const response = await fetchWithOutboundUrlPolicy(`${config.url}/tools/call`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...config.headers,
            },
            body: JSON.stringify(request),
            signal: controller.signal,
          }, {
            policy: config.urlPolicy,
          })

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`)
          }

          const data = await response.json() as { result?: MCPToolResult }
          return data.result ?? { content: [{ type: 'text', text: 'No result' }] }
        } finally {
          clearTimeout(timer)
        }
      }

      case 'stdio': {
        const input = JSON.stringify(request) + '\n'
        const stdout = await this.spawnWithStdin(conn.config, input, timeout)

        const lines = stdout.trim().split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i]
          if (!line) continue
          try {
            const data = JSON.parse(line) as { result?: MCPToolResult }
            if (data.result) return data.result
          } catch {
            continue
          }
        }

        return { content: [{ type: 'text', text: stdout }] }
      }

      default:
        throw new Error(`Unsupported transport: ${config.transport as string}`)
    }
  }

  /**
   * Spawn a process, write to stdin, collect stdout. Used for stdio transport.
   */
  private spawnWithStdin(
    config: MCPServerConfig,
    input: string,
    timeout: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      import('node:child_process').then(({ spawn }) => {
        validateMcpExecutablePath(config.url)
        const env = sanitizeMcpEnv(process.env as Record<string, string | undefined>, config.env)
        const proc = spawn(config.url, config.args ?? [], {
          env: env as NodeJS.ProcessEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout,
        })

        let stdout = ''
        let stderr = ''

        proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
        proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

        proc.on('close', (code) => {
          // Stdio MCP servers communicate via JSON-RPC frames on stdout, but the
          // *authoritative* signal that the request completed is the child's
          // exit code. A non-zero exit must always be treated as failure even
          // when partial stdout was emitted — partial frames cannot be trusted
          // (they may represent a crash mid-response or a protocol violation).
          if (code === 0) {
            resolve(stdout)
          } else {
            const codeStr = code === null ? 'null (signal)' : String(code)
            const stderrSummary = stderr.trim().length > 0 ? stderr.trim() : '(no stderr)'
            const stdoutSummary = stdout.trim().length > 0
              ? ` (partial stdout: ${stdout.length} bytes discarded)`
              : ''
            reject(new Error(
              `MCP stdio process exited with code ${codeStr}: ${stderrSummary}${stdoutSummary}`,
            ))
          }
        })

        proc.on('error', reject)

        proc.stdin.write(input)
        proc.stdin.end()
      }).catch(reject)
    })
  }
}
