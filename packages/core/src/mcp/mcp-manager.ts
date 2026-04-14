/**
 * MCP Manager — lifecycle management for MCP server definitions.
 *
 * Provides add / update / remove / enable / disable / test / list operations
 * and emits typed events on the DzupEventBus for each mutation.
 *
 * `InMemoryMcpManager` is the default implementation suitable for dev/test.
 * Persistent backends can implement the `McpManager` interface directly.
 */
import type { DzupEventBus } from '../events/event-bus.js'
import type {
  McpServerDefinition,
  McpServerInput,
  McpServerPatch,
  McpTestResult,
  McpProfile,
} from './mcp-registry-types.js'
import type { MCPClient } from './mcp-client.js'

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Lifecycle manager for MCP server registrations.
 * Implementations persist definitions and emit events for observability.
 */
export interface McpManager {
  addServer(input: McpServerInput): Promise<McpServerDefinition>
  updateServer(id: string, patch: McpServerPatch): Promise<McpServerDefinition>
  removeServer(id: string): Promise<void>
  enableServer(id: string): Promise<McpServerDefinition>
  disableServer(id: string): Promise<McpServerDefinition>
  testServer(id: string): Promise<McpTestResult>
  getServer(id: string): Promise<McpServerDefinition | undefined>
  listServers(): Promise<McpServerDefinition[]>

  // Profile management
  addProfile(profile: McpProfile): Promise<McpProfile>
  removeProfile(id: string): Promise<void>
  getProfile(id: string): Promise<McpProfile | undefined>
  listProfiles(): Promise<McpProfile[]>
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export interface InMemoryMcpManagerOptions {
  eventBus?: DzupEventBus | undefined
  /** Optional MCPClient used for testServer connectivity checks. */
  mcpClient?: MCPClient | undefined
}

export class InMemoryMcpManager implements McpManager {
  private readonly servers = new Map<string, McpServerDefinition>()
  private readonly profiles = new Map<string, McpProfile>()
  private readonly eventBus: DzupEventBus | undefined
  private readonly mcpClient: MCPClient | undefined

  constructor(options?: InMemoryMcpManagerOptions) {
    this.eventBus = options?.eventBus
    this.mcpClient = options?.mcpClient
  }

  async addServer(input: McpServerInput): Promise<McpServerDefinition> {
    if (this.servers.has(input.id)) {
      throw new Error(`MCP server with id "${input.id}" already exists`)
    }

    const now = new Date().toISOString()
    const definition: McpServerDefinition = {
      ...input,
      createdAt: now,
      updatedAt: now,
    }

    this.servers.set(definition.id, definition)
    this.eventBus?.emit({
      type: 'mcp:server_added',
      serverId: definition.id,
      transport: definition.transport,
    })
    return { ...definition }
  }

  async updateServer(id: string, patch: McpServerPatch): Promise<McpServerDefinition> {
    const existing = this.servers.get(id)
    if (!existing) {
      throw new Error(`MCP server "${id}" not found`)
    }

    const updated: McpServerDefinition = {
      ...existing,
      ...patch,
      id: existing.id, // id is immutable
      createdAt: existing.createdAt, // createdAt is immutable
      updatedAt: new Date().toISOString(),
    }

    this.servers.set(id, updated)
    this.eventBus?.emit({
      type: 'mcp:server_updated',
      serverId: id,
      fields: Object.keys(patch),
    })
    return { ...updated }
  }

  async removeServer(id: string): Promise<void> {
    const existed = this.servers.has(id)
    this.servers.delete(id)
    if (existed) {
      this.eventBus?.emit({ type: 'mcp:server_removed', serverId: id })
    }
  }

  async enableServer(id: string): Promise<McpServerDefinition> {
    const result = await this.updateServer(id, { enabled: true })
    this.eventBus?.emit({ type: 'mcp:server_enabled', serverId: id })
    return result
  }

  async disableServer(id: string): Promise<McpServerDefinition> {
    const result = await this.updateServer(id, { enabled: false })
    this.eventBus?.emit({ type: 'mcp:server_disabled', serverId: id })
    return result
  }

  async testServer(id: string): Promise<McpTestResult> {
    const definition = this.servers.get(id)
    if (!definition) {
      return { ok: false, error: `MCP server "${id}" not found` }
    }

    if (!this.mcpClient) {
      return { ok: false, error: 'No MCPClient configured for connectivity testing' }
    }

    try {
      // Register, connect, count tools, then clean up
      this.mcpClient.addServer({
        id: definition.id,
        name: definition.name ?? definition.id,
        url: definition.endpoint,
        transport: definition.transport,
        ...(definition.args !== undefined && { args: definition.args }),
        ...(definition.env !== undefined && { env: definition.env }),
        ...(definition.headers !== undefined && { headers: definition.headers }),
        ...(definition.timeoutMs !== undefined && { timeoutMs: definition.timeoutMs }),
        ...(definition.maxEagerTools !== undefined && { maxEagerTools: definition.maxEagerTools }),
      })

      const ok = await this.mcpClient.connect(definition.id)
      if (!ok) {
        const status = this.mcpClient.getStatus().find(s => s.id === definition.id)
        const error = status?.lastError ?? 'Connection failed'
        await this.mcpClient.disconnect(definition.id)
        this.eventBus?.emit({ type: 'mcp:test_failed', serverId: id, error })
        return { ok: false, error }
      }

      const status = this.mcpClient.getStatus().find(s => s.id === definition.id)
      const toolCount = status?.toolCount ?? 0

      await this.mcpClient.disconnect(definition.id)

      this.eventBus?.emit({ type: 'mcp:test_passed', serverId: id, toolCount })
      return { ok: true, toolCount }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err)
      this.eventBus?.emit({ type: 'mcp:test_failed', serverId: id, error })
      return { ok: false, error }
    }
  }

  async getServer(id: string): Promise<McpServerDefinition | undefined> {
    const def = this.servers.get(id)
    return def ? { ...def } : undefined
  }

  async listServers(): Promise<McpServerDefinition[]> {
    return [...this.servers.values()].map(d => ({ ...d }))
  }

  // -------------------------------------------------------------------------
  // Profile management
  // -------------------------------------------------------------------------

  async addProfile(profile: McpProfile): Promise<McpProfile> {
    if (this.profiles.has(profile.id)) {
      throw new Error(`MCP profile with id "${profile.id}" already exists`)
    }
    this.profiles.set(profile.id, { ...profile })
    return { ...profile }
  }

  async removeProfile(id: string): Promise<void> {
    this.profiles.delete(id)
  }

  async getProfile(id: string): Promise<McpProfile | undefined> {
    const p = this.profiles.get(id)
    return p ? { ...p } : undefined
  }

  async listProfiles(): Promise<McpProfile[]> {
    return [...this.profiles.values()].map(p => ({ ...p }))
  }
}
