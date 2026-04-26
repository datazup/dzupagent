/**
 * McpAdapterManager — manages MCP server registrations and their bindings
 * to adapter providers.
 *
 * Provides CRUD operations for servers and bindings, connectivity testing
 * via MCPClient from @dzupagent/core, and effective config resolution that
 * merges enabled servers with enabled bindings per provider.
 *
 * All operations return Promises to support future persistent backing stores.
 */

import { ForgeError } from '@dzupagent/core'
import type { AdapterProviderId } from '../types.js'
import type {
  AdapterMcpServer,
  AdapterMcpBinding,
  McpServerTestResult,
  EffectiveMcpConfig,
} from './mcp-adapter-types.js'

export class InMemoryMcpAdapterManager {
  private readonly servers = new Map<string, AdapterMcpServer>()
  private readonly bindings = new Map<string, AdapterMcpBinding>()

  // ---------------------------------------------------------------------------
  // Server CRUD
  // ---------------------------------------------------------------------------

  /**
   * Register a new MCP server. Defaults to enabled=false.
   * Throws if a server with the same id already exists.
   */
  async addServer(
    server: Omit<AdapterMcpServer, 'enabled' | 'createdAt' | 'updatedAt'> & { enabled?: boolean },
  ): Promise<AdapterMcpServer> {
    if (this.servers.has(server.id)) {
      throw new ForgeError({
        code: 'VALIDATION_FAILED',
        message: `MCP server with id "${server.id}" already exists`,
        recoverable: false,
      })
    }

    const now = new Date().toISOString()
    const record: AdapterMcpServer = {
      ...server,
      enabled: server.enabled ?? false,
      createdAt: now,
      updatedAt: now,
    }
    this.servers.set(record.id, record)
    return record
  }

  /**
   * Remove a server. Throws if enabled bindings exist unless force=true.
   */
  async removeServer(id: string, force = false): Promise<boolean> {
    if (!this.servers.has(id)) return false

    if (!force) {
      const activeBindings = this.getBindingsForServer(id).filter(b => b.enabled)
      if (activeBindings.length > 0) {
        throw new ForgeError({
          code: 'VALIDATION_FAILED',
          message: `Cannot remove server "${id}": ${activeBindings.length} active binding(s) exist. Use force=true to override.`,
          recoverable: true,
        })
      }
    }

    // Remove all bindings for this server
    for (const [bindingId, binding] of this.bindings) {
      if (binding.serverId === id) {
        this.bindings.delete(bindingId)
      }
    }

    this.servers.delete(id)
    return true
  }

  /** Enable a server. Returns false if the server does not exist. */
  async enableServer(id: string): Promise<boolean> {
    const server = this.servers.get(id)
    if (!server) return false
    server.enabled = true
    server.updatedAt = new Date().toISOString()
    return true
  }

  /** Disable a server. Returns false if the server does not exist. */
  async disableServer(id: string): Promise<boolean> {
    const server = this.servers.get(id)
    if (!server) return false
    server.enabled = false
    server.updatedAt = new Date().toISOString()
    return true
  }

  /** Update server fields (partial patch). Returns the updated server or undefined. */
  async updateServer(
    id: string,
    patch: Partial<Pick<AdapterMcpServer, 'transport' | 'endpoint' | 'args' | 'env' | 'headers' | 'tags'>>,
  ): Promise<AdapterMcpServer | undefined> {
    const server = this.servers.get(id)
    if (!server) return undefined

    Object.assign(server, patch)
    server.updatedAt = new Date().toISOString()
    return server
  }

  /** List all registered servers. */
  async listServers(): Promise<AdapterMcpServer[]> {
    return [...this.servers.values()]
  }

  /** Get a server by id. */
  async getServer(id: string): Promise<AdapterMcpServer | undefined> {
    return this.servers.get(id)
  }

  /**
   * Test connectivity to an MCP server.
   * Dynamically imports MCPClient from @dzupagent/core and attempts connection.
   * Returns a result object; never throws.
   */
  async testServer(serverId: string): Promise<McpServerTestResult> {
    const server = this.servers.get(serverId)
    if (!server) {
      return { ok: false, error: `Server "${serverId}" not found` }
    }

    try {
      const { MCPClient } = await import(/* webpackIgnore: true */ '@dzupagent/core')
      const client = new MCPClient()
      client.addServer({
        id: server.id,
        name: server.id,
        url: server.endpoint,
        transport: server.transport,
        args: server.args,
        env: server.env,
        headers: server.headers,
      })

      try {
        await client.connectAll()
        const tools = client.getEagerTools()
        await client.disconnect(server.id)
        return { ok: true, toolCount: tools.length }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    } catch (err) {
      return { ok: false, error: `Failed to import MCPClient: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  // ---------------------------------------------------------------------------
  // Binding CRUD
  // ---------------------------------------------------------------------------

  /**
   * Bind an MCP server to a provider adapter.
   * Validates that the referenced server exists.
   */
  async bindServer(
    binding: Omit<AdapterMcpBinding, 'createdAt' | 'updatedAt'>,
  ): Promise<AdapterMcpBinding> {
    if (!this.servers.has(binding.serverId)) {
      throw new ForgeError({
        code: 'VALIDATION_FAILED',
        message: `Cannot bind: server "${binding.serverId}" does not exist`,
        recoverable: false,
      })
    }

    if (this.bindings.has(binding.id)) {
      throw new ForgeError({
        code: 'VALIDATION_FAILED',
        message: `Binding with id "${binding.id}" already exists`,
        recoverable: false,
      })
    }

    const now = new Date().toISOString()
    const record: AdapterMcpBinding = {
      ...binding,
      createdAt: now,
      updatedAt: now,
    }
    this.bindings.set(record.id, record)
    return record
  }

  /** Remove a binding by id. Returns false if not found. */
  async unbindServer(bindingId: string): Promise<boolean> {
    return this.bindings.delete(bindingId)
  }

  /** Enable a binding. Returns false if the binding does not exist. */
  async enableBinding(bindingId: string): Promise<boolean> {
    const binding = this.bindings.get(bindingId)
    if (!binding) return false
    binding.enabled = true
    binding.updatedAt = new Date().toISOString()
    return true
  }

  /** Disable a binding. Returns false if the binding does not exist. */
  async disableBinding(bindingId: string): Promise<boolean> {
    const binding = this.bindings.get(bindingId)
    if (!binding) return false
    binding.enabled = false
    binding.updatedAt = new Date().toISOString()
    return true
  }

  /** List bindings, optionally filtered by provider. */
  async listBindings(providerId?: AdapterProviderId): Promise<AdapterMcpBinding[]> {
    const all = [...this.bindings.values()]
    if (providerId) {
      return all.filter(b => b.providerId === providerId)
    }
    return all
  }

  // ---------------------------------------------------------------------------
  // Effective Config Resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve the effective MCP configuration for a provider.
   * Only includes servers that are enabled AND have an enabled binding to this provider.
   */
  async getEffectiveConfig(providerId: AdapterProviderId): Promise<EffectiveMcpConfig> {
    const enabledBindings = [...this.bindings.values()].filter(
      b => b.providerId === providerId && b.enabled,
    )

    const servers: EffectiveMcpConfig['servers'] = []

    for (const binding of enabledBindings) {
      const server = this.servers.get(binding.serverId)
      if (server && server.enabled) {
        servers.push({ server, binding })
      }
    }

    return { servers }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getBindingsForServer(serverId: string): AdapterMcpBinding[] {
    return [...this.bindings.values()].filter(b => b.serverId === serverId)
  }
}

