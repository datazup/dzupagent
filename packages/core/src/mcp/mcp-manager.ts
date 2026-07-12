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
/**
 * Tenant scoping for {@link McpManager} operations.
 *
 * Every method accepts an optional trailing `tenantId`. When supplied, the
 * manager records ownership on writes and enforces it on reads/updates/deletes
 * — a resource owned by a different tenant is invisible (`getServer`/
 * `getProfile` return `undefined`; `listServers`/`listProfiles` omit it) and
 * mutating it behaves as if it does not exist (throws `"... not found"`).
 *
 * When `tenantId` is omitted (single-tenant / library usage) no scoping is
 * applied, preserving the original behaviour for existing callers.
 */
export interface McpManager {
  addServer(input: McpServerInput, tenantId?: string): Promise<McpServerDefinition>
  updateServer(id: string, patch: McpServerPatch, tenantId?: string): Promise<McpServerDefinition>
  removeServer(id: string, tenantId?: string): Promise<void>
  enableServer(id: string, tenantId?: string): Promise<McpServerDefinition>
  disableServer(id: string, tenantId?: string): Promise<McpServerDefinition>
  testServer(id: string, tenantId?: string): Promise<McpTestResult>
  getServer(id: string, tenantId?: string): Promise<McpServerDefinition | undefined>
  listServers(tenantId?: string): Promise<McpServerDefinition[]>

  // Profile management
  addProfile(profile: McpProfile, tenantId?: string): Promise<McpProfile>
  removeProfile(id: string, tenantId?: string): Promise<void>
  getProfile(id: string, tenantId?: string): Promise<McpProfile | undefined>
  listProfiles(tenantId?: string): Promise<McpProfile[]>
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

  /**
   * True when `scope` is undefined (no scoping) or matches the resource's
   * owning tenant. Resources with no recorded tenant are treated as 'default'.
   */
  private ownedBy(
    resource: { tenantId?: string | undefined } | undefined,
    scope: string | undefined,
  ): boolean {
    if (scope === undefined) return true
    if (!resource) return false
    return (resource.tenantId ?? 'default') === scope
  }

  async addServer(input: McpServerInput, tenantId?: string): Promise<McpServerDefinition> {
    // Server ids share a single keyspace across tenants; any collision throws
    // the same generic error regardless of the caller's scope so the existence
    // of another tenant's server is not disclosed.
    if (this.servers.has(input.id)) {
      throw new Error(`MCP server with id "${input.id}" already exists`)
    }

    const now = new Date().toISOString()
    const definition: McpServerDefinition = {
      ...input,
      ...(tenantId !== undefined ? { tenantId } : {}),
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

  async updateServer(id: string, patch: McpServerPatch, tenantId?: string): Promise<McpServerDefinition> {
    const existing = this.servers.get(id)
    if (!existing || !this.ownedBy(existing, tenantId)) {
      throw new Error(`MCP server "${id}" not found`)
    }

    const updated: McpServerDefinition = {
      ...existing,
      ...patch,
      id: existing.id, // id is immutable
      tenantId: existing.tenantId, // tenant ownership is immutable
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

  async removeServer(id: string, tenantId?: string): Promise<void> {
    const existing = this.servers.get(id)
    // Only the owning tenant may remove a server. A cross-tenant delete is a
    // silent no-op (the resource is invisible to the caller).
    const existed = existing !== undefined && this.ownedBy(existing, tenantId)
    if (existed) {
      this.servers.delete(id)
      this.eventBus?.emit({ type: 'mcp:server_removed', serverId: id })
    }
  }

  async enableServer(id: string, tenantId?: string): Promise<McpServerDefinition> {
    const result = await this.updateServer(id, { enabled: true }, tenantId)
    this.eventBus?.emit({ type: 'mcp:server_enabled', serverId: id })
    return result
  }

  async disableServer(id: string, tenantId?: string): Promise<McpServerDefinition> {
    const result = await this.updateServer(id, { enabled: false }, tenantId)
    this.eventBus?.emit({ type: 'mcp:server_disabled', serverId: id })
    return result
  }

  async testServer(id: string, tenantId?: string): Promise<McpTestResult> {
    const definition = this.servers.get(id)
    if (!definition || !this.ownedBy(definition, tenantId)) {
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

  async getServer(id: string, tenantId?: string): Promise<McpServerDefinition | undefined> {
    const def = this.servers.get(id)
    if (!def || !this.ownedBy(def, tenantId)) return undefined
    return { ...def }
  }

  async listServers(tenantId?: string): Promise<McpServerDefinition[]> {
    return [...this.servers.values()]
      .filter(d => this.ownedBy(d, tenantId))
      .map(d => ({ ...d }))
  }

  // -------------------------------------------------------------------------
  // Profile management
  // -------------------------------------------------------------------------

  async addProfile(profile: McpProfile, tenantId?: string): Promise<McpProfile> {
    // Profile ids share a single keyspace across tenants; any collision throws
    // the same generic error so another tenant's profile is not disclosed.
    if (this.profiles.has(profile.id)) {
      throw new Error(`MCP profile with id "${profile.id}" already exists`)
    }
    const stored: McpProfile = {
      ...profile,
      ...(tenantId !== undefined ? { tenantId } : {}),
    }
    this.profiles.set(stored.id, stored)
    return { ...stored }
  }

  async removeProfile(id: string, tenantId?: string): Promise<void> {
    const existing = this.profiles.get(id)
    // Cross-tenant delete is a silent no-op.
    if (existing && this.ownedBy(existing, tenantId)) {
      this.profiles.delete(id)
    }
  }

  async getProfile(id: string, tenantId?: string): Promise<McpProfile | undefined> {
    const p = this.profiles.get(id)
    if (!p || !this.ownedBy(p, tenantId)) return undefined
    return { ...p }
  }

  async listProfiles(tenantId?: string): Promise<McpProfile[]> {
    return [...this.profiles.values()]
      .filter(p => this.ownedBy(p, tenantId))
      .map(p => ({ ...p }))
  }
}
